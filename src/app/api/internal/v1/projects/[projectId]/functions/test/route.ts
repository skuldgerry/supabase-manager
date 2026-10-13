import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getRepository } from "@/lib/db/manager";
import type { ProjectId } from "@/lib/domain";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { FunctionTestError, invokeProjectFunction } from "@/lib/internal/function-invocation";
import { loadProjectCredentials } from "@/lib/internal/project-view";
import { verifyExternalGatewayOwnership } from "@/lib/orchestrator/external-adoption";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  actorEmail: z.email(),
  url: z.string().max(4096),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().max(1024 * 1024).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid function test request" }, { status: 400 });
  const repository = getRepository();
  try {
    return await invokeProjectFunction({
      ...parsed.data, projectId: (await params).projectId as ProjectId,
    }, {
      projectHost: getConfig().projectHost,
      getProject(id) {
        const project = repository.getProject(id);
        return project ? { ...project, apiPort: project.ports.api } : undefined;
      },
      canInvoke(project, email) {
        const actor = repository.getUserByEmail(email);
        const stored = repository.getProject(project.id);
        return Boolean(actor?.status === "active" && stored && repository.listOrganizations(actor.id).some((organization) => organization.id === stored.organizationId));
      },
      async verifyExternal(project) {
        const credentials = await loadProjectCredentials(project.id);
        const composeProject = credentials?.EXTERNAL_DOCKER_PROJECT;
        return Boolean(composeProject && await verifyExternalGatewayOwnership(project.apiPort, composeProject));
      },
      fetch,
    });
  } catch (error) {
    return Response.json({
      error: error instanceof FunctionTestError ? error.message : "Project function is unreachable",
    }, { status: error instanceof FunctionTestError ? error.status : 502 });
  }
}
