import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const projectId = "8426b30d-0917-4555-8b08-687fc5f03402";
function harness(mode: "verify" | "resume", options: { failHttp?: boolean; rollback?: boolean; committed?: boolean; creation?: boolean } = {}) {
  const calls: string[] = [];
  const events: { message: string; details?: Record<string, unknown>; stage?: string }[] = [];
  const credentials = { ANON_KEY: "fixture-anon", SERVICE_ROLE_KEY: "fixture-service", POSTGRES_PASSWORD: "fixture-password" };
  const environment = "POSTGRES_PASSWORD=fixture-password\nANON_KEY=fixture-anon\nSERVICE_ROLE_KEY=fixture-service\n";
  const project = { id: projectId, status: options.committed ? "ready" : "provisioning", readyAt: options.committed ? "2026-11-02" : null as string | null, ownership: "manager-owned", stackRelease: "self-hosted/v0.8.0", ports: { api: 8101 } };
  const job = { id: "fixture-job", type: options.creation ? "create-project" : "check-project", projectId, status: "running", stage: options.rollback ? "rolling-back" : "validating", errorMessage: "initial readiness failure" };
  const repository = {
    getJob: () => job, getProject: () => project,
    getCredential: (_id: string, name: string) => ({ nonceBase64: "iv", authTagBase64: "tag", ciphertextBase64: JSON.stringify(name === "project-environment" ? environment : credentials), associatedData: name }),
    listJobEvents: () => [{ details: { mode } }, ...events],
    appendJobEvent: (event: typeof events[number]) => { events.push(event); },
    updateProjectStatus: (_id: string, status: string) => { project.status = status; if (status === "ready") project.readyAt = "verified"; },
    updateJobState: (_id: string, state: Partial<typeof job>) => { Object.assign(job, state); if (state.stage === "rolling-back") calls.push("persist-rollback-checkpoint"); },
    activateProjectPorts: () => { calls.push("retain-ports"); },
    upsertCredential: () => { throw new Error("Credentials must not be regenerated"); },
    recordVolume: () => { throw new Error("Volumes must not be initialized"); },
  };
  class Runner {
    async run(spec: { args: string[] }) {
      calls.push(`docker:${spec.args.join(" ")}`);
      return { exitCode: spec.args[0] === "version" ? 1 : 0, stderr: "", stdout: spec.args.includes("psql") ? "t\n" : "" };
    }
  }
  class Driver {
    async compose(spec: { args: string[] }) { calls.push(`compose:${spec.args.join(" ")}`); return { exitCode: 0, stderr: "", stdout: '{"services":{}}' }; }
  }
  const localRequire = (id: string): unknown => {
    if (id === "@/lib/config") return { getConfig: () => ({ dataDir: "/fixture", projectHost: "10.0.0.5" }) };
    if (id === "@/lib/db/manager") return { getRepository: () => repository };
    if (id === "@/lib/security/encryption") return { decryptJson: (envelope: { ciphertext: string }) => JSON.parse(envelope.ciphertext), getMasterKey: async () => Buffer.alloc(32) };
    if (id === "./command-runner") return { DirectCommandRunner: Runner };
    if (id === "./docker-driver") return { DockerCliHostDriver: Driver };
    if (id === "./update-recovery") return { stopProjectForRecovery: async () => { calls.push("stop-owned-services"); } };
    if (id === "./deployment-diagnostics") return { captureDeploymentDiagnostics: async (_runner: unknown, _project: string, _names: string[], _error: unknown, _secrets: string[], report: (event: unknown) => void) => { calls.push("diagnostics"); report({ container: "fixture-storage", kind: "container-diagnostics", logs: "Connection refused" }); } };
    if (id === "./readiness") return {
      waitForContainers: async () => { calls.push("check-all-required-containers"); },
      waitForFunctionalCheck: async (_label: string, probe: () => Promise<void>) => probe(),
    };
    if (id === "node:fs/promises") return {
      access: async () => undefined,
      writeFile: async (_file: string, value: string) => { assert.equal(value, environment); calls.push("write-saved-environment"); },
      rm: async () => { calls.push("remove-temporary-environment"); },
    };
    if (id === "./compose" || id === "./volumes") return {};
    if (id.startsWith("./")) return require(path.resolve("src/lib/orchestrator", id.slice(2)));
    return require(id);
  };
  const compiled = ts.transpileModule(readFileSync("src/lib/orchestrator/broker.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const compiledModule = { exports: {} };
  runInNewContext(compiled, { module: compiledModule, exports: compiledModule.exports, require: localRequire, process, Buffer, URL, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url: string) => { calls.push(`http:${new URL(url).pathname}`); return new Response("fixture", { status: options.failHttp ? 503 : 200 }); } });
  return { calls, events, project, job, worker: compiledModule.exports as { runDeploymentRecoveryJob: (id: string) => Promise<void>; runProvisioningJob: (id: string) => Promise<void> } };
}

test("recheck recovers the legacy false failure using actual checks, without starting or recreating anything", async () => {
  const fixture = harness("verify");
  await fixture.worker.runDeploymentRecoveryJob("fixture-job");
  assert.equal(fixture.project.status, "ready");
  assert.equal(fixture.job.status, "succeeded");
  assert.equal(fixture.calls.filter((call) => call.startsWith("http:")).length, 3);
  assert.ok(fixture.calls.some((call) => call.includes("psql")));
  assert.ok(!fixture.calls.some((call) => /compose:|write-saved|stop-owned/.test(call)));
});

test("resume reuses configuration, credentials, volumes and existing images before functional validation", async () => {
  const fixture = harness("resume");
  await fixture.worker.runDeploymentRecoveryJob("fixture-job");
  assert.equal(fixture.project.status, "ready");
  assert.equal(fixture.job.status, "succeeded");
  assert.ok(fixture.calls.includes("compose:up --detach --no-recreate --pull never db"));
  assert.ok(fixture.calls.includes("compose:up --detach --no-recreate --pull never"));
  assert.ok(!fixture.calls.some((call) => /generate|seed|volume rm|rm --force/.test(call)));
});

test("a failed read-only recheck captures diagnostics but never stops services", async () => {
  const fixture = harness("verify", { failHttp: true });
  await fixture.worker.runDeploymentRecoveryJob("fixture-job");
  assert.equal(fixture.job.status, "failed");
  assert.equal(fixture.project.status, "failed");
  assert.ok(fixture.calls.includes("diagnostics"));
  assert.ok(!fixture.calls.includes("stop-owned-services"));
});

test("a genuine resume failure snapshots logs before stopping services, while retaining data and ports", async () => {
  const fixture = harness("resume", { failHttp: true });
  await fixture.worker.runDeploymentRecoveryJob("fixture-job");
  assert.equal(fixture.job.status, "failed");
  const checkpoint = fixture.calls.indexOf("persist-rollback-checkpoint");
  assert.ok(checkpoint >= 0 && checkpoint < fixture.calls.indexOf("diagnostics"), "failure must be durable before asynchronous diagnostics");
  assert.ok(fixture.calls.indexOf("diagnostics") < fixture.calls.indexOf("stop-owned-services"));
  assert.ok(fixture.calls.includes("retain-ports"));
  assert.ok(fixture.events.some((event) => event.details?.dataPreserved === true));
});

test("an interrupted initial rollback resumes stopping, not provisioning or seeding", async () => {
  const fixture = harness("resume", { rollback: true, creation: true });
  await fixture.worker.runProvisioningJob("fixture-job");
  assert.equal(fixture.job.status, "failed");
  assert.ok(fixture.calls.includes("stop-owned-services"));
  assert.ok(!fixture.calls.some((call) => /compose:|http:|write-saved/.test(call)));
});

test("a broker restart after activation only completes the already-verified job", async () => {
  const fixture = harness("resume", { committed: true });
  await fixture.worker.runDeploymentRecoveryJob("fixture-job");
  assert.equal(fixture.job.status, "succeeded");
  assert.deepEqual(fixture.calls, []);
});
