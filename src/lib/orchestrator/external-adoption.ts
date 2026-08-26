import { adapterForRelease } from "./adapters";
import { DirectCommandRunner } from "./command-runner";
import type { CommandRunner } from "./types";

export type ExternalAdoptionCheck = {
  apiUrl: string;
  dbHost: string;
  dbPort: number;
  anonKey: string;
  serviceRoleKey: string;
  postgresPassword: string;
  dashboardPassword: string;
  jwtSecret: string;
  release: string;
};

export type ExternalAdoptionValidation = {
  /** The broker intentionally does not probe arbitrary user-supplied hosts. */
  connectivity: "not-probed";
  compatibility: "compatible";
};

function looksLikeJwt(value: string): boolean {
  return value.split(".").length === 3 && value.length >= 20;
}

/**
 * Validate an adoption request without contacting the supplied endpoint.
 *
 * The manager must not turn arbitrary user input into a server-side network
 * probe (SSRF). Connectivity is therefore surfaced as explicitly unverified;
 * the imported project's own health/status checks remain the source of truth.
 */
export function validateExternalAdoption(input: ExternalAdoptionCheck): ExternalAdoptionValidation {
  try {
    adapterForRelease(input.release);
  } catch {
    throw new Error("Unsupported official Supabase release tag");
  }
  try {
    const api = new URL(input.apiUrl);
    if (!/^https?:$/.test(api.protocol)) throw new Error("Project API URL must use HTTP or HTTPS");
  } catch (error) {
    if (error instanceof Error && error.message === "Project API URL must use HTTP or HTTPS") throw error;
    throw new Error("Project API URL is invalid");
  }
  if (!input.dbHost || !Number.isInteger(input.dbPort) || input.dbPort < 1 || input.dbPort > 65535) {
    throw new Error("Database connection details are invalid");
  }
  if (input.postgresPassword.length < 12 || input.dashboardPassword.length < 12 || input.jwtSecret.length < 32) {
    throw new Error("Required credentials do not meet the minimum shape");
  }
  if (!looksLikeJwt(input.anonKey) || !looksLikeJwt(input.serviceRoleKey)) {
    throw new Error("ANON_KEY and SERVICE_ROLE_KEY must be JWT-shaped credentials");
  }
  return { connectivity: "not-probed", compatibility: "compatible" };
}

async function docker(runner: CommandRunner, args: readonly string[]): Promise<string> {
  const result = await runner.run({ executable: "docker", args, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error("The local Docker deployment could not be inspected");
  return result.stdout.trim();
}

async function composeProjectForPublishedPort(runner: CommandRunner, apiPort: number): Promise<string> {
  const ids = (await docker(runner, ["ps", "--filter", `publish=${apiPort}`, "--format", "{{.ID}}"]))
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length !== 1) throw new Error("The API port must belong to exactly one running local Docker container");
  const composeProject = await docker(runner, [
    "inspect",
    "--format",
    '{{ index .Config.Labels "com.docker.compose.project" }}',
    ids[0],
  ]);
  if (!composeProject || composeProject === "<no value>") {
    throw new Error("The API container is not part of a Docker Compose deployment");
  }
  return composeProject;
}

/**
 * Prove that a same-host published API port belongs to the Compose deployment
 * holding the credentials supplied by the administrator. No credential is
 * sent over the network during this ownership check.
 */
export async function verifySameHostSupabaseStack(
  input: { apiPort: number; anonKey: string; serviceRoleKey: string; postgresPassword: string },
  runner: CommandRunner = new DirectCommandRunner(),
): Promise<{ composeProject: string }> {
  const composeProject = await composeProjectForPublishedPort(runner, input.apiPort);
  const ids = (await docker(runner, [
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${composeProject}`,
    "--format",
    "{{.ID}}",
  ])).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("The Compose deployment has no containers");

  const expected = new Set([
    `SUPABASE_ANON_KEY=${input.anonKey}`,
    `SUPABASE_SERVICE_KEY=${input.serviceRoleKey}`,
    `POSTGRES_PASSWORD=${input.postgresPassword}`,
  ]);
  for (const id of ids) {
    const raw = await docker(runner, ["inspect", "--format", "{{json .Config.Env}}", id]);
    const environment = JSON.parse(raw) as string[];
    for (const value of environment) expected.delete(value);
  }
  if (expected.size > 0) {
    throw new Error("The supplied credentials do not match the local Supabase Compose deployment");
  }
  return { composeProject };
}

/** Re-check the published-port owner before proxying privileged Studio traffic. */
export async function verifyExternalGatewayOwnership(
  apiPort: number,
  expectedComposeProject: string,
  runner: CommandRunner = new DirectCommandRunner(),
): Promise<boolean> {
  try {
    return (await composeProjectForPublishedPort(runner, apiPort)) === expectedComposeProject;
  } catch {
    return false;
  }
}
