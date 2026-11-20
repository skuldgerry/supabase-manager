import { z } from "zod";
import { getRepository } from "@/lib/db/manager";
import type { ProjectId } from "@/lib/domain";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";

export const dynamic = "force-dynamic";
const querySchema = z.object({
  actorEmail: z.email(),
  targetOrganizationSlug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
});

/** Authoritative authorization only. Supabase credentials stay in the broker. */
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return Response.json({ error: "Invalid migration access request" }, { status: 400 });
  const repository = getRepository();
  const actor = repository.getUserByEmail(query.data.actorEmail);
  const project = repository.getProject((await params).projectId as ProjectId);
  if (!actor || actor.status !== "active") return Response.json({ error: "Active administrator required" }, { status: 403 });
  if (!project || project.deletedAt) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!repository.canManageOrganization(project.organizationId, actor.id)) {
    return Response.json({ error: "Organization manager permission required" }, { status: 403 });
  }
  if (query.data.targetOrganizationSlug) {
    const targetOrganization = repository.listOrganizations().find((organization) => organization.slug === query.data.targetOrganizationSlug);
    if (!targetOrganization || !repository.canManageOrganization(targetOrganization.id, actor.id)) {
      return Response.json({ error: "PocketBase organization manager permission required" }, { status: 403 });
    }
  }
  if (project.status !== "ready") return Response.json({ error: "Project is not ready for migration" }, { status: 409 });
  return Response.json({ projectId: project.id }, { headers: { "Cache-Control": "no-store, private" } });
}
