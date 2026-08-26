import type { CommandRunner, ComposeInvocation, CommandResult, HostContainer, HostDriver, HostNetwork, HostVolume } from "./types";

function labelsArgs(labels?: Readonly<Record<string, string>>): string[] {
  return Object.entries(labels ?? {}).flatMap(([key, value]) => ["--filter", `label=${key}=${value}`]);
}

function lines(result: CommandResult): unknown[] {
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

/** Docker CLI adapter. All process execution is delegated to CommandRunner. */
export class DockerCliHostDriver implements HostDriver {
  readonly kind = "local" as const;
  constructor(private readonly runner: CommandRunner, private readonly executable = "docker") {}

  private async docker(args: readonly string[]): Promise<CommandResult> {
    const result = await this.runner.run({ executable: this.executable, args: [...args], timeoutMs: 120_000 });
    if (result.exitCode !== 0) throw new Error(`docker command failed (${result.exitCode}): ${result.stderr}`);
    return result;
  }

  async listContainers(labels?: Readonly<Record<string, string>>): Promise<readonly HostContainer[]> {
    const result = await this.docker(["ps", "-a", ...labelsArgs(labels), "--format", "{{json .}}"]);
    return lines(result).map((row) => {
      const item = row as Record<string, string>;
      return { id: item.ID, name: item.Names, state: item.State as HostContainer["state"], health: item.Status?.toLowerCase().includes("healthy") ? "healthy" : "none", labels: {} };
    });
  }

  async listVolumes(labels?: Readonly<Record<string, string>>): Promise<readonly HostVolume[]> {
    const result = await this.docker(["volume", "ls", ...labelsArgs(labels), "--format", "{{json .}}"]);
    return lines(result).map((row) => ({ name: (row as Record<string, string>).Name, labels: {} }));
  }

  async listNetworks(labels?: Readonly<Record<string, string>>): Promise<readonly HostNetwork[]> {
    const result = await this.docker(["network", "ls", ...labelsArgs(labels), "--format", "{{json .}}"]);
    return lines(result).map((row) => ({ name: (row as Record<string, string>).Name, labels: {} }));
  }

  async createNetwork(name: string, labels: Readonly<Record<string, string>>): Promise<void> {
    await this.docker(["network", "create", ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), name]);
  }

  async createVolume(name: string, labels: Readonly<Record<string, string>>): Promise<void> {
    await this.docker(["volume", "create", ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), name]);
  }

  async removeContainer(id: string, force = false): Promise<void> {
    await this.docker(["rm", ...(force ? ["--force"] : []), id]);
  }

  async removeVolume(name: string, force = false): Promise<void> {
    await this.docker(["volume", "rm", ...(force ? ["--force"] : []), name]);
  }

  async removeNetwork(name: string): Promise<void> {
    await this.docker(["network", "rm", name]);
  }

  async compose(spec: ComposeInvocation): Promise<CommandResult> {
    const args = ["compose", ...spec.files.flatMap((file) => ["--file", file]), "--env-file", spec.envFile, "--project-name", spec.projectName, ...(spec.args ?? [])];
    const result = await this.runner.run({ executable: this.executable, args, timeoutMs: 15 * 60_000 });
    if (result.exitCode !== 0) throw new Error(`docker compose failed (${result.exitCode}): ${result.stderr}`);
    return result;
  }
}
