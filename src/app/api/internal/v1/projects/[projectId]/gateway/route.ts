import { z } from "zod";
import { getRepository } from "@/lib/db/manager";
import type { ProjectId } from "@/lib/domain";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { loadProjectCredentials } from "@/lib/internal/project-view";
import { getConfig } from "@/lib/config";
import { verifyExternalGatewayOwnership } from "@/lib/orchestrator/external-adoption";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  path: z.string().startsWith("/").max(4096),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

const ALLOWED_PREFIXES = ["/pg", "/rest/v1", "/auth/v1", "/storage/v1", "/graphql/v1"];
const FORWARDED_REQUEST_HEADERS = new Set(["accept", "content-type", "range", "prefer", "x-client-info"]);
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-range", "range", "preference-applied"];

function allowedPath(value: string): boolean {
  try {
    const parsed = new URL(value, "http://manager.internal");
    return parsed.origin === "http://manager.internal"
      && ALLOWED_PREFIXES.some((prefix) => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`));
  } catch {
    return false;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !allowedPath(parsed.data.path)) {
    return Response.json({ error: "Unsupported project gateway request" }, { status: 400 });
  }

  const project = getRepository().getProject((await params).projectId as ProjectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (project.status !== "ready") {
    return Response.json({ error: "Project is not ready" }, { status: 409 });
  }

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
  for (const [name, value] of Object.entries(parsed.data.headers ?? {})) {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set("apikey", serviceRoleKey);
  headers.set("authorization", `Bearer ${serviceRoleKey}`);

  try {
    const upstream = await fetch(`http://${getConfig().projectHost}:${project.ports.api}${parsed.data.path}`, {
      method: parsed.data.method,
      headers,
      body: parsed.data.method === "GET" ? undefined : parsed.data.body,
      redirect: "manual",
      cache: "no-store",
    });
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ error: "Project service is unreachable" }, { status: 502 });
  }
}
