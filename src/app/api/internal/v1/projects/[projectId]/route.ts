import { z } from "zod";
import { getRepository } from "@/lib/db/manager";
import type { ProjectId } from "@/lib/domain";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { internalProjectView } from "@/lib/internal/project-view";
import { scheduleDeletion } from "@/lib/orchestrator/broker";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ actorEmail: z.email(), confirmName: z.string().trim().min(1) });

export async function DELETE(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  const repository = getRepository();
  const project = repository.getProject((await params).projectId as ProjectId);
  const actor = repository.getUserByEmail(parsed.data.actorEmail);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (project.name !== parsed.data.confirmName) return Response.json({ error: "Project name confirmation does not match" }, { status: 409 });
  if (!actor || !repository.canManageOrganization(project.organizationId, actor.id)) {
    return Response.json({ error: "Organization manager permission required" }, { status: 403 });
  }
  try {
    const job = repository.queueProjectDeletion(project.id, actor.id);
    scheduleDeletion(job.id);
    return Response.json(await internalProjectView(repository.getProject(project.id)!, job), { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Project deletion could not be queued" }, { status: 409 });
  }
}
