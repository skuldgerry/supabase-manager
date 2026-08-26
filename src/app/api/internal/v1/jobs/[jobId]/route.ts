import type { JobId } from "@/lib/domain";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { internalJobView } from "@/lib/internal/project-view";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const view = await internalJobView((await params).jobId as JobId);
  return view
    ? Response.json(view, { headers: { "Cache-Control": "no-store" } })
    : Response.json({ error: "Job not found" }, { status: 404 });
}
