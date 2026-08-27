import { createHmac, randomUUID } from "node:crypto";
import { access, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/config";
import { getRepository } from "@/lib/db/manager";
import type { DeploymentStage, JobId, ProjectId as DomainProjectId } from "@/lib/domain";
import { decryptJson, encryptJson, getMasterKey, type EncryptedEnvelope } from "@/lib/security/encryption";
import { adapterForRelease } from "./adapters";
import { DirectCommandRunner } from "./command-runner";
import { generateComposeOverride } from "./compose";
import { boundedDiagnosticText, sanitizeText } from "./diagnostics";
import { DockerCliHostDriver } from "./docker-driver";
import { dockerProjectName, PROJECT_LABEL, projectContainerName } from "./naming";
import { asProjectId, type CommandRunner } from "./types";
import { ensureProjectVolumes, type PlannedVolume, type VolumePurpose } from "./volumes";

type CustomCredentials = {
  postgresPassword: string;
  dashboardPassword: string;
  jwtSecret: string;
};

type ProjectCredentials = Record<string, string>;

const globalBroker = globalThis as typeof globalThis & { __supabaseManagerActiveJobs?: Map<string, Promise<void>> };
const activeJobs = globalBroker.__supabaseManagerActiveJobs ??= new Map<string, Promise<void>>();
const REQUIRED_ENV_KEYS = [
  "POSTGRES_PASSWORD",
  "JWT_SECRET",
  "ANON_KEY",
  "SERVICE_ROLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "DASHBOARD_USERNAME",
  "DASHBOARD_PASSWORD",
] as const;

const OPTIONAL_CREDENTIAL_ENV_KEYS = [
  "S3_PROTOCOL_ACCESS_KEY_ID",
  "S3_PROTOCOL_ACCESS_KEY_SECRET",
] as const;

function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

function safeReleasePath(release: string): string {
  if (!/^self-hosted\/v\d+\.\d+\.\d+$/.test(release)) throw new Error("unsupported release reference");
  return release.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function trimUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function projectPublicEnvironment(project: {
  readonly id: string;
  readonly name: string;
  readonly publicUrl: string;
  readonly siteUrl: string;
  readonly dashboardUsername: string;
}): Record<string, string> {
  return {
    DASHBOARD_USERNAME: project.dashboardUsername,
    SUPABASE_PUBLIC_URL: trimUrl(project.publicUrl),
    // GoTrue appends its own /auth/v1 routes. The official stack expects the
    // externally reachable gateway root here, not the Auth endpoint.
    API_EXTERNAL_URL: trimUrl(project.publicUrl),
    SITE_URL: trimUrl(project.siteUrl),
    STUDIO_DEFAULT_PROJECT: project.name,
    STUDIO_DEFAULT_ORGANIZATION: "Managed locally",
    POOLER_TENANT_ID: project.id.replaceAll("-", ""),
  };
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => value.replace(/^v/, "").split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const left = parse(actual);
  const right = parse(minimum);
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return false;
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false;
  }
  return true;
}

export function officialUpdatePreviewBlocker(output: string): "manual-migration" | "merge-conflict" | null {
  if (/\bBREAKING\b|\bgate:/i.test(output)) return "manual-migration";
  if (/CONFLICTS:\s*[1-9]\d*|merge failures:\s*[1-9]\d*/i.test(output)) return "merge-conflict";
  return null;
}

function parseEnv(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

export function patchEnv(contents: string, updates: Readonly<Record<string, string>>): string {
  const pending = new Map(Object.entries(updates));
  const lines = contents.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1])!;
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function legacyJwt(secret: string, role: "anon" | "service_role", issuedAt = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ role, iss: "supabase", iat: issuedAt, exp: issuedAt + 5 * 3600 * 24 * 365 }));
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${createHmac("sha256", secret).update(signingInput).digest("base64url")}`;
}

async function runChecked(runner: CommandRunner, executable: string, args: readonly string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<void> {
  const result = await runner.run({ executable, args, cwd: options.cwd, timeoutMs: options.timeoutMs ?? 10 * 60_000 });
  if (result.exitCode !== 0) throw new Error(`${executable} failed with exit code ${result.exitCode}: ${boundedDiagnosticText(sanitizeText(result.stderr))}`);
}

async function prepareOfficialRelease(runner: CommandRunner, release: string, releaseCacheDir: string): Promise<string> {
  const cachePath = path.join(releaseCacheDir, safeReleasePath(release));
  const dockerDir = path.join(cachePath, "docker");
  if (await exists(path.join(dockerDir, "docker-compose.yml"))) return dockerDir;

  await mkdir(releaseCacheDir, { recursive: true, mode: 0o700 });
  // Only an incomplete manager-owned cache entry is removed. Complete release
  // directories are immutable and shared safely by every project on the host.
  await rm(cachePath, { recursive: true, force: true });
  const temporary = `${cachePath}.${randomUUID()}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  try {
    await runChecked(runner, "git", ["clone", "--filter=blob:none", "--sparse", "--branch", release, "--depth", "1", "https://github.com/supabase/supabase.git", temporary]);
    await runChecked(runner, "git", ["-C", temporary, "sparse-checkout", "set", "docker"]);
    await rename(temporary, cachePath).catch(async (error) => {
      if (!(await exists(path.join(dockerDir, "docker-compose.yml")))) throw error;
      await rm(temporary, { recursive: true, force: true });
    });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return dockerDir;
}

