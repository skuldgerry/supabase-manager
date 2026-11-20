import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { archiveDigest, assertRecoverableLayout, maintenanceOverride, readRecoveryManifest, restoreVolumeRecoveryPoint, stopProjectForRecovery, writeRecoveryManifest, type RecoveryManifest } from "../../src/lib/orchestrator/update-recovery.js";
import { RecordingCommandRunner } from "../../src/lib/orchestrator/command-runner.js";
import { asProjectId } from "../../src/lib/orchestrator/types.js";
import { dockerProjectName, PROJECT_LABEL } from "../../src/lib/orchestrator/naming.js";
import { volumePlan } from "../../src/lib/orchestrator/volumes.js";

const projectId = asProjectId("11111111-1111-4111-8111-111111111111");
const jobId = "22222222-2222-4222-8222-222222222222";
const initial: RecoveryManifest = { version: 1, projectId, jobId, previousRelease: "self-hosted/v0.8.0", targetRelease: "self-hosted/v0.8.3", phase: "snapshotting", createdAt: new Date().toISOString(), volumes: [] };

test("recovery journals survive a restart and reject cross-project or incomplete state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sm-recovery-journal-"));
  try {
    await writeRecoveryManifest(dir, initial);
    assert.deepEqual(await readRecoveryManifest(dir, projectId, jobId), initial);
    await assert.rejects(readRecoveryManifest(dir, jobId, jobId), /identity/);
    await writeRecoveryManifest(dir, { ...initial, phase: "switching" });
    await assert.rejects(readRecoveryManifest(dir, projectId, jobId), /incomplete/);
    const descriptor = { name: volumePlan(projectId, initial.previousRelease)[0].name, file: "../postgres.tar", bytes: 2048, sha256: "a".repeat(64) };
    await writeRecoveryManifest(dir, { ...initial, volumes: [descriptor] });
    await assert.rejects(readRecoveryManifest(dir, projectId, jobId), /unexpected/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("corrupting the LAST archive prevents ALL destructive restore commands", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sm-recovery-corrupt-"));
  const runner = new RecordingCommandRunner();
  try {
    const volumes: RecoveryManifest["volumes"] = [];
    for (const volume of volumePlan(projectId, initial.previousRelease)) {
      const file = `${volume.name}.tar`;
      await writeFile(path.join(dir, file), Buffer.alloc(2048, 1));
      volumes.push({ name: volume.name, file, ...await archiveDigest(path.join(dir, file)) });
    }
    const manifest = { ...initial, phase: "switching" as const, volumes };
    await writeRecoveryManifest(dir, manifest);
    await writeFile(path.join(dir, volumes.at(-1)!.file), Buffer.alloc(2048, 2));
    await assert.rejects(restoreVolumeRecoveryPoint(runner, dir, manifest, () => {}), /checksum/);
    assert.equal(runner.calls.length, 0);
    assert.match(await readFile(path.join(dir, "manifest.json"), "utf8"), /switching/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("S3 and unknown mounts fail closed; the managed file backend is supported", () => {
  const data = volumePlan(projectId, initial.previousRelease).find((volume) => volume.purpose === "storage")!;
  const compose = { services: { storage: { environment: { STORAGE_BACKEND: "file" }, volumes: [{ type: "volume", source: data.name }] } } };
  assert.doesNotThrow(() => assertRecoverableLayout(JSON.stringify(compose), projectId, initial.previousRelease));
  compose.services.storage.environment.STORAGE_BACKEND = "s3";
  assert.throws(() => assertRecoverableLayout(JSON.stringify(compose), projectId, initial.previousRelease), /external S3/);
  compose.services.storage.environment.STORAGE_BACKEND = "file";
  compose.services.storage.volumes[0].source = "unrelated_volume";
  assert.throws(() => assertRecoverableLayout(JSON.stringify(compose), projectId, initial.previousRelease), /unrecognized/);
  for (const gateway of ["api-gw", "kong"]) {
    const override = maintenanceOverride(gateway);
    assert.match(override, /supavisor:/);
    assert.equal(override.match(/ports: !override \[\]/g)?.length, 2);
  }
});

test("restart cleanup removes only generated recovery helpers for the selected project", async () => {
  const helper = `sm_recovery_${"a".repeat(32)}`;
  const calls: (readonly string[])[] = [];
  let found = helper;
  const runner = { run: async ({ args }: { args: readonly string[] }) => {
    calls.push(args);
    return { exitCode: 0, stderr: "", stdout: args.includes(`label=com.supabase-manager.recovery-project=${projectId}`) ? found : "" };
  } };
  await stopProjectForRecovery(runner, projectId);
  assert.deepEqual(calls.find((args) => args[0] === "rm"), ["rm", "--force", helper]);
  calls.length = 0;
  found = "unrelated-service";
  await assert.rejects(stopProjectForRecovery(runner, projectId), /identity/);
  assert.equal(calls.some((args) => args[0] === "rm"), false);
});

test("maintenance closes ingress, drains application writers, and stops PostgreSQL last", async () => {
  const services = ["db", "storage", "supavisor", "api-gw", "auth"];
  const containers = services.map((service, index) => ({ Id: String(index + 1).repeat(64), Config: { Labels: { [PROJECT_LABEL]: projectId, "com.docker.compose.project": dockerProjectName(projectId), "com.docker.compose.service": service } } }));
  const stops: (readonly string[])[] = [];
  const runner = { run: async ({ args }: { args: readonly string[] }) => {
    if (args[0] === "stop") stops.push(args.slice(3));
    return { exitCode: 0, stderr: "", stdout: args[0] === "inspect" ? JSON.stringify(containers) : args.includes(`label=${PROJECT_LABEL}=${projectId}`) ? containers.map((container) => container.Id).join("\n") : "" };
  } };
  await stopProjectForRecovery(runner, projectId);
  assert.deepEqual(stops, [[containers[2].Id, containers[3].Id], [containers[1].Id, containers[4].Id], [containers[0].Id]]);
});
