import { z } from "zod";
import { getRepository } from "@/lib/db/manager";
import type { ProjectId } from "@/lib/domain";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { internalProjectView } from "@/lib/internal/project-view";
import { scheduleDeploymentRecovery } from "@/lib/orchestrator/broker";

export const dynamic = "force-dynamic";
const bodySchema = z.object({ actorEmail: z.email(), mode: z.enum(["verify", "resume"]) });

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A deployment recovery mode and actor are required" }, { status: 400 });
  const repository = getRepository();
  const project = repository.getProject((await params).projectId as ProjectId);
  const actor = repository.getUserByEmail(parsed.data.actorEmail);
  if (!project || project.deletedAt) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!actor || !repository.canManageOrganization(project.organizationId, actor.id)) return Response.json({ error: "Organization manager permission required" }, { status: 403 });
  try {
    const job = repository.queueDeploymentRecovery(project.id, actor.id, parsed.data.mode);
    scheduleDeploymentRecovery(job.id);
    return Response.json(await internalProjectView(repository.getProject(project.id)!, job), { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Recovery could not be queued" }, { status: 409 });
  }
}