async function validateOfficialReleaseLayout(dockerDir: string, adapter: ReturnType<typeof adapterForRelease>): Promise<void> {
  const composeContents = await readFile(path.join(dockerDir, "docker-compose.yml"), "utf8");
  const declaredServices: string[] = [];
  let inServices = false;
  for (const line of composeContents.split(/\r?\n/)) {
    if (line.trim() === "services:" && !line.startsWith(" ")) {
      inServices = true;
      continue;
    }
    if (inServices && line && !line.startsWith(" ") && !line.startsWith("#")) break;
    const service = inServices ? line.match(/^  ([a-zA-Z0-9_-]+):\s*$/)?.[1] : undefined;
    if (service) declaredServices.push(service);
  }
  const missingServices = adapter.services.filter((service) => !declaredServices.includes(service));
  const unexpectedServices = declaredServices.filter((service) => !adapter.services.includes(service));
  const requiredPaths = [
    ".env.example",
    "utils/generate-keys.sh",
    "utils/add-new-auth-keys.sh",
    ...(adapter.gatewayService === "api-gw"
      ? ["volumes/api/envoy"]
      : ["volumes/api/kong.yml", "volumes/api/kong-entrypoint.sh"]),
    "volumes/pooler",
    "volumes/functions",
    "volumes/snippets",
    "volumes/db/roles.sql",
    "volumes/db/jwt.sql",
  ];
  const missingPaths = (await Promise.all(requiredPaths.map(async (relativePath) =>
    await exists(path.join(dockerDir, relativePath)) ? null : relativePath))).filter(Boolean);
  if (missingServices.length > 0 || unexpectedServices.length > 0 || missingPaths.length > 0) {
    const details = [
      missingServices.length ? `services: ${missingServices.join(", ")}` : "",
      unexpectedServices.length ? `unmanaged services: ${unexpectedServices.join(", ")}` : "",
      missingPaths.length ? `files: ${missingPaths.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    throw new Error(`Official release ${adapter.release} is not compatible with its manager adapter (${details})`);
  }
}

function assertNoBindMounts(renderedCompose: string): void {
  const parsed = JSON.parse(renderedCompose) as {
    services?: Record<string, { volumes?: Array<{ type?: string; source?: string; target?: string }> }>;
  };
  const binds = Object.entries(parsed.services ?? {}).flatMap(([service, definition]) =>
    (definition.volumes ?? []).flatMap((volume) => volume.type === "bind"
      ? [`${service}:${volume.source ?? "bind"}->${volume.target ?? "unknown"}`]
      : []));
  if (binds.length > 0) throw new Error(`official release contains bind mounts not covered by the manager adapter (${binds.join(", ")})`);
}

async function loadEncryptedCredential<T>(projectId: DomainProjectId, name: string): Promise<T | undefined> {
  const stored = getRepository().getCredential(projectId, name);
  if (!stored) return undefined;
  const envelope: EncryptedEnvelope = {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: stored.nonceBase64,
    tag: stored.authTagBase64,
    ciphertext: stored.ciphertextBase64,
  };
  return decryptJson<T>(envelope, await getMasterKey(), stored.associatedData);
}

async function seedVolume(runner: CommandRunner, volume: PlannedVolume, source: string): Promise<void> {
  if (!(await exists(source))) throw new Error(`required upstream configuration is missing for ${volume.purpose}`);
  const helper = `sm_seed_${randomUUID().replaceAll("-", "")}`;
  try {
    await runChecked(runner, "docker", ["create", "--name", helper, "--mount", `type=volume,source=${volume.name},target=/target`, "alpine:3.23", "sh", "-c", "chmod -R a+rX /target && find /target -name '*.sh' -exec chmod a+x {} +"]);
    await runChecked(runner, "docker", ["cp", `${source}${path.sep}.`, `${helper}:/target`]);
    await runChecked(runner, "docker", ["start", "--attach", helper]);
  } finally {
    await runner.run({ executable: "docker", args: ["rm", "--force", helper], timeoutMs: 60_000 });
  }
}

async function buildDbInitTree(upstream: string, target: string): Promise<void> {
  const db = path.join(upstream, "volumes", "db");
  await mkdir(path.join(target, "migrations"), { recursive: true });
  await mkdir(path.join(target, "init-scripts"), { recursive: true });
  const files: readonly [string, string][] = [
    ["realtime.sql", "migrations/99-realtime.sql"],
    ["_supabase.sql", "migrations/97-_supabase.sql"],
    ["logs.sql", "migrations/99-logs.sql"],
    ["pooler.sql", "migrations/99-pooler.sql"],
    ["webhooks.sql", "init-scripts/98-webhooks.sql"],
    ["roles.sql", "init-scripts/99-roles.sql"],
    ["jwt.sql", "init-scripts/99-jwt.sql"],
  ];
  for (const [source, destination] of files) {
    // Both roots are manager-controlled runtime directories under /data. They
    // must not be traced into the standalone Next build.
    await copyFile(
      path.join(/* turbopackIgnore: true */ db, source),
      path.join(/* turbopackIgnore: true */ target, destination),
    );
  }
}

async function seedConfigurationVolumes(runner: CommandRunner, volumes: readonly PlannedVolume[], upstream: string, projectDir: string, adapter: ReturnType<typeof adapterForRelease>): Promise<void> {
  const seedRoot = path.join(projectDir, "seed");
  await rm(seedRoot, { recursive: true, force: true });
  await mkdir(seedRoot, { recursive: true, mode: 0o700 });
  const sources = new Map<VolumePurpose, string>();
  const dbInit = path.join(seedRoot, "db_init");
  await buildDbInitTree(upstream, dbInit);
  sources.set("db_init", dbInit);
  if (adapter.gatewayService === "api-gw") {
    sources.set("envoy", path.join(upstream, "volumes", "api", "envoy"));
  } else {
    const gateway = path.join(seedRoot, "gateway");
    await mkdir(gateway, { recursive: true });
    await copyFile(path.join(upstream, "volumes", "api", "kong.yml"), path.join(gateway, "temp.yml"));
    await copyFile(path.join(upstream, "volumes", "api", "kong-entrypoint.sh"), path.join(gateway, "kong-entrypoint.sh"));
    sources.set("envoy", gateway);
  }
  sources.set("pooler", path.join(upstream, "volumes", "pooler"));
  sources.set("functions", path.join(upstream, "volumes", "functions"));
  sources.set("snippets", path.join(upstream, "volumes", "snippets"));
  for (const volume of volumes) {
    const source = sources.get(volume.purpose);
    if (source) await seedVolume(runner, volume, source);
  }
}

async function waitForContainers(runner: CommandRunner, names: readonly string[], timeoutMs = 6 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "containers have not reported status";
  while (Date.now() < deadline) {
    const states: string[] = [];
    let ready = true;
    for (const name of names) {
      const result = await runner.run({ executable: "docker", args: ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", name], timeoutMs: 30_000 });
      const state = result.exitCode === 0 ? result.stdout.trim() : "missing";
      states.push(`${name}=${state}`);
      if (state !== "healthy" && state !== "running") ready = false;
      if (state === "unhealthy" || state === "exited" || state === "dead") throw new Error(`container ${name} reported ${state}`);
    }
    if (ready) return;
    last = states.join(", ");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`container readiness timed out: ${last}`);
}

async function checkHttpEndpoint(url: string, headers?: Record<string, string>): Promise<void> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
      lastStatus = response.status;
      if (response.ok) return;
    } catch {
      // Service may still be warming up.
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`functional endpoint check failed (${lastStatus || "connection refused"})`);
}

function encryptedEnvelopeFor(value: unknown, associatedData: string, key: Buffer) {
  const envelope = encryptJson(value, key, associatedData);
  return { ciphertextBase64: envelope.ciphertext, nonceBase64: envelope.iv, authTagBase64: envelope.tag, associatedData };
}

export async function runProvisioningJob(jobId: JobId): Promise<void> {
  const repository = getRepository();
  const job = repository.getJob(jobId);
  if (!job || !job.projectId || job.type !== "create-project") return;
  if (job.status === "succeeded" || job.status === "cancelled") return;
  const project = repository.getProject(job.projectId);
  if (!project) return;

  const runner = new DirectCommandRunner();
  const driver = new DockerCliHostDriver(runner);
  const config = getConfig();
  const orchestrationProjectId = asProjectId(project.id);
  const adapter = adapterForRelease(project.stackRelease);
  const projectDir = path.join(config.dataDir, "projects", project.id);
  const envPath = path.join(projectDir, ".env");
  const overridePath = path.join(projectDir, "manager.override.yml");
  let secrets: string[] = [];

  const stage = (next: DeploymentStage, message: string) => {
    repository.updateJobState(job.id, { status: "running", stage: next });
    repository.appendJobEvent({ jobId: job.id, stage: next, level: "info", message });
  };

  try {
    stage("validating", "Validated project configuration and official release adapter");
    const dockerVersion = await runner.run({ executable: "docker", args: ["version", "--format", "{{.Server.Version}}"], timeoutMs: 30_000 });
    if (dockerVersion.exitCode !== 0) throw new Error("Docker Engine is unavailable through the configured socket");
    const composeVersion = await runner.run({ executable: "docker", args: ["compose", "version", "--short"], timeoutMs: 30_000 });
    if (composeVersion.exitCode !== 0 || !versionAtLeast(composeVersion.stdout.trim(), adapter.requiredComposeVersion)) {
      throw new Error(`Docker Compose ${adapter.requiredComposeVersion} or newer is required`);
    }
    stage("reserving-ports", "Confirmed the API and database ports are reserved for this project");

    stage("preparing-release", `Preparing official Supabase ${project.stackRelease}`);
    const upstream = await prepareOfficialRelease(runner, project.stackRelease, config.releaseCacheDir);
    await validateOfficialReleaseLayout(upstream, adapter);
    await mkdir(projectDir, { recursive: true, mode: 0o700 });
    const helperUpdatedCompose = path.join(projectDir, "docker-compose.yml");
    const credentialsReady = Boolean(repository.getCredential(project.id, "project-credentials"))
      && Boolean(repository.getCredential(project.id, "project-environment"))
      && await exists(helperUpdatedCompose);

    stage("generating-credentials", credentialsReady
      ? "Reusing the encrypted credential bundle created by the previous attempt"
      : "Generating a version-compatible Supabase credential bundle");
    if (credentialsReady) {
      const restoredEnvironment = await loadEncryptedCredential<string>(project.id, "project-environment");
      if (!restoredEnvironment) throw new Error("encrypted project environment is missing");
      await writeFile(envPath, restoredEnvironment, { mode: 0o600 });
    } else {
      await copyFile(path.join(upstream, ".env.example"), envPath);
      await cp(path.join(upstream, "utils"), path.join(projectDir, "utils"), { recursive: true, force: true });
      await copyFile(path.join(upstream, "docker-compose.yml"), helperUpdatedCompose);
      await runChecked(runner, "sh", ["utils/generate-keys.sh", "--update-env"], { cwd: projectDir });
      let envContents = await readFile(envPath, "utf8");
      const custom = await loadEncryptedCredential<CustomCredentials>(project.id, "provisioning-input");
      if (custom) {
        const issuedAt = Math.floor(Date.now() / 1000);
        envContents = patchEnv(envContents, {
          POSTGRES_PASSWORD: custom.postgresPassword,
          DASHBOARD_PASSWORD: custom.dashboardPassword,
          JWT_SECRET: custom.jwtSecret,
          ANON_KEY: legacyJwt(custom.jwtSecret, "anon", issuedAt),
          SERVICE_ROLE_KEY: legacyJwt(custom.jwtSecret, "service_role", issuedAt),
        });
      }
      envContents = patchEnv(envContents, projectPublicEnvironment(project));
      await writeFile(envPath, envContents, { mode: 0o600 });
      // This official helper derives ES256/JWKS and opaque API keys from the
      // selected JWT secret and updates the per-project Compose copy.
      await runChecked(runner, "sh", ["utils/add-new-auth-keys.sh", "--update-env"], { cwd: projectDir });
    }

    const finalEnvironment = await readFile(envPath, "utf8");
    const env = parseEnv(finalEnvironment);
    const credentialBundle: ProjectCredentials = {};
    for (const key of REQUIRED_ENV_KEYS) {
      const value = env.get(key);
      if (!value) throw new Error(`official credential generator did not populate ${key}`);
      credentialBundle[key] = value;
    }
    for (const key of OPTIONAL_CREDENTIAL_ENV_KEYS) {
      const value = env.get(key);
      if (value) credentialBundle[key] = value;
    }
    secrets = Object.values(credentialBundle);
    if (!credentialsReady) {
      const masterKey = await getMasterKey();
      const associatedData = `${project.id}:project-credentials`;
      repository.upsertCredential({ projectId: project.id, kind: "other", name: "project-credentials", ...encryptedEnvelopeFor(credentialBundle, associatedData, masterKey) });
      const environmentAssociatedData = `${project.id}:project-environment`;
      repository.upsertCredential({ projectId: project.id, kind: "other", name: "project-environment", ...encryptedEnvelopeFor(finalEnvironment, environmentAssociatedData, masterKey) });
      repository.deleteCredential(project.id, "provisioning-input");
    }

    stage("creating-volumes", "Creating isolated project volumes and Docker labels");
    const volumes = await ensureProjectVolumes(driver, { projectId: orchestrationProjectId, organizationId: project.organizationId, release: project.stackRelease });
    for (const volume of volumes) repository.recordVolume({
      projectId: project.id,
      dockerName: volume.name,
      kind: volume.purpose === "deno_cache" ? "cache" : volume.persistent ? "persistent" : "configuration",
      purpose: volume.purpose,
      stackRelease: project.stackRelease,
    });

    await writeFile(overridePath, generateComposeOverride({
      projectId: orchestrationProjectId,
      release: project.stackRelease,
      ports: project.ports,
      volumes,
      mounts: adapter.mounts,
      services: adapter.services,
      gatewayService: adapter.gatewayService,
      realtimeService: adapter.realtimeService,
      gatewayEntrypoint: adapter.gatewayEntrypoint,
    }), { mode: 0o600 });

    const compose = { files: [helperUpdatedCompose, overridePath], envFile: envPath, projectName: dockerProjectName(orchestrationProjectId) } as const;
    const renderedCompose = await driver.compose({ ...compose, args: ["config", "--format", "json"] });
    assertNoBindMounts(renderedCompose.stdout);

    stage("initializing-configuration", "Initializing image-provided database files, then overlaying the official release configuration into named volumes");
    // Creating the stopped official db container first lets Docker copy the
    // Postgres image's built-in init scripts and configuration into otherwise
    // empty named volumes. The release SQL files are overlaid afterwards. This
    // preserves everything that individual upstream bind mounts do not hide.
    await driver.compose({ ...compose, args: ["pull", "db"] });
    await driver.compose({ ...compose, args: ["create", "db"] });
    await seedConfigurationVolumes(runner, volumes, upstream, projectDir, adapter);

    stage("pulling-images", "Pulling image versions pinned by the official Supabase release");
    await driver.compose({ ...compose, args: ["pull"] });

    stage("starting-database", "Starting Postgres 17 and applying official roles and schemas");
    await driver.compose({ ...compose, args: ["up", "--detach", "db"] });
    const dbContainer = projectContainerName(orchestrationProjectId, "db");
    await waitForContainers(runner, [dbContainer]);

    stage("starting-services", `Starting Auth, REST, Storage, Realtime, Studio, ${adapter.gatewayService === "api-gw" ? "Envoy" : "Kong"}, and Supavisor`);
    await driver.compose({ ...compose, args: ["up", "--detach"] });
    await waitForContainers(runner, adapter.services.map((service) => service === adapter.realtimeService
      ? `realtime-dev.${dockerProjectName(orchestrationProjectId)}_realtime`
      : projectContainerName(orchestrationProjectId, service)));

    stage("functional-checks", "Checking database roles, schemas, Auth, REST, and Storage");
    const databaseCheck = await runner.run({ executable: "docker", args: ["exec", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-tAc",
      "SELECT (to_regrole('anon') IS NOT NULL AND to_regrole('authenticated') IS NOT NULL AND to_regrole('service_role') IS NOT NULL AND to_regnamespace('auth') IS NOT NULL AND to_regnamespace('storage') IS NOT NULL AND to_regnamespace('_realtime') IS NOT NULL);"], timeoutMs: 30_000 });
    if (databaseCheck.exitCode !== 0 || databaseCheck.stdout.trim() !== "t") throw new Error("required Supabase database roles or schemas are missing");
    const projectApi = `http://${getConfig().projectHost}:${project.ports.api}`;
    const anonHeaders = { apikey: credentialBundle.ANON_KEY, Authorization: `Bearer ${credentialBundle.ANON_KEY}` };
    const serviceHeaders = { apikey: credentialBundle.SERVICE_ROLE_KEY, Authorization: `Bearer ${credentialBundle.SERVICE_ROLE_KEY}` };
    await checkHttpEndpoint(`${projectApi}/auth/v1/health`, anonHeaders);
    await checkHttpEndpoint(`${projectApi}/rest/v1/`, serviceHeaders);
    await checkHttpEndpoint(`${projectApi}/storage/v1/status`);

    repository.activateProjectPorts(project.id);
    repository.updateProjectStatus(project.id, "ready");
    repository.updateJobState(job.id, { status: "succeeded", stage: "ready" });
    repository.appendJobEvent({ jobId: job.id, stage: "ready", level: "info", message: "Project is ready and passed functional checks" });
  } catch (error) {
    const raw = error instanceof Error ? error.message : "Unknown provisioning failure";
    const message = boundedDiagnosticText(sanitizeText(raw, secrets));
    repository.updateProjectStatus(project.id, "failed");
    // A failed Compose run may still leave created/running containers behind.
    // Keep their held ports active so another project cannot be assigned the
    // same host bindings. If Docker cannot be inspected, preserving the ports
    // is the safer outcome.
    let hasProjectContainers = true;
    try {
      hasProjectContainers = (await driver.listContainers({ "com.supabase-manager.project-id": project.id })).length > 0;
    } catch {
      // Docker failure is already represented by the provisioning error.
    }
    if (hasProjectContainers) repository.activateProjectPorts(project.id);
    else repository.releaseProjectPorts(project.id);
    repository.updateJobState(job.id, { status: "failed", errorCode: "PROVISIONING_FAILED", errorMessage: message });
    repository.appendJobEvent({ jobId: job.id, stage: repository.getJob(job.id)?.stage, level: "error", message });
  } finally {
    await rm(envPath, { force: true }).catch(() => undefined);
    await rm(`${envPath}.old`, { force: true }).catch(() => undefined);
  }
}

export function scheduleProvisioning(jobId: JobId): void {
  if (activeJobs.has(jobId)) return;
  const promise = Promise.resolve()
    .then(() => runProvisioningJob(jobId))
    .finally(() => activeJobs.delete(jobId));
  activeJobs.set(jobId, promise);
}

function postgresMajor(composeContents: string): number | null {
  const match = composeContents.match(/image:\s*supabase\/postgres:(\d+)(?:\.|-)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function credentialsFromEnvironment(environment: string): ProjectCredentials {
  const env = parseEnv(environment);
  const credentials: ProjectCredentials = {};
  for (const key of REQUIRED_ENV_KEYS) {
    const value = env.get(key);
    if (!value) throw new Error(`updated official environment does not contain ${key}`);
    credentials[key] = value;
  }
  for (const key of OPTIONAL_CREDENTIAL_ENV_KEYS) {
    const value = env.get(key);
    if (value) credentials[key] = value;
  }
  return credentials;
}

async function saveProjectEnvironmentAndCredentials(
  projectId: DomainProjectId,
  environment: string,
): Promise<void> {
  const credentials = credentialsFromEnvironment(environment);
  const masterKey = await getMasterKey();
  const repository = getRepository();
  repository.upsertCredential({
    projectId,
    kind: "other",
    name: "project-credentials",
    ...encryptedEnvelopeFor(credentials, `${projectId}:project-credentials`, masterKey),
  });
  repository.upsertCredential({
    projectId,
    kind: "other",
    name: "project-environment",
    ...encryptedEnvelopeFor(environment, `${projectId}:project-environment`, masterKey),
  });
}

async function functionalCheckProject(
  runner: CommandRunner,
  projectId: DomainProjectId,
  apiPort: number,
  credentials: ProjectCredentials,
): Promise<void> {
  const dbContainer = projectContainerName(asProjectId(projectId), "db");
  const databaseCheck = await runner.run({
    executable: "docker",
    args: [
      "exec", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-tAc",
      "SELECT (to_regrole('anon') IS NOT NULL AND to_regrole('authenticated') IS NOT NULL AND to_regrole('service_role') IS NOT NULL AND to_regnamespace('auth') IS NOT NULL AND to_regnamespace('storage') IS NOT NULL AND to_regnamespace('_realtime') IS NOT NULL);",
    ],
    timeoutMs: 30_000,
  });
  if (databaseCheck.exitCode !== 0 || databaseCheck.stdout.trim() !== "t") {
    throw new Error("required Supabase database roles or schemas are missing after the update");
  }
  const projectApi = `http://${getConfig().projectHost}:${apiPort}`;
  const anonHeaders = { apikey: credentials.ANON_KEY, Authorization: `Bearer ${credentials.ANON_KEY}` };
  const serviceHeaders = { apikey: credentials.SERVICE_ROLE_KEY, Authorization: `Bearer ${credentials.SERVICE_ROLE_KEY}` };
  await checkHttpEndpoint(`${projectApi}/auth/v1/health`, anonHeaders);
  await checkHttpEndpoint(`${projectApi}/rest/v1/`, serviceHeaders);
  await checkHttpEndpoint(`${projectApi}/storage/v1/status`);
}

/**
 * Switch a manager-owned project to another pinned official self-hosted release.
 * Persistent data volumes and credentials are retained. Release-scoped config
 * volumes are rebuilt from the target tag. A failed switch is rolled back to
 * the prior Compose configuration before the job is marked failed.
 */
export async function runUpdateJob(jobId: JobId): Promise<void> {
  const repository = getRepository();
  const job = repository.getJob(jobId);
  if (!job?.projectId || job.type !== "update-project") return;
  if (job.status === "succeeded" || job.status === "cancelled") return;
  const project = repository.getProject(job.projectId);
  if (!project) return;
  const targetRelease = repository.listJobEvents(job.id)
    .map((event) => event.details.targetRelease)
    .find((value): value is string => typeof value === "string");
  if (!targetRelease) throw new Error("update job target release is unavailable");

  const runner = new DirectCommandRunner();
  const driver = new DockerCliHostDriver(runner);
  const config = getConfig();
  const projectId = asProjectId(project.id);
  const projectDir = path.join(config.dataDir, "projects", project.id);
  const currentComposePath = path.join(projectDir, "docker-compose.yml");
  const currentOverridePath = path.join(projectDir, "manager.override.yml");
  const vendorDir = path.join(projectDir, "vendor");
  const previousVendorDir = path.join(projectDir, "vendor.previous");
  const updateDir = path.join(projectDir, `update-${job.id}`);
  const rollbackDir = path.join(projectDir, `rollback-${job.id}`);
  const candidateComposePath = path.join(updateDir, "docker-compose.yml");
  const candidateOverridePath = path.join(updateDir, "manager.override.yml");
  const candidateEnvPath = path.join(updateDir, ".env");
  const rollbackComposePath = path.join(rollbackDir, "docker-compose.yml");
  const rollbackOverridePath = path.join(rollbackDir, "manager.override.yml");
  const rollbackEnvPath = path.join(rollbackDir, ".env");
  let secrets: string[] = [];
  let attemptedSwitch = false;
  let previousEnvironment: string | undefined;

  const stage = (next: DeploymentStage, message: string) => {
    repository.updateJobState(job.id, { status: "running", stage: next });
    repository.appendJobEvent({ jobId: job.id, stage: next, level: "info", message });
  };

  try {
    if (project.ownership !== "manager-owned") throw new Error("externally managed projects cannot be updated by the broker");
    if (project.status !== "ready") throw new Error("the project must be ready before it can be updated");
    if (targetRelease === project.stackRelease) throw new Error("the project already uses the selected release");
    const adapter = adapterForRelease(targetRelease);
    stage("validating", `Validated update from ${project.stackRelease} to ${targetRelease}`);

    if (!(await exists(currentComposePath)) || !(await exists(currentOverridePath))) {
      throw new Error("manager-owned Compose configuration is unavailable");
    }
    previousEnvironment = await loadEncryptedCredential<string>(project.id, "project-environment");
    if (!previousEnvironment) throw new Error("encrypted project environment is unavailable");
    const currentCredentials = await loadEncryptedCredential<ProjectCredentials>(project.id, "project-credentials");
    if (!currentCredentials) throw new Error("encrypted project credentials are unavailable");
    secrets = Object.values(currentCredentials);

    stage("preparing-release", `Preparing official Supabase update from ${project.stackRelease} to ${targetRelease}`);
    const [baseUpstream, targetUpstream] = await Promise.all([
      prepareOfficialRelease(runner, project.stackRelease, config.releaseCacheDir),
      prepareOfficialRelease(runner, targetRelease, config.releaseCacheDir),
    ]);
    await validateOfficialReleaseLayout(targetUpstream, adapter);
    await rm(updateDir, { recursive: true, force: true });
    await rm(rollbackDir, { recursive: true, force: true });
    // Discard only the older fallback snapshot before any runtime mutation.
    // If this fails, the update stops while the active project is untouched.
    await rm(previousVendorDir, { recursive: true, force: true });
    await mkdir(rollbackDir, { recursive: true, mode: 0o700 });
    await copyFile(currentComposePath, rollbackComposePath);
    await copyFile(currentOverridePath, rollbackOverridePath);
    await writeFile(rollbackEnvPath, previousEnvironment, { mode: 0o600 });
    if (await exists(path.join(vendorDir, ".supabase-version"))) {
      await cp(vendorDir, updateDir, { recursive: true, force: true });
    } else {
      await cp(baseUpstream, updateDir, { recursive: true, force: true });
    }
    await copyFile(currentComposePath, candidateComposePath);
    await copyFile(path.join(targetUpstream, "update.sh"), path.join(updateDir, "update.sh"));
    await writeFile(path.join(updateDir, ".supabase-version"), `ref=${project.stackRelease}\n`, { mode: 0o600 });

    await writeFile(candidateEnvPath, previousEnvironment, { mode: 0o600 });

    const dryRun = await runner.run({
      executable: "sh",
      args: ["update.sh", "--dry-run", "--from", project.stackRelease, "--to", targetRelease],
      cwd: updateDir,
      timeoutMs: 15 * 60_000,
    });
    const dryRunOutput = boundedDiagnosticText(sanitizeText(`${dryRun.stdout}\n${dryRun.stderr}`, secrets));
    if (dryRun.exitCode !== 0) throw new Error(`official update preview failed (${dryRun.exitCode}): ${dryRunOutput}`);
    repository.appendJobEvent({
      jobId: job.id,
      stage: "preparing-release",
      level: "info",
      message: dryRunOutput || "Official update preview completed without conflicts",
    });
    const previewBlocker = officialUpdatePreviewBlocker(dryRunOutput);
    if (previewBlocker === "manual-migration") {
      throw new Error("The official update manifest requires a manual migration step. Review the preview log; the project was not changed.");
    }
    if (previewBlocker === "merge-conflict") {
      throw new Error("The official update preview found configuration merge conflicts. Review the preview log; the project was not changed.");
    }

    const officialUpdate = await runner.run({
      executable: "sh",
      args: ["update.sh", "--yes", "--from", project.stackRelease, "--to", targetRelease],
      cwd: updateDir,
      timeoutMs: 15 * 60_000,
    });
    const updateOutput = boundedDiagnosticText(sanitizeText(`${officialUpdate.stdout}\n${officialUpdate.stderr}`, secrets));
    if (officialUpdate.exitCode !== 0) {
      throw new Error(`official update script failed (${officialUpdate.exitCode}): ${updateOutput}`);
    }
    repository.appendJobEvent({
      jobId: job.id,
      stage: "preparing-release",
      level: "info",
      message: updateOutput || "Official update script completed",
    });
    await validateOfficialReleaseLayout(updateDir, adapter);

    const [currentCompose, candidateCompose] = await Promise.all([
      readFile(currentComposePath, "utf8"),
      readFile(candidateComposePath, "utf8"),
    ]);
    const currentPg = postgresMajor(currentCompose);
    const targetPg = postgresMajor(candidateCompose);
    if (!currentPg || !targetPg) throw new Error("the PostgreSQL image major could not be determined from the official Compose files");
    if (currentPg !== targetPg) {
      throw new Error(`PostgreSQL major upgrade ${currentPg} to ${targetPg} requires a dedicated database migration and was not started`);
    }

    const mergedEnvironment = patchEnv(
      await readFile(candidateEnvPath, "utf8"),
      projectPublicEnvironment(project),
    );
    await writeFile(candidateEnvPath, mergedEnvironment, { mode: 0o600 });

    stage("updating-configuration", "Creating release-scoped named volumes from the pinned official release");
    const volumes = await ensureProjectVolumes(driver, {
      projectId,
      organizationId: project.organizationId,
      release: targetRelease,
    });
    for (const volume of volumes) repository.recordVolume({
      projectId: project.id,
      dockerName: volume.name,
      kind: volume.purpose === "deno_cache" ? "cache" : volume.persistent ? "persistent" : "configuration",
      purpose: volume.purpose,
      stackRelease: targetRelease,
    });
    await seedConfigurationVolumes(runner, volumes.filter((volume) => volume.releaseScoped), updateDir, updateDir, adapter);
    await writeFile(candidateOverridePath, generateComposeOverride({
      projectId,
      release: targetRelease,
      ports: project.ports,
      volumes,
      mounts: adapter.mounts,
      services: adapter.services,
      gatewayService: adapter.gatewayService,
      realtimeService: adapter.realtimeService,
      gatewayEntrypoint: adapter.gatewayEntrypoint,
    }), { mode: 0o600 });
    const candidate = {
      files: [candidateComposePath, candidateOverridePath],
      envFile: candidateEnvPath,
      projectName: dockerProjectName(projectId),
    } as const;
    const renderedCandidate = await driver.compose({ ...candidate, args: ["config", "--format", "json"] });
    assertNoBindMounts(renderedCandidate.stdout);

    stage("creating-backup", "Creating a pre-update PostgreSQL logical backup");
    const backupDir = path.join(projectDir, "backups");
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const backupName = `pre-update-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`;
    const containerBackup = `/tmp/${backupName}`;
    const dbContainer = projectContainerName(projectId, "db");
    await runChecked(runner, "docker", ["exec", dbContainer, "pg_dumpall", "-U", "postgres", "--file", containerBackup], { timeoutMs: 30 * 60_000 });
    await runChecked(runner, "docker", ["cp", `${dbContainer}:${containerBackup}`, path.join(backupDir, backupName)], { timeoutMs: 30 * 60_000 });
    await runner.run({ executable: "docker", args: ["exec", dbContainer, "rm", "-f", containerBackup], timeoutMs: 60_000 });

    stage("pulling-images", "Pulling image versions pinned by the target official release");
    await driver.compose({ ...candidate, args: ["pull"] });
    stage("starting-services", "Recreating project services with the target official release");
    attemptedSwitch = true;
    await driver.compose({ ...candidate, args: ["up", "--detach", "--remove-orphans"] });
    await waitForContainers(runner, adapter.services.map((service) => service === adapter.realtimeService
      ? `realtime-dev.${dockerProjectName(projectId)}_realtime`
      : projectContainerName(projectId, service)));

    stage("functional-checks", "Checking database roles, schemas, Auth, REST, and Storage after the update");
    const updatedCredentials = credentialsFromEnvironment(mergedEnvironment);
    await functionalCheckProject(runner, project.id, project.ports.api, updatedCredentials);

    await copyFile(candidateComposePath, currentComposePath);
    await copyFile(candidateOverridePath, currentOverridePath);
    await saveProjectEnvironmentAndCredentials(project.id, mergedEnvironment);
    await rm(path.join(updateDir, ".env"), { force: true });
    await rm(path.join(updateDir, ".env.rollback"), { force: true });
    await rm(path.join(updateDir, "manager.override.yml"), { force: true });
    await rm(path.join(updateDir, "seed"), { recursive: true, force: true });
    // The official script backs up configuration including .env. Credentials
    // remain encrypted at rest in Manager, so its temporary plaintext archive
    // must not be persisted with the vendor snapshot.
    await rm(path.join(updateDir, "backups"), { recursive: true, force: true });
    if (await exists(vendorDir)) await rename(vendorDir, previousVendorDir);
    await rename(updateDir, vendorDir);
    repository.updateProjectRelease(project.id, targetRelease);
    repository.updateProjectStatus(project.id, "ready");
    repository.updateJobState(job.id, { status: "succeeded", stage: "ready" });
    repository.appendJobEvent({
      jobId: job.id,
      stage: "ready",
      level: "info",
      message: `Project update to ${targetRelease} completed and passed functional checks`,
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : "Unknown project update failure";
    let message = boundedDiagnosticText(sanitizeText(raw, secrets));
    if (attemptedSwitch) {
      try {
        stage("rolling-back", `Update failed; restoring ${project.stackRelease}`);
        const rollbackAdapter = adapterForRelease(project.stackRelease);
        const rollback = {
          files: [rollbackComposePath, rollbackOverridePath],
          envFile: rollbackEnvPath,
          projectName: dockerProjectName(projectId),
        } as const;
        await driver.compose({ ...rollback, args: ["up", "--detach", "--remove-orphans"] });
        await waitForContainers(runner, rollbackAdapter.services.map((service) => service === rollbackAdapter.realtimeService
          ? `realtime-dev.${dockerProjectName(projectId)}_realtime`
          : projectContainerName(projectId, service)));
        await copyFile(rollbackComposePath, currentComposePath);
        await copyFile(rollbackOverridePath, currentOverridePath);
        if (previousEnvironment) await saveProjectEnvironmentAndCredentials(project.id, previousEnvironment);
        repository.updateProjectRelease(project.id, project.stackRelease);
        if (await exists(previousVendorDir)) {
          await rm(vendorDir, { recursive: true, force: true });
          await rename(previousVendorDir, vendorDir);
        }
        repository.updateProjectStatus(project.id, "ready");
        message = `${message} The previous release was restored successfully.`;
      } catch (rollbackError) {
        repository.updateProjectStatus(project.id, "failed");
        message = `${message} Automatic rollback also failed: ${boundedDiagnosticText(sanitizeText(rollbackError instanceof Error ? rollbackError.message : "unknown rollback failure", secrets))}`;
      }
    }
    repository.updateJobState(job.id, { status: "failed", errorCode: "UPDATE_FAILED", errorMessage: message });
    repository.appendJobEvent({ jobId: job.id, stage: repository.getJob(job.id)?.stage, level: "error", message });
  } finally {
    await rm(candidateEnvPath, { force: true }).catch(() => undefined);
    await rm(path.join(updateDir, "backups"), { recursive: true, force: true }).catch(() => undefined);
    await rm(rollbackDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function scheduleUpdate(jobId: JobId): void {
  if (activeJobs.has(jobId)) return;
  const promise = Promise.resolve()
    .then(() => runUpdateJob(jobId))
    .finally(() => activeJobs.delete(jobId));
  activeJobs.set(jobId, promise);
}

export async function runDeletionJob(jobId: JobId): Promise<void> {
  const repository = getRepository();
  const job = repository.getJob(jobId);
  if (!job || !job.projectId || job.type !== "delete-project") return;
  if (job.status === "succeeded" || job.status === "cancelled") return;
  const project = repository.getProject(job.projectId);
  if (!project) return;

  const runner = new DirectCommandRunner();
  const driver = new DockerCliHostDriver(runner);
  const labels = { [PROJECT_LABEL]: project.id };
  const projectDir = path.join(getConfig().dataDir, "projects", project.id);
  const stage = (next: DeploymentStage, message: string) => {
    repository.updateJobState(job.id, { status: "running", stage: next });
    repository.appendJobEvent({ jobId: job.id, stage: next, level: "info", message });
  };

  try {
    if (project.ownership === "external") {
      stage("removing-configuration", "Removing the imported project from this manager");
      repository.deleteProjectCredentials(project.id);
      repository.markProjectDeleted(project.id);
      repository.updateJobState(job.id, { status: "succeeded", stage: "deleted" });
      repository.appendJobEvent({
        jobId: job.id,
        stage: "deleted",
        level: "info",
        message: "Imported project registration and encrypted credentials were removed; external containers, volumes, networks, and data were left untouched",
      });
      return;
    }

    stage("stopping-services", "Stopping the project services");
    const containers = await driver.listContainers(labels);

    stage("removing-containers", `Removing ${containers.length} manager-owned project containers`);
    for (const container of containers) await driver.removeContainer(container.id, true);

    stage("removing-volumes", "Removing manager-owned project networks and volumes");
    for (const network of await driver.listNetworks(labels)) await driver.removeNetwork(network.name);
    const discoveredVolumes = await driver.listVolumes(labels);
    const recordedVolumes = repository.listProjectVolumes(project.id).map((volume) => volume.dockerName);
    const volumeNames = [...new Set([...discoveredVolumes.map((volume) => volume.name), ...recordedVolumes])];
    for (const volumeName of volumeNames) await driver.removeVolume(volumeName, true);
    repository.markProjectVolumesMissing(project.id);

    stage("removing-configuration", "Removing encrypted credentials and manager-owned project configuration");
    repository.deleteProjectCredentials(project.id);
    repository.releaseProjectPorts(project.id);
    await rm(projectDir, { recursive: true, force: true });

    repository.markProjectDeleted(project.id);
    repository.updateJobState(job.id, { status: "succeeded", stage: "deleted" });
    repository.appendJobEvent({ jobId: job.id, stage: "deleted", level: "info", message: "Project containers, volumes, credentials, and configuration were deleted" });
  } catch (error) {
    const message = boundedDiagnosticText(sanitizeText(error instanceof Error ? error.message : "Unknown deletion failure"));
    repository.updateJobState(job.id, { status: "failed", errorCode: "DELETION_FAILED", errorMessage: message });
    repository.appendJobEvent({ jobId: job.id, stage: repository.getJob(job.id)?.stage, level: "error", message });
  }
}

export function scheduleDeletion(jobId: JobId): void {
  if (activeJobs.has(jobId)) return;
  const promise = Promise.resolve()
    .then(() => runDeletionJob(jobId))
    .finally(() => activeJobs.delete(jobId));
  activeJobs.set(jobId, promise);
}
