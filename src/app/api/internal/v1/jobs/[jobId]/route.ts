import type { JobId } from "@/lib/domain";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { internalJobView } from "@/lib/internal/project-view";
import { getRepository } from "@/lib/db/manager";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const view = await internalJobView((await params).jobId as JobId);
  const actorEmail = new URL(request.url).searchParams.get("actorEmail");
  if (view && actorEmail) {
    const repository = getRepository();
    const actor = repository.getUserByEmail(actorEmail);
    if (!actor || !repository.canManageOrganization(view.project.organizationId, actor.id)) return Response.json({ error: "Organization manager permission required" }, { status: 403 });
  }
  // Token-only internal status synchronizers do not need log contents.
  if (view && !actorEmail) view.events = view.events?.map((event) => ({ ...event, details: {} }));
  return view
    ? Response.json(view, { headers: { "Cache-Control": "no-store" } })
    : Response.json({ error: "Job not found" }, { status: 404 });
}
