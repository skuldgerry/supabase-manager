import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DirectCommandRunner } from "../../src/lib/orchestrator/command-runner";
import { waitForContainers } from "../../src/lib/orchestrator/readiness";
import { captureDeploymentDiagnostics, type ContainerDiagnostic } from "../../src/lib/orchestrator/deployment-diagnostics";
import { stopProjectForRecovery } from "../../src/lib/orchestrator/update-recovery";

test("Docker: real unhealthy cold start recovers, logs are scoped/redacted and rollback retains volume data", { skip: process.env.RUN_DOCKER_RECOVERY_TESTS !== "1", timeout: 120_000 }, async () => {
  const runner = new DirectCommandRunner();
  const projectId = randomUUID();
  const prefix = `sm_${projectId.replaceAll("-", "")}`;
  const container = `${prefix}_storage`;
  const volume = `${prefix}_storage`;
  const unrelated = `sm_test_sentinel_${randomUUID().replaceAll("-", "")}`;
  const secret = "synthetic-private-log-fixture-only";
  const docker = async (...args: string[]) => {
    const result = await runner.run({ executable: "docker", args, timeoutMs: 30_000 });
    assert.equal(result.exitCode, 0, `${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    await docker("volume", "create", "--label", `com.supabase-manager.project-id=${projectId}`, volume);
    await docker("run", "-d", "--name", unrelated, "--network", "none", "node:24-alpine", "node", "-e", "setInterval(()=>{},1000)");
    await docker("run", "-d", "--name", container, "--network", "none",
      "--label", "com.supabase-manager.managed=true", "--label", `com.supabase-manager.project-id=${projectId}`, "--label", `com.docker.compose.project=${prefix}`, "--label", "com.docker.compose.service=storage",
      "--mount", `type=volume,source=${volume},target=/objects`, "--health-interval", "1s", "--health-timeout", "1s", "--health-retries", "1", "--health-cmd", "node -e \"fetch('http://127.0.0.1:5000/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
      "node:24-alpine", "node", "-e", `require('fs').writeFileSync('/objects/proof','retained-data');setTimeout(()=>{require('http').createServer((q,r)=>r.end('ready')).listen(5000,'0.0.0.0');console.log('${secret}: late service ready')},7000)`);
    const progress: string[] = [];
    await waitForContainers(runner, [container], { timeoutMs: 30_000, onProgress: (message) => progress.push(message) });
    assert.ok(progress.some((message) => message.includes("unhealthy")), "must observe a real unhealthy state before recovery");
    const events: ContainerDiagnostic[] = [];
    await captureDeploymentDiagnostics(runner, projectId, [container], new Error("fixture diagnostic"), [secret], (event) => events.push(event));
    assert.equal(events.length, 1);
    assert.ok(!events[0].logs.includes(secret));
    assert.match(events[0].logs, /late service ready/);
    await stopProjectForRecovery(runner, projectId);
    assert.equal(await docker("inspect", "--format", "{{.State.Running}}", container), "false");
    assert.equal(await docker("inspect", "--format", "{{.State.Running}}", unrelated), "true");
    assert.equal(await docker("run", "--rm", "--network", "none", "--mount", `type=volume,source=${volume},target=/objects,readonly`, "alpine:3.23", "cat", "/objects/proof"), "retained-data");
  } finally {
    await runner.run({ executable: "docker", args: ["rm", "--force", container, unrelated], timeoutMs: 30_000 });
    await runner.run({ executable: "docker", args: ["volume", "rm", volume], timeoutMs: 30_000 });
  }
});
