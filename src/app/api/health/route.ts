import { getRepository } from "@/lib/db/manager";
import { scheduleProvisioning } from "@/lib/orchestrator/broker";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const repository = getRepository();
    for (const job of repository.listRunnableJobs()) scheduleProvisioning(job.id);
    return Response.json({ status: "healthy", setupComplete: repository.isSetupComplete() });
  } catch {
    return Response.json({ status: "unhealthy" }, { status: 503 });
  }
}
