import type { CommandRunner } from "./types";

export type ContainerState = {
  name: string;
  status: string;
  health?: { Status?: string; Log?: { ExitCode: number; Output: string }[] };
  running: boolean;
  oomKilled: boolean;
  exitCode: number;
};

export class ReadinessError extends Error {
  constructor(message: string, readonly containers: readonly string[]) {
    super(message);
    this.name = "ReadinessError";
  }
}

export type ReadinessOptions = {
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const safeContainerName = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,180}$/.test(value);

/** Read State only: never inspect or persist the container's environment. */
export async function inspectContainerStates(runner: CommandRunner, names: readonly string[]): Promise<ContainerState[]> {
  if (!names.length || names.some((name) => !safeContainerName(name))) throw new Error("Invalid readiness container names");
  const result = await runner.run({ executable: "docker", args: ["inspect", "--format", '{{json .Name}} {{json .State}}', ...names], timeoutMs: 15_000 });
  const found = new Map<string, ContainerState>();
  for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
    const match = line.match(/^("[^"]+") (\{.*\})$/);
    if (!match) continue;
    const name = String(JSON.parse(match[1])).replace(/^\//, "");
    if (!names.includes(name)) continue;
    const state = JSON.parse(match[2]);
    found.set(name, { name, status: state.Status, running: state.Running === true, oomKilled: state.OOMKilled === true, exitCode: state.ExitCode ?? 0, health: state.Health });
  }
  return names.map((name) => found.get(name) ?? { name, status: "unavailable", running: false, oomKilled: false, exitCode: 0 });
}

/** Readiness is observed, not inferred from a sleep. The deadline only bounds a genuinely failed start. */
export async function waitForContainers(runner: CommandRunner, names: readonly string[], options: ReadinessOptions = {}): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? pause;
  const deadline = now() + (options.timeoutMs ?? 6 * 60_000);
  let previous = "";
  let lastProgress = 0;
  let pending = [...names];
  while (true) {
    const states = await inspectContainerStates(runner, names);
    const fatal = states.filter((state) => state.oomKilled || state.status === "dead");
    if (fatal.length) throw new ReadinessError(`Services cannot start: ${fatal.map((state) => `${state.name}=${state.oomKilled ? "OOM killed" : "dead"}`).join(", ")}`, fatal.map((state) => state.name));
    const waiting = states.filter((state) => !state.running || (state.health && state.health.Status !== "healthy"));
    if (!waiting.length) return;
    pending = waiting.map((state) => state.name);
    const summary = waiting.map((state) => `${state.name}=${state.health?.Status ?? state.status}`).join(", ");
    if (summary !== previous || now() - lastProgress >= 15_000) {
      options.onProgress?.(`Waiting for service readiness: ${summary}`);
      previous = summary;
      lastProgress = now();
    }
    if (now() >= deadline) throw new ReadinessError(`Service readiness deadline exceeded: ${summary}`, pending);
    // unhealthy/exited/restarting can recover during a cold start; do not turn a
    // transient Docker health result into a terminal provisioning failure.
    await sleep(Math.min(2_000, Math.max(1, deadline - now())));
  }
}

export async function waitForFunctionalCheck(label: string, probe: () => Promise<void>, options: ReadinessOptions = {}): Promise<void> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 2 * 60_000);
  const sleep = options.sleep ?? pause;
  let reported = false;
  while (true) {
    try { await probe(); return; } catch (error) {
      if (now() >= deadline) throw new Error(`${label} failed: ${error instanceof Error ? error.message : "probe unavailable"}`);
      if (!reported) { options.onProgress?.(`Waiting for functional check: ${label}`); reported = true; }
    }
    await sleep(Math.min(2_000, Math.max(1, deadline - now())));
  }
}
