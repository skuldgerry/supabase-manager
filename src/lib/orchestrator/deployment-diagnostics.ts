import { boundedDiagnosticText, sanitizeText } from "./diagnostics";
import { dockerProjectName, MANAGER_LABEL, PROJECT_LABEL } from "./naming";
import { inspectContainerStates, ReadinessError, safeContainerName } from "./readiness";
import { asProjectId, type CommandRunner } from "./types";

export type ContainerDiagnostic = {
  kind: "container-diagnostics";
  container: string;
  state: string;
  healthOutput: string;
  logs: string;
  command: string;
  truncated: boolean;
};

/** Failure-only, bounded snapshots. Never fetch environment or unrelated containers. */
export async function captureDeploymentDiagnostics(
  runner: CommandRunner, projectId: string, names: readonly string[], error: unknown,
  secrets: readonly string[], report: (diagnostic: ContainerDiagnostic) => void,
): Promise<void> {
  const expectedProject = dockerProjectName(asProjectId(projectId));
  const allowed = names.filter((name) => safeContainerName(name) && (name.startsWith(`${expectedProject}_`) || name === `realtime-dev.${expectedProject}_realtime`));
  if (!allowed.length) return;
  let states: Awaited<ReturnType<typeof inspectContainerStates>> = [];
  try { states = await inspectContainerStates(runner, allowed); } catch { /* Still attempt safe, labelled log reads. */ }
  const unhealthy = states.filter((state) => !state.running || (state.health && state.health.Status !== "healthy")).map((state) => state.name);
  const preferred = error instanceof ReadinessError ? error.containers.filter((name) => allowed.includes(name)) : unhealthy;
  const targets = (preferred.length ? preferred : allowed.filter((name) => /_(db|api-gw|kong|rest|storage)$/.test(name))).slice(0, 4);
  for (const name of targets) {
    // Recheck ownership immediately before reading logs, including Compose identity.
    const identity = await runner.run({ executable: "docker", args: ["inspect", "--format", "{{json .Config.Labels}}", name], timeoutMs: 5_000 });
    let labels: Record<string, string>;
    try { labels = JSON.parse(identity.stdout); } catch { continue; }
    if (identity.exitCode !== 0 || labels[MANAGER_LABEL] !== "true" || labels[PROJECT_LABEL] !== projectId || labels["com.docker.compose.project"] !== expectedProject) continue;
    const state = states.find((value) => value.name === name);
    const output = await runner.run({ executable: "docker", args: ["logs", "--tail", "100", "--timestamps", name], timeoutMs: 5_000 });
    const raw = [output.stdout, output.stderr].filter(Boolean).join("\n");
    const clean = sanitizeText(raw, secrets);
    const health = state?.health?.Log?.slice(-3).map((item) => `exit ${item.ExitCode}: ${item.Output}`).join("\n") ?? "No Docker healthcheck output is available";
    report({ kind: "container-diagnostics", container: name, state: state?.health?.Status ?? state?.status ?? "unknown",
      healthOutput: boundedDiagnosticText(sanitizeText(health, secrets), 1_500),
      logs: boundedDiagnosticText(clean || "No container logs are available", 6_000),
      command: `docker logs --tail 100 --timestamps ${name}`, truncated: clean.length > 6_000 || output.exitCode !== 0 });
  }
}
