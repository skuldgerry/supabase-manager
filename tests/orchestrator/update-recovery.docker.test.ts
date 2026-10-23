import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DirectCommandRunner } from "../../src/lib/orchestrator/command-runner.js";
import { createVolumeRecoveryPoint, pinRunningProjectImages, readRecoveryManifest, restoreVolumeRecoveryPoint, stopProjectForRecovery, writeRecoveryManifest, type RecoveryManifest } from "../../src/lib/orchestrator/update-recovery.js";
import { asProjectId } from "../../src/lib/orchestrator/types.js";
import { dockerProjectName, PROJECT_LABEL } from "../../src/lib/orchestrator/naming.js";
import { volumePlan } from "../../src/lib/orchestrator/volumes.js";

test("Docker: cold recovery restores migrated PostgreSQL data and Storage objects together", { skip: process.env.RUN_DOCKER_RECOVERY_TESTS !== "1", timeout: 300_000 }, async () => {
  const runner = new DirectCommandRunner();
  const projectId = asProjectId(randomUUID());
  const jobId = randomUUID();
  const release = "self-hosted/v0.8.0";
  const volumes = volumePlan(projectId, release);
  const db = volumes.find((volume) => volume.purpose === "postgres")!.name;
  const storage = volumes.find((volume) => volume.purpose === "storage")!.name;
  const name = `${dockerProjectName(projectId)}_db`;
  const directory = await mkdtemp(path.join(tmpdir(), "sm-docker-recovery-"));
  const docker = async (...args: string[]) => {
    const result = await runner.run({ executable: "docker", args, timeoutMs: 120_000 });
    assert.equal(result.exitCode, 0, `${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const sql = (statement: string) => docker("exec", name, "psql", "-U", "postgres", "-tAc", statement);
  const ready = async () => {
    for (let n = 0; n < 60; n++) {
      const result = await runner.run({ executable: "docker", args: ["exec", name, "pg_isready", "-U", "postgres"], timeoutMs: 3000 });
      if (result.exitCode === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Fixture database did not start");
  };
  try {
    for (const volume of volumes) await docker("volume", "create", "--label", `${PROJECT_LABEL}=${projectId}`, volume.name);
    await docker("run", "-d", "--name", name, "--label", `${PROJECT_LABEL}=${projectId}`, "--label", `com.docker.compose.project=${dockerProjectName(projectId)}`, "--label", "com.docker.compose.service=db", "--env", "POSTGRES_PASSWORD=disposable-fixture-only", "--mount", `type=volume,source=${db},target=/var/lib/postgresql/data`, "postgres:17-alpine");
    await ready();
    await sql("CREATE TABLE recovery_control (id int); INSERT INTO recovery_control VALUES (1);");
    await docker("run", "--rm", "--mount", `type=volume,source=${storage},target=/objects`, "alpine:3.23", "sh", "-ec", "printf original-object > /objects/proof.txt");
    const imageLock = await pinRunningProjectImages(runner, projectId);
    assert.match(imageLock, /image: "sha256:/);
    // Compose must actually accept the immutable image IDs used during recovery.
    const composePath = path.join(directory, "compose.yml");
    const lockPath = path.join(directory, "images.yml");
    await writeFile(composePath, `services:\n  db:\n    image: postgres:17-alpine\n    container_name: ${name}\n    environment:\n      POSTGRES_PASSWORD: disposable-fixture-only\n    labels:\n      ${PROJECT_LABEL}: ${projectId}\n    volumes:\n      - database:/var/lib/postgresql/data\nvolumes:\n  database:\n    external: true\n    name: ${db}\n`);
    await writeFile(lockPath, imageLock);
    // The initial fixture was created with docker run, not Compose. Recreate it
    // using the lock; Compose intentionally refuses to adopt unmanaged containers.
    await docker("rm", "--force", name);
    await docker("compose", "-p", dockerProjectName(projectId), "-f", composePath, "-f", lockPath, "up", "-d");
    await ready();
    await stopProjectForRecovery(runner, projectId);
    let manifest: RecoveryManifest = { version: 1, projectId, jobId, previousRelease: release, targetRelease: "self-hosted/v0.8.3", phase: "snapshotting", createdAt: new Date().toISOString(), volumes: [] };
    await writeRecoveryManifest(directory, manifest);
    manifest = await createVolumeRecoveryPoint(runner, directory, manifest, () => {});
    assert.equal(manifest.volumes.length, 9);
    manifest = { ...manifest, phase: "switching" };
    await writeRecoveryManifest(directory, manifest);
    await docker("start", name);
    await ready();
    await sql("ALTER TABLE recovery_control ADD COLUMN incompatible text; INSERT INTO recovery_control VALUES (2, 'new release');");
    await docker("run", "--rm", "--mount", `type=volume,source=${storage},target=/objects`, "alpine:3.23", "sh", "-ec", "printf mutated-object > /objects/proof.txt; printf new > /objects/new.txt");
    await stopProjectForRecovery(runner, projectId);
    // Reload the persisted state, as a new broker process would after a crash.
    const resumed = (await readRecoveryManifest(directory, projectId, jobId))!;
    await restoreVolumeRecoveryPoint(runner, directory, resumed, () => {});
    await restoreVolumeRecoveryPoint(runner, directory, resumed, () => {});
    assert.equal(await docker("run", "--rm", "--mount", `type=volume,source=${storage},target=/objects,readonly`, "alpine:3.23", "sh", "-ec", "test ! -e /objects/new.txt; cat /objects/proof.txt"), "original-object");
    await docker("start", name);
    await ready();
    assert.equal(await sql("SELECT count(*) FROM recovery_control"), "1");
    assert.equal(await sql("SELECT count(*) FROM information_schema.columns WHERE table_name='recovery_control' AND column_name='incompatible'"), "0");
  } finally {
    await runner.run({ executable: "docker", args: ["rm", "--force", name] });
    for (const volume of volumes) {
      const owned = await runner.run({ executable: "docker", args: ["volume", "inspect", "--format", `{{index .Labels "${PROJECT_LABEL}"}}`, volume.name] });
      if (owned.stdout.trim() === projectId) await runner.run({ executable: "docker", args: ["volume", "rm", volume.name] });
    }
    const network = `${dockerProjectName(projectId)}_default`;
    const networkOwner = await runner.run({ executable: "docker", args: ["network", "inspect", "--format", '{{index .Labels "com.docker.compose.project"}}', network] });
    if (networkOwner.stdout.trim() === dockerProjectName(projectId)) await runner.run({ executable: "docker", args: ["network", "rm", network] });
    await rm(directory, { recursive: true, force: true });
  }
});
