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
import { sanitizeText } from "./diagnostics";
import { DockerCliHostDriver } from "./docker-driver";
import { dockerProjectName, projectContainerName } from "./naming";
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
  if (result.exitCode !== 0) throw new Error(`${executable} failed with exit code ${result.exitCode}: ${sanitizeText(result.stderr).slice(0, 800)}`);
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
  const missingServices = adapter.services.filter((service) => !new RegExp(`^  ${service}:\\s*$`, "m").test(composeContents));
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
  if (missingServices.length > 0 || missingPaths.length > 0) {
    const details = [
      missingServices.length ? `services: ${missingServices.join(", ")}` : "",
      missingPaths.length ? `files: ${missingPaths.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    throw new Error(`Official release ${adapter.release} is not compatible with its manager adapter (${details})`);
  }
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
      envContents = patchEnv(envContents, {
        DASHBOARD_USERNAME: project.dashboardUsername,
        SUPABASE_PUBLIC_URL: trimUrl(project.publicUrl),
        API_EXTERNAL_URL: `${trimUrl(project.publicUrl)}/auth/v1`,
        SITE_URL: trimUrl(project.siteUrl),
        STUDIO_DEFAULT_PROJECT: project.name,
        STUDIO_DEFAULT_ORGANIZATION: "Managed locally",
        POOLER_TENANT_ID: project.id.replaceAll("-", ""),
      });
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
    await driver.compose({ ...compose, args: ["config", "--quiet"] });

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
    const loopback = `http://127.0.0.1:${project.ports.api}`;
    await checkHttpEndpoint(`${loopback}/auth/v1/health`);
    await checkHttpEndpoint(`${loopback}/rest/v1/`, { apikey: credentialBundle.ANON_KEY, Authorization: `Bearer ${credentialBundle.ANON_KEY}` });
    await checkHttpEndpoint(`${loopback}/storage/v1/status`);

    repository.activateProjectPorts(project.id);
    repository.updateProjectStatus(project.id, "ready");
    repository.updateJobState(job.id, { status: "succeeded", stage: "ready" });
    repository.appendJobEvent({ jobId: job.id, stage: "ready", level: "info", message: "Project is ready and passed functional checks" });
  } catch (error) {
    const raw = error instanceof Error ? error.message : "Unknown provisioning failure";
    const message = sanitizeText(raw, secrets).slice(0, 1000);
    repository.updateProjectStatus(project.id, "failed");
    repository.releaseProjectPorts(project.id);
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
