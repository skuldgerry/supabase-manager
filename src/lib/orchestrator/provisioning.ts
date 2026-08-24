import type { ProjectId, ProjectPorts } from "./types";

export const PROVISIONING_STAGES = [
  "validating",
  "reserving_ports",
  "preparing_release",
  "generating_credentials",
  "creating_volumes",
  "initializing_configuration",
  "pulling_images",
  "starting_database",
  "starting_services",
  "functional_checks",
  "ready",
] as const;
export type ProvisioningStage = (typeof PROVISIONING_STAGES)[number];
export type ProvisioningStatus = "queued" | "running" | "failed" | "cancelled" | "succeeded";

export interface ProvisioningJob {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly ports: ProjectPorts;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stage: ProvisioningStage;
  readonly status: ProvisioningStatus;
  readonly message?: string;
  readonly service?: string;
  readonly diagnosticId?: string;
}

export interface ProvisioningJobStore {
  save(job: ProvisioningJob): Promise<void>;
  get(id: string): Promise<ProvisioningJob | undefined>;
}

export function createProvisioningJob(id: string, projectId: ProjectId, ports: ProjectPorts, now = new Date()): ProvisioningJob {
  const timestamp = now.toISOString();
  return { id, projectId, ports, createdAt: timestamp, updatedAt: timestamp, stage: "validating", status: "queued" };
}

export async function advanceProvisioningJob(store: ProvisioningJobStore, job: ProvisioningJob, stage: ProvisioningStage, message?: string): Promise<ProvisioningJob> {
  if (job.status === "failed" || job.status === "cancelled" || job.status === "succeeded") throw new Error("job is terminal");
  const previousIndex = PROVISIONING_STAGES.indexOf(job.stage);
  const nextIndex = PROVISIONING_STAGES.indexOf(stage);
  if (nextIndex < previousIndex || nextIndex > previousIndex + 1) throw new Error(`invalid stage transition ${job.stage} -> ${stage}`);
  const status: ProvisioningStatus = stage === "ready" ? "succeeded" : "running";
  const next: ProvisioningJob = { ...job, stage, status, message, updatedAt: new Date().toISOString() };
  await store.save(next);
  return next;
}

export async function failProvisioningJob(store: ProvisioningJobStore, job: ProvisioningJob, message: string, diagnosticId?: string, service?: string): Promise<ProvisioningJob> {
  if (job.status === "succeeded" || job.status === "cancelled") throw new Error("job is terminal");
  const next: ProvisioningJob = { ...job, status: "failed", message, service, diagnosticId, updatedAt: new Date().toISOString() };
  await store.save(next);
  return next;
}
