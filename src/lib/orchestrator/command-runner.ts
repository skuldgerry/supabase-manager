import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandResult, CommandRunner, CommandSpec } from "./types";

const execFileAsync = promisify(execFile);

/** Runs argv directly. A shell is intentionally never involved. */
export class DirectCommandRunner implements CommandRunner {
  async run(spec: CommandSpec): Promise<CommandResult> {
    if (!spec.executable || spec.executable.includes("\0")) throw new Error("invalid executable");
    if (spec.args.some((arg) => arg.includes("\0"))) throw new Error("invalid argument");
    try {
      const result = await execFileAsync(spec.executable, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env ? { ...process.env, ...spec.env } : process.env,
        timeout: spec.timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      const code = typeof failure.code === "number" ? failure.code : failure.killed ? 124 : 1;
      return { exitCode: code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? String(error) };
    }
  }
}

/** Useful for unit tests and dry-run UI previews; it cannot execute a command. */
export class RecordingCommandRunner implements CommandRunner {
  readonly calls: CommandSpec[] = [];
  constructor(private readonly result: CommandResult = { exitCode: 0, stdout: "", stderr: "" }) {}
  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push({ ...spec, args: [...spec.args] });
    return this.result;
  }
}
