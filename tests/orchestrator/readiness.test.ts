import assert from "node:assert/strict";
import test from "node:test";
import { waitForContainers, waitForFunctionalCheck, ReadinessError } from "../../src/lib/orchestrator/readiness";
import { captureDeploymentDiagnostics } from "../../src/lib/orchestrator/deployment-diagnostics";
import { DockerCliHostDriver } from "../../src/lib/orchestrator/docker-driver";
import { sanitizeText } from "../../src/lib/orchestrator/diagnostics";
import type { CommandRunner, CommandSpec } from "../../src/lib/orchestrator/types";

const projectId = "8426b30d-0917-4555-8b08-687fc5f03402";
const name = "sm_8426b30d091745558b08687fc5f03402_storage";
const stateLine = (health: string, status = "running", oom = false) => `${JSON.stringify(`/${name}`)} ${JSON.stringify({ Status: status, Running: status === "running", OOMKilled: oom, ExitCode: 0, Health: { Status: health, Log: [{ ExitCode: 1, Output: "Connection refused" }] } })}`;
function clock(timeoutMs = 8_000) {
  let elapsed = 0;
  return { timeoutMs, now: () => elapsed, sleep: async (ms: number) => { elapsed += ms; } };
}

test("cold start can become unhealthy and then healthy without aborting or a fixed startup sleep", async () => {
  const calls: CommandSpec[] = [];
  const sequence = ["unhealthy", "starting", "healthy"];
  const progress: string[] = [];
  const runner: CommandRunner = { run: async (spec) => { calls.push(spec); return { exitCode: 0, stderr: "", stdout: stateLine(sequence.shift() ?? "healthy") }; } };
  await waitForContainers(runner, [name], { ...clock(), onProgress: (value) => progress.push(value) });
  assert.equal(calls.length, 3);
  assert.ok(progress.some((value) => value.includes("unhealthy")));
  assert.ok(calls.every((call) => !call.args.join(" ").includes(".Config")));
  let sleeps = 0;
  await waitForContainers(runner, [name], { sleep: async () => { sleeps++; } });
  assert.equal(sleeps, 0, "an already healthy container needs no timing-based delay");
});

test("an exited container can recover during Docker's restart cycle", async () => {
  let reads = 0;
  const runner: CommandRunner = { run: async () => ({ exitCode: 0, stderr: "", stdout: reads++ === 0 ? stateLine("unhealthy", "exited") : stateLine("healthy") }) };
  await waitForContainers(runner, [name], clock());
  assert.equal(reads, 2);
});

test("persistent unhealthy and missing required services fail at the deadline with exact container names", async () => {
  const runner: CommandRunner = { run: async () => ({ exitCode: 0, stderr: "", stdout: stateLine("healthy") }) };
  await assert.rejects(waitForContainers(runner, [name, "missing_required_service"], clock(2_000)), (error: unknown) => error instanceof ReadinessError && error.containers.includes("missing_required_service"));
  const unhealthy: CommandRunner = { run: async () => ({ exitCode: 0, stderr: "", stdout: stateLine("unhealthy") }) };
  await assert.rejects(waitForContainers(unhealthy, [name], clock(2_000)), /deadline exceeded.*unhealthy/);
});

test("OOM is an actionable terminal failure and cannot be reported ready even with an old healthy status", async () => {
  const runner: CommandRunner = { run: async () => ({ exitCode: 0, stderr: "", stdout: stateLine("healthy", "running", true) }) };
  await assert.rejects(waitForContainers(runner, [name], { sleep: async () => { throw new Error("must not sleep"); } }), /OOM killed/);
});

test("functional readiness requires the actual probe to succeed", async () => {
  let attempts = 0;
  await waitForFunctionalCheck("REST", async () => { if (++attempts < 3) throw new Error("HTTP 503"); }, clock());
  assert.equal(attempts, 3);
  await assert.rejects(waitForFunctionalCheck("REST", async () => { throw new Error("HTTP 503"); }, clock(1_000)), /REST failed: HTTP 503/);
});

test("failure snapshots are project-scoped, bounded, sanitized and have a safe copyable command", async () => {
  const secret = "example-password-with-symbols/+=";
  const calls: CommandSpec[] = [];
  const runner: CommandRunner = { run: async (spec) => {
    calls.push(spec);
    if (spec.args.includes("{{json .Config.Labels}}")) return { exitCode: 0, stderr: "", stdout: JSON.stringify({ "com.supabase-manager.managed": "true", "com.supabase-manager.project-id": projectId, "com.docker.compose.project": name.replace(/_storage$/, "") }) };
    if (spec.args[0] === "logs") return { exitCode: 0, stderr: "", stdout: `${secret} ${Buffer.from(secret).toString("base64")} ${encodeURIComponent(secret)} ${"x".repeat(15_000)}\nFinal actionable error` };
    return { exitCode: 0, stderr: "", stdout: stateLine("unhealthy") };
  } };
  const events: unknown[] = [];
  await captureDeploymentDiagnostics(runner, projectId, [name, "foreign_container;rm"], new ReadinessError("failed", [name, "foreign_container"]), [secret], (event) => events.push(event));
  assert.equal(events.length, 1);
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(secret) && !serialized.includes(Buffer.from(secret).toString("base64")));
  assert.match(serialized, /Final actionable error/);
  assert.ok(serialized.length < 8_000);
  assert.match(serialized, new RegExp(`docker logs --tail 100 --timestamps ${name}`));
  assert.ok(calls.filter((call) => call.args[0] === "logs").every((call) => call.args.at(-1) === name));
});

test("failure snapshots refuse containers carrying another project's identity", async () => {
  const calls: CommandSpec[] = [];
  const runner: CommandRunner = { run: async (spec) => { calls.push(spec); return { exitCode: 0, stderr: "", stdout: spec.args.includes("{{json .Config.Labels}}") ? "{}" : stateLine("unhealthy") }; } };
  await captureDeploymentDiagnostics(runner, projectId, [name], new Error("failed"), [], () => { throw new Error("must not expose logs"); });
  assert.ok(!calls.some((call) => call.args[0] === "logs"));
});

test("redaction covers JSON secrets, private keys, DSNs and control sequences", () => {
  const cleaned = sanitizeText(' {"password":"new secret", "authorization":"opaque-secret"} postgres://user:pass@db/test\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----\u001b[31m');
  assert.ok(!/new secret|opaque-secret|user:pass|\u001b/.test(cleaned));
  assert.match(cleaned, /REDACTED PRIVATE KEY/);
});

test("Docker driver distinguishes unhealthy and starting from healthy", async () => {
  const runner: CommandRunner = { run: async () => ({ exitCode: 0, stderr: "", stdout: ["unhealthy", "health: starting", "healthy"].map((health, index) => JSON.stringify({ ID: String(index), Names: String(index), State: "running", Status: `Up (${health})` })).join("\n") }) };
  assert.deepEqual((await new DockerCliHostDriver(runner).listContainers()).map((container) => container.health), ["unhealthy", "starting", "healthy"]);
});
