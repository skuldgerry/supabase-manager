import { getRepository } from "@/lib/db/manager";
import type { ProjectId } from "@/lib/domain";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { loadProjectCredentials } from "@/lib/internal/project-view";
import { getConfig } from "@/lib/config";
import { verifyExternalGatewayOwnership } from "@/lib/orchestrator/external-adoption";

export const dynamic = "force-dynamic";

const ALLOWED_PREFIXES = ["pg", "rest/v1", "auth/v1", "storage/v1", "graphql/v1"];
const FORWARDED_REQUEST_HEADERS = new Set(["accept", "content-type", "range", "prefer", "x-client-info"]);
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-range", "range", "preference-applied"];

async function proxyProjectRequest(
  request: Request,
  context: { params: Promise<{ projectId: string; path: string[] }> },
): Promise<Response> {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const { projectId, path } = await context.params;
  const relativePath = path.join("/");
  if (!ALLOWED_PREFIXES.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) {
    return Response.json({ error: "Unsupported project proxy path" }, { status: 400 });
  }

  const project = getRepository().getProject(projectId as ProjectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (project.status !== "ready") return Response.json({ error: "Project is not ready" }, { status: 409 });

  const credentials = await loadProjectCredentials(project.id);
  const serviceRoleKey = credentials?.SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return Response.json({ error: "Project credentials are unavailable" }, { status: 409 });
  if (project.ownership === "external") {
    const expectedComposeProject = credentials?.EXTERNAL_DOCKER_PROJECT;
    if (!expectedComposeProject || !(await verifyExternalGatewayOwnership(project.ports.api, expectedComposeProject))) {
      return Response.json({ error: "The imported project's local API port no longer matches its verified Compose deployment" }, { status: 409 });
    }
  }

  const headers = new Headers();
  for (const [name, value] of request.headers.entries()) {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set("apikey", serviceRoleKey);
  headers.set("authorization", `Bearer ${serviceRoleKey}`);

  try {
    const sourceUrl = new URL(request.url);
    const upstream = await fetch(
      `http://${getConfig().projectHost}:${project.ports.api}/${relativePath}${sourceUrl.search}`,
      {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
        redirect: "manual",
        cache: "no-store",
      },
    );
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(request.method === "HEAD" ? null : await upstream.arrayBuffer(), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ error: "Project service is unreachable" }, { status: 502 });
  }
}

export const GET = proxyProjectRequest;
export const HEAD = proxyProjectRequest;
export const POST = proxyProjectRequest;
export const PUT = proxyProjectRequest;
export const PATCH = proxyProjectRequest;
export const DELETE = proxyProjectRequest;
