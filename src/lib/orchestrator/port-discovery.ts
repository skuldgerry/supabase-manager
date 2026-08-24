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

async function dockerPublishedPorts(runner: CommandRunner): Promise<{ ports: Set<number>; available: boolean }> {
  const result = await runner.run({ executable: "docker", args: ["ps", "--format", "{{json .Ports}}"], timeoutMs: 15_000 });
  if (result.exitCode !== 0) return { ports: new Set(), available: false };
  return { ports: parseDockerPublishedPorts(result.stdout), available: true };
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
