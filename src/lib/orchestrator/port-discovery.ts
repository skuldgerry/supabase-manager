import type { HostId } from "@/lib/domain";
import { getRepository } from "@/lib/db/manager";
import { DirectCommandRunner } from "./command-runner";
import type { CommandRunner, ProjectPorts } from "./types";

export type PortField = "api" | "dbSession" | "dbTransaction";
export type PortConflict = { field: PortField; port: number; reason: "manager" | "docker" };
export type PortDiscovery = {
  suggested: ProjectPorts;
  conflicts: PortConflict[];
  dockerAvailable: boolean;
};

export function parseDockerPublishedPorts(output: string): Set<number> {
  const ports = new Set<number>();
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    let line = rawLine.trim();
    try { line = JSON.parse(line) as string; } catch { /* Docker can also return the unquoted value. */ }
    for (const match of line.matchAll(/(?:^|,\s*)(?:\[?[0-9a-fA-F:.]+\]?:)?(\d+)->\d+\/(?:tcp|udp)/g)) {
      const port = Number(match[1]);
      if (Number.isInteger(port)) ports.add(port);
    }
  }
  return ports;
}

const PORT_OWNING_STATES = new Set(["created", "running", "restarting", "paused"]);

/** Parse `docker inspect` state and configured HostConfig.PortBindings lines. */
export function parseDockerConfiguredPorts(output: string): Set<number> {
  const ports = new Set<number>();
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const separator = rawLine.indexOf("\t");
    if (separator < 0) continue;
    try {
      const rawState = rawLine.slice(0, separator).trim();
      const state = rawState.startsWith('"') ? JSON.parse(rawState) as string : rawState;
      if (!PORT_OWNING_STATES.has(state)) continue;
      const bindings = JSON.parse(rawLine.slice(separator + 1)) as Record<string, Array<{ HostPort?: string }> | null> | null;
      for (const entries of Object.values(bindings ?? {})) {
        for (const entry of entries ?? []) {
          const port = Number(entry.HostPort);
          if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port);
        }
      }
    } catch {
      // Ignore a malformed container row instead of disabling all discovery.
    }
  }
  return ports;
}

async function dockerPublishedPorts(runner: CommandRunner): Promise<{ ports: Set<number>; available: boolean }> {
  const listed = await runner.run({ executable: "docker", args: ["ps", "--all", "--format", "{{.ID}}"], timeoutMs: 15_000 });
  if (listed.exitCode !== 0) return { ports: new Set(), available: false };
  const ids = listed.stdout.split(/\r?\n/).map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return { ports: new Set(), available: true };
  const inspected = await runner.run({
    executable: "docker",
    args: ["inspect", "--format", "{{json .State.Status}}\t{{json .HostConfig.PortBindings}}", ...ids],
    timeoutMs: 15_000,
  });
  if (inspected.exitCode !== 0) return { ports: new Set(), available: false };
  return { ports: parseDockerConfiguredPorts(inspected.stdout), available: true };
}

function nextAvailable(start: number, unavailable: Set<number>): number {
  for (let port = start; port <= 65535; port += 1) if (!unavailable.has(port)) return port;
  for (let port = 1024; port < start; port += 1) if (!unavailable.has(port)) return port;
  throw new Error("No host ports are available");
}

export async function discoverProjectPorts(
  hostId: HostId,
  candidates?: ProjectPorts,
  runner: CommandRunner = new DirectCommandRunner(),
): Promise<PortDiscovery> {
  const reserved = new Set(getRepository().listReservedPorts(hostId));
  const docker = await dockerPublishedPorts(runner);
  const unavailable = new Set([...reserved, ...docker.ports]);
  const suggested: ProjectPorts = {
    api: nextAvailable(8100, unavailable),
    dbSession: nextAvailable(54100, unavailable),
    dbTransaction: nextAvailable(55100, unavailable),
  };
  const conflicts: PortConflict[] = [];
  if (candidates) {
    for (const [field, port] of Object.entries(candidates) as Array<[PortField, number]>) {
      if (reserved.has(port)) conflicts.push({ field, port, reason: "manager" });
      else if (docker.ports.has(port)) conflicts.push({ field, port, reason: "docker" });
    }
  }
  return { suggested, conflicts, dockerAvailable: docker.available };
}
