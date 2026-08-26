import { getRepository } from "@/lib/db/manager";
import type { ProjectId } from "@/lib/domain";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { loadProjectCredentials } from "@/lib/internal/project-view";
import { getConfig } from "@/lib/config";
import { DirectCommandRunner } from "@/lib/orchestrator/command-runner";
import { dockerProjectName } from "@/lib/orchestrator/naming";
import { verifyExternalGatewayOwnership } from "@/lib/orchestrator/external-adoption";

export const dynamic = "force-dynamic";
type ServiceName = "auth" | "db" | "pooler" | "realtime" | "rest" | "storage";
const allServices: readonly ServiceName[] = ["auth", "db", "pooler", "realtime", "rest", "storage"];

function requestedServices(request: Request): ServiceName[] {
  const values = new URL(request.url).searchParams.getAll("services").flatMap((value) => value.split(","));
  const selected = values.filter((value): value is ServiceName => allServices.includes(value as ServiceName));
  return selected.length ? [...new Set(selected)] : ["auth", "db", "realtime", "rest", "storage"];
}

async function inspectComposeService(runner: DirectCommandRunner, composeProject: string, service: string) {
  const lookup = await runner.run({
    executable: "docker",
    args: ["ps", "-a", "--filter", `label=com.docker.compose.project=${composeProject}`, "--filter", `label=com.docker.compose.service=${service}`, "--format", "{{.ID}}"],
    timeoutMs: 10_000,
  });
  const id = lookup.exitCode === 0 ? lookup.stdout.trim().split(/\r?\n/).filter(Boolean)[0] : undefined;
  if (!id) return { id: null, state: "missing" };
  const status = await runner.run({ executable: "docker", args: ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", id], timeoutMs: 10_000 });
  return { id, state: status.exitCode === 0 ? status.stdout.trim().toLowerCase() : "missing" };
}

async function endpoint(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000), cache: "no-store" });
    return { ok: response.ok, status: response.status };
  } catch { return { ok: false, status: 0 }; }
}

async function checkService(runner: DirectCommandRunner, project: NonNullable<ReturnType<ReturnType<typeof getRepository>["getProject"]>>, service: ServiceName, credentials: Record<string, string> | null) {
  if (project.ownership === "external") {
    const composeProject = credentials?.EXTERNAL_DOCKER_PROJECT;
    const verified = composeProject
      ? await verifyExternalGatewayOwnership(project.ports.api, composeProject, runner)
      : false;
    if (!verified) {
      return { name: service, status: "UNHEALTHY" as const, healthy: false, error: "verified external Compose gateway is unavailable" };
    }
    if (!credentials?.SERVICE_ROLE_KEY) {
      return { name: service, status: "UNHEALTHY" as const, healthy: false, error: "project credentials are unavailable" };
    }
    if (service === "db" || service === "realtime" || service === "pooler") {
      const composeService = service === "pooler" ? "supavisor" : service;
      const state = await inspectComposeService(runner, composeProject!, composeService);
      if (!state.id || (state.state !== "running" && state.state !== "healthy")) {
        return { name: service, status: "UNHEALTHY" as const, healthy: false, error: `${service} container is ${state.state}` };
      }
      if (service !== "db") return { name: service, status: "ACTIVE_HEALTHY" as const, healthy: true };
      const ready = await runner.run({ executable: "docker", args: ["exec", state.id, "pg_isready", "-U", project.databaseUsername, "-d", "postgres"], timeoutMs: 10_000 });
      return ready.exitCode === 0
        ? { name: service, status: "ACTIVE_HEALTHY" as const, healthy: true }
        : { name: service, status: "UNHEALTHY" as const, healthy: false, error: "PostgreSQL is not accepting connections" };
    }
    const path = service === "auth" ? "/auth/v1/health" : service === "rest" ? "/rest/v1/" : "/storage/v1/status";
    const result = await endpoint(`http://${getConfig().projectHost}:${project.ports.api}${path}`, { apikey: credentials.SERVICE_ROLE_KEY, Authorization: `Bearer ${credentials.SERVICE_ROLE_KEY}` });
    return result.ok ? { name: service, status: "ACTIVE_HEALTHY" as const, healthy: true } : { name: service, status: "UNHEALTHY" as const, healthy: false, error: `${service} endpoint returned ${result.status || "unreachable"}` };
  }
  const composeService = service === "pooler" ? "supavisor" : service;
  const container = await inspectComposeService(
    runner,
    dockerProjectName(project.id as ProjectId),
    composeService,
  );
  if (!container.id || (container.state !== "running" && container.state !== "healthy")) {
    return { name: service, status: project.status === "provisioning" || container.state === "starting" || container.state === "created" ? "COMING_UP" as const : "UNHEALTHY" as const, healthy: false, error: `container is ${container.state}` };
  }
  if (service === "pooler") return { name: service, status: "ACTIVE_HEALTHY" as const, healthy: true };
  if (service === "db") {
    const ready = await runner.run({ executable: "docker", args: ["exec", container.id, "pg_isready", "-U", project.databaseUsername, "-d", "postgres"], timeoutMs: 10_000 });
    return ready.exitCode === 0 ? { name: service, status: "ACTIVE_HEALTHY" as const, healthy: true } : { name: service, status: "UNHEALTHY" as const, healthy: false, error: "PostgreSQL is not accepting connections" };
  }
  if (!credentials?.SERVICE_ROLE_KEY) return { name: service, status: "UNHEALTHY" as const, healthy: false, error: "project credentials are unavailable" };
  if (service === "realtime") return { name: service, status: "ACTIVE_HEALTHY" as const, healthy: true };
  const path = service === "auth" ? "/auth/v1/health" : service === "rest" ? "/rest/v1/" : "/storage/v1/status";
  const result = await endpoint(`http://${getConfig().projectHost}:${project.ports.api}${path}`, { apikey: credentials.SERVICE_ROLE_KEY, Authorization: `Bearer ${credentials.SERVICE_ROLE_KEY}` });
  return result.ok ? { name: service, status: "ACTIVE_HEALTHY" as const, healthy: true } : { name: service, status: "UNHEALTHY" as const, healthy: false, error: `${service} endpoint returned ${result.status || "unreachable"}` };
}

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const project = getRepository().getProject((await params).projectId as ProjectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const credentials = await loadProjectCredentials(project.id).catch(() => null);
  const services = await Promise.all(requestedServices(request).map((service) => checkService(new DirectCommandRunner(), project, service, credentials)));
  return Response.json(services, { headers: { "Cache-Control": "no-store, private" } });
}
