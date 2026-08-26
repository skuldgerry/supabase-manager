import ManagerShell, { type ManagerShellProps } from "@/components/ManagerShell";
import { getAuthenticatedSession } from "@/lib/auth/session";
import { getRepository } from "@/lib/db/manager";
import type { JobId } from "@/lib/domain";
import { scheduleProvisioning } from "@/lib/orchestrator/broker";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ job?: string }>;
};

export default async function Home({ searchParams }: PageProps) {
  const repository = getRepository();
  const setupComplete = repository.isSetupComplete();
  const authenticated = setupComplete ? await getAuthenticatedSession() : null;

  if (!setupComplete) {
    return <ManagerShell initialScreen="setup" user={null} organizations={[]} projects={[]} />;
  }
  if (!authenticated) {
    return <ManagerShell initialScreen="login" user={null} organizations={[]} projects={[]} />;
  }

  const organizations = repository.listOrganizations(authenticated.user.id).map((organization) => ({
    id: organization.id,
    name: organization.name,
    initials: organization.name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join(""),
    role: "Owner",
  }));
  const projects = repository.listProjects().filter((project) =>
    organizations.some((organization) => organization.id === project.organizationId),
  ).map((project) => ({
    id: project.id,
    organizationId: project.organizationId,
    name: project.name,
    status: project.status,
    ownership: project.ownership,
    publicUrl: project.publicUrl,
    apiPort: project.ports.api,
    databaseSessionPort: project.ports.dbSession,
    databaseTransactionPort: project.ports.dbTransaction,
    release: project.stackRelease,
  }));

  const { job: requestedJobId } = await searchParams;
  const job = requestedJobId ? repository.getJob(requestedJobId as JobId) : null;
  if (job && (job.status === "queued" || job.status === "running")) scheduleProvisioning(job.id);
  const jobEvents = job ? repository.listJobEvents(job.id).map((event) => ({
    sequence: event.sequence,
    stage: event.stage,
    level: event.level,
    message: event.message,
    createdAt: event.createdAt,
  })) : [];
  const props: ManagerShellProps = {
    initialScreen: job ? "deployment" : "dashboard",
    user: { displayName: authenticated.user.displayName, email: authenticated.user.email },
    organizations,
    projects,
    activeJob: job ? {
      id: job.id,
      projectId: job.projectId,
      status: job.status,
      stage: job.stage,
      errorMessage: job.errorMessage,
      events: jobEvents,
    } : undefined,
  };
  return <ManagerShell {...props} />;
}
