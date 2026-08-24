/** Shared, transport-independent orchestration types. */

export type ProjectId = string & { readonly __brand: "ProjectId" };

export function asProjectId(value: string): ProjectId {
  const normalized = value.trim().toLowerCase();
  if (!isUuid(normalized)) throw new Error("projectId must be a UUID");
  return normalized as ProjectId;
}

export function isUuid(value: string): boolean {
  // Accept UUID versions currently emitted by runtimes (including v7), while
  // still requiring the RFC variant bits used by ordinary project IDs.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export type HostPortKind = "api" | "dbSession" | "dbTransaction";

export interface ProjectPorts {
  readonly api: number;
  readonly dbSession: number;
  readonly dbTransaction: number;
}

export interface ProjectIdentity {
  readonly projectId: ProjectId;
  readonly organizationId?: string;
  readonly release: string;
}

export interface CommandSpec {
  /** Executable and arguments are deliberately separate: no shell is supported. */
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}

export interface HostContainer {
  readonly id: string;
  readonly name: string;
  readonly service?: string;
  readonly state: "created" | "running" | "exited" | "dead" | "unknown";
  readonly health?: "starting" | "healthy" | "unhealthy" | "none";
  readonly labels: Readonly<Record<string, string>>;
}

export interface HostVolume {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface HostNetwork {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface HostDriver {
  readonly kind: "local" | "remote";
  listContainers(labels?: Readonly<Record<string, string>>): Promise<readonly HostContainer[]>;
  listVolumes(labels?: Readonly<Record<string, string>>): Promise<readonly HostVolume[]>;
  listNetworks(labels?: Readonly<Record<string, string>>): Promise<readonly HostNetwork[]>;
  createNetwork(name: string, labels: Readonly<Record<string, string>>): Promise<void>;
  createVolume(name: string, labels: Readonly<Record<string, string>>): Promise<void>;
  removeContainer(id: string, force?: boolean): Promise<void>;
  compose(spec: ComposeInvocation): Promise<CommandResult>;
}

export interface ComposeInvocation {
  readonly files: readonly string[];
  readonly envFile: string;
  readonly projectName: string;
  readonly args?: readonly string[];
}
