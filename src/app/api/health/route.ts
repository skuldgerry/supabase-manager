import { getRepository } from "@/lib/db/manager";
import { scheduleDeletion, scheduleProvisioning } from "@/lib/orchestrator/broker";
import { scheduleLifecycle } from "@/lib/orchestrator/lifecycle";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const repository = getRepository();
    for (const job of repository.listRunnableJobs()) {
      if (job.type === "create-project") scheduleProvisioning(job.id);
      if (job.type === "delete-project") scheduleDeletion(job.id);
      if (["start-project", "stop-project", "restart-project"].includes(job.type)) scheduleLifecycle(job.id);
    }
    return Response.json({ status: "healthy", setupComplete: repository.isSetupComplete() });
  } catch {
    return Response.json({ status: "unhealthy" }, { status: 503 });
  }
}
