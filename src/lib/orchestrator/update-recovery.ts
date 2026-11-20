import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PROJECT_LABEL, dockerProjectName } from "./naming";
import { volumePlan } from "./volumes";
import { asProjectId, type CommandRunner } from "./types";

const phaseSchema = z.enum(["prepared", "snapshotting", "backed-up", "switching", "restoring", "restored", "committed"]);
const manifestSchema = z.object({
  version: z.literal(1),
  projectId: z.uuid(),
  jobId: z.uuid(),
  previousRelease: z.string().regex(/^self-hosted\/v\d+\.\d+\.\d+$/),
  targetRelease: z.string().regex(/^self-hosted\/v\d+\.\d+\.\d+$/),
  phase: phaseSchema,
  createdAt: z.string(),
  volumes: z.array(z.object({ name: z.string(), file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive() })),
});
export type RecoveryManifest = z.infer<typeof manifestSchema>;

/** A journal is written before every operation that can change the running stack. */
export async function writeRecoveryManifest(directory: string, manifest: RecoveryManifest): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `manifest-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(manifestSchema.parse(manifest), null, 2));
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, path.join(directory, "manifest.json"));
  // Persist the rename as well as the file contents on Linux hosts.
  if (process.platform !== "win32") {
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
}

export async function readRecoveryManifest(directory: string, projectId: string, jobId: string): Promise<RecoveryManifest | undefined> {
  let source: string;
  try { source = await readFile(path.join(directory, "manifest.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const manifest = manifestSchema.parse(JSON.parse(source));
  if (manifest.projectId !== projectId || manifest.jobId !== jobId) throw new Error("Recovery point identity does not match this update");
  const planned = new Set(volumePlan(asProjectId(projectId), manifest.previousRelease).map((volume) => volume.name));
  const names = new Set<string>();
  for (const volume of manifest.volumes) {
    if (!planned.has(volume.name) || names.has(volume.name) || volume.file !== `${volume.name}.tar`) {
      throw new Error("Recovery point contains an unexpected volume or archive path");
    }
    names.add(volume.name);
  }
  if ((["backed-up", "switching", "restoring", "committed"].includes(manifest.phase) || (manifest.phase === "restored" && names.size > 0)) && names.size !== planned.size) {
    throw new Error("Recovery point is incomplete");
  }
  return manifest;
}

async function checked(runner: CommandRunner, args: readonly string[], timeoutMs = 15 * 60_000): Promise<string> {
  const result = await runner.run({ executable: "docker", args, timeoutMs });
  // Do not put arbitrary Docker output (which may contain environment values) into diagnostics.
  if (result.exitCode !== 0) throw new Error(`Recovery Docker operation ${args[0]} failed (${result.exitCode})`);
  return result.stdout;
}

export async function archiveDigest(file: string): Promise<{ sha256: string; bytes: number }> {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size < 1024) throw new Error("Recovery archive is empty or invalid");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { sha256: hash.digest("hex"), bytes: metadata.size };
}

/** Rejects nonstandard mounts/backends rather than claiming to back up data we do not own. */
export function assertRecoverableLayout(rendered: string, projectId: string, release: string): void {
  const compose = JSON.parse(rendered) as { services: Record<string, { environment?: Record<string, string>; volumes?: { type: string; source: string; read_only?: boolean }[] }> };
  const backend = compose.services.storage?.environment?.STORAGE_BACKEND;
  if (backend !== "file") throw new Error("Automatic recovery requires file-backed Storage; external S3 needs a coordinated operator backup");
  const names = new Set(volumePlan(asProjectId(projectId), release).map((volume) => volume.name));
  for (const service of Object.values(compose.services)) {
    for (const mount of service.volumes ?? []) {
      if (mount.type !== "volume" || !names.has(mount.source)) {
        throw new Error("Automatic recovery cannot cover an unrecognized project mount");
      }
    }
  }
}

/** All running users of each volume must be stopped, including containers outside this project. */
async function assertVolumesIdle(runner: CommandRunner, names: readonly string[]): Promise<void> {
  for (const name of names) {
    if ((await checked(runner, ["ps", "--filter", `volume=${name}`, "--format", "{{.ID}}"])).trim()) {
      throw new Error("A project volume is still in use; the recovery operation was not started");
    }
  }
}

async function assertOwnedVolumes(runner: CommandRunner, projectId: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const label = (await checked(runner, ["volume", "inspect", "--format", `{{index .Labels "${PROJECT_LABEL}"}}`, name])).trim();
    if (label !== projectId) throw new Error("Recovery volume ownership could not be verified");
  }
}

/** Stop the exact managed containers and verify that no process can write the snapshot volumes. */
export async function stopProjectForRecovery(runner: CommandRunner, projectId: string): Promise<void> {
  asProjectId(projectId);
  // A broker crash can leave a snapshot/restore helper running against a volume.
  // Terminate only this project's explicitly labelled, generated recovery helpers.
  const helpers = (await checked(runner, ["ps", "-a", "--filter", `label=com.supabase-manager.recovery-project=${projectId}`, "--format", "{{.Names}}"])).trim().split(/\s+/).filter(Boolean);
  if (helpers.some((name) => !/^sm_(recovery|health)_[a-f0-9]{32}$/.test(name))) throw new Error("Recovery helper identity could not be verified");
  if (helpers.length) await checked(runner, ["rm", "--force", ...helpers]);
  const ids = (await checked(runner, ["ps", "--filter", `label=${PROJECT_LABEL}=${projectId}`, "--format", "{{.ID}}"])).trim().split(/\s+/).filter(Boolean);
  if (!ids.length) return;
  const containers = JSON.parse(await checked(runner, ["inspect", ...ids])) as { Id: string; Config: { Labels: Record<string, string> } }[];
  const groups: string[][] = [[], [], []];
  for (const container of containers) {
    const labels = container.Config.Labels;
    const service = labels["com.docker.compose.service"];
    if (labels[PROJECT_LABEL] !== projectId || labels["com.docker.compose.project"] !== dockerProjectName(asProjectId(projectId)) || !/^[a-zA-Z0-9_-]+$/.test(service) || !/^[a-f0-9]{64}$/.test(container.Id)) {
      throw new Error("Container identity does not match the project recovery point");
    }
    const group = ["api-gw", "kong", "supavisor"].includes(service) ? 0 : service === "db" ? 2 : 1;
    groups[group].push(container.Id);
  }
  // Close ingress first, let application writers finish next, and shut down
  // PostgreSQL last. docker stop with multiple IDs alone stops them in parallel.
  for (const group of groups) if (group.length) await checked(runner, ["stop", "--time", "90", ...group]);
}

async function withVolumeHelper<T>(runner: CommandRunner, projectId: string, volume: string, readOnly: boolean, action: (helper: string) => Promise<T>): Promise<T> {
  const helper = `sm_recovery_${randomUUID().replaceAll("-", "")}`;
  try {
    await checked(runner, ["create", "--name", helper, "--network", "none", "--label", `com.supabase-manager.recovery-project=${projectId}`,
      "--mount", `type=volume,source=${volume},target=/target${readOnly ? ",readonly" : ""}`,
      "alpine:3.23", "sh", "-ec", readOnly
        ? "tar -cpf /snapshot.tar -C /target . && tar -tf /snapshot.tar >/dev/null"
        : "tar -tf /snapshot.tar >/dev/null; find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xpf /snapshot.tar -C /target; sync"]);
    return await action(helper);
  } finally {
    await runner.run({ executable: "docker", args: ["rm", "--force", helper], timeoutMs: 60_000 });
  }
}

export async function createVolumeRecoveryPoint(runner: CommandRunner, directory: string, manifest: RecoveryManifest, progress: (message: string) => void): Promise<RecoveryManifest> {
  const volumes = volumePlan(asProjectId(manifest.projectId), manifest.previousRelease);
  await assertOwnedVolumes(runner, manifest.projectId, volumes.map((volume) => volume.name));
  await assertVolumesIdle(runner, volumes.map((volume) => volume.name));
  const snapshots: RecoveryManifest["volumes"] = [];
  for (const volume of volumes) {
    progress(`Backing up ${volume.purpose} (${snapshots.length + 1}/${volumes.length})`);
    const file = `${volume.name}.tar`;
    const destination = path.join(directory, file);
    await withVolumeHelper(runner, manifest.projectId, volume.name, true, async (helper) => {
      await checked(runner, ["start", "--attach", helper], 60 * 60_000);
      await checked(runner, ["cp", `${helper}:/snapshot.tar`, destination], 60 * 60_000);
    });
    await chmod(destination, 0o600);
    const descriptor = await open(destination, "r");
    try { await descriptor.sync(); } finally { await descriptor.close(); }
    snapshots.push({ name: volume.name, file, ...await archiveDigest(destination) });
  }
  const result: RecoveryManifest = { ...manifest, phase: "backed-up", volumes: snapshots };
  await writeRecoveryManifest(directory, result);
  return result;
}

/** Verify EVERY archive before clearing ANY volume. Repeating a partially completed restore is safe. */
export async function restoreVolumeRecoveryPoint(runner: CommandRunner, directory: string, manifest: RecoveryManifest, progress: (message: string) => void): Promise<void> {
  const validated = await readRecoveryManifest(directory, manifest.projectId, manifest.jobId);
  if (!validated || !["switching", "restoring"].includes(validated.phase)) throw new Error("A complete recovery point is required before restoring data");
  for (const volume of validated.volumes) {
    const digest = await archiveDigest(path.join(directory, volume.file));
    if (digest.sha256 !== volume.sha256 || digest.bytes !== volume.bytes) throw new Error("Recovery archive checksum does not match; no volumes were cleared");
  }
  await assertOwnedVolumes(runner, manifest.projectId, validated.volumes.map((volume) => volume.name));
  await assertVolumesIdle(runner, validated.volumes.map((volume) => volume.name));
  for (const [index, volume] of validated.volumes.entries()) {
    progress(`Restoring volume ${index + 1}/${validated.volumes.length}`);
    await withVolumeHelper(runner, manifest.projectId, volume.name, false, async (helper) => {
      await checked(runner, ["cp", path.join(directory, volume.file), `${helper}:/snapshot.tar`], 60 * 60_000);
      await checked(runner, ["start", "--attach", helper], 60 * 60_000);
    });
  }
}

/** Pin rollback to the images actually running, even if a tag moves while updating. */
export async function pinRunningProjectImages(runner: CommandRunner, projectId: string): Promise<string> {
  const ids = (await checked(runner, ["ps", "-a", "--filter", `label=${PROJECT_LABEL}=${projectId}`, "--format", "{{.ID}}"])).trim().split(/\s+/).filter(Boolean);
  if (!ids.length) throw new Error("No managed project containers are available for recovery");
  const containers = JSON.parse(await checked(runner, ["inspect", ...ids])) as { Image: string; Config: { Labels: Record<string, string> } }[];
  const services: string[] = ["services:"];
  for (const container of containers) {
    const service = container.Config.Labels["com.docker.compose.service"];
    if (container.Config.Labels[PROJECT_LABEL] !== projectId || container.Config.Labels["com.docker.compose.project"] !== dockerProjectName(asProjectId(projectId)) || !/^[a-zA-Z0-9_-]+$/.test(service)) {
      throw new Error("Container identity does not match the project recovery point");
    }
    // Image IDs refer to locally retained immutable content and need no registry during rollback.
    if (!/^sha256:[a-f0-9]{64}$/.test(container.Image)) throw new Error("Running image identity is unavailable");
    services.push(`  ${service}:`, `    image: ${JSON.stringify(container.Image)}`, "    pull_policy: never");
  }
  return `${services.join("\n")}\n`;
}

export async function verifyRollbackImages(runner: CommandRunner, compose: string): Promise<void> {
  const ids = [...compose.matchAll(/image:\s*"(sha256:[a-f0-9]{64})"/g)].map((match) => match[1]);
  if (!ids.length) throw new Error("Recovery image identities are missing");
  await checked(runner, ["image", "inspect", ...new Set(ids)]);
}

export async function pinConfiguredProjectImages(runner: CommandRunner, rendered: string): Promise<string> {
  const config = JSON.parse(rendered) as { services: Record<string, { image?: string }> };
  const lines = ["services:"];
  for (const [service, definition] of Object.entries(config.services)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(service) || !definition.image) throw new Error("Candidate service image is missing");
    const images = JSON.parse(await checked(runner, ["image", "inspect", definition.image])) as { Id: string }[];
    const id = images[0]?.Id;
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("Candidate image identity is unavailable");
    lines.push(`  ${service}:`, `    image: ${JSON.stringify(id)}`, "    pull_policy: never");
  }
  return `${lines.join("\n")}\n`;
}

/** Keep client ports closed while new services may migrate the database. */
export function maintenanceOverride(gatewayService: string): string {
  if (!["api-gw", "kong"].includes(gatewayService)) throw new Error("Unsupported maintenance gateway");
  return `services:\n  ${gatewayService}:\n    ports: !override []\n  supavisor:\n    ports: !override []\n`;
}

