import type { DurableJob, JobId, Project, ProjectId } from "@/lib/domain";
import { dockerProjectName } from "@/lib/domain";
import { getRepository } from "@/lib/db/manager";
import { decryptJson, getMasterKey, type EncryptedEnvelope } from "@/lib/security/encryption";
import { encryptJson } from "@/lib/security/encryption";

type ProjectCredentials = Record<string, string>;

export type ProjectAiSettings = {
  provider: "openai" | "compatible";
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
};

async function loadEncryptedValue<T>(projectId: ProjectId, name: string): Promise<T | null> {
  const stored = getRepository().getCredential(projectId, name);
  if (!stored) return null;
  const envelope: EncryptedEnvelope = {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: stored.nonceBase64,
    tag: stored.authTagBase64,
    ciphertext: stored.ciphertextBase64,
  };
  return decryptJson<T>(envelope, await getMasterKey(), stored.associatedData);
}

export async function loadProjectCredentials(projectId: ProjectId): Promise<ProjectCredentials | null> {
  return loadEncryptedValue<ProjectCredentials>(projectId, "project-credentials");
}

export async function loadProjectAiSettings(projectId: ProjectId): Promise<ProjectAiSettings | null> {
  return loadEncryptedValue<ProjectAiSettings>(projectId, "manager-ai-settings");
}

export async function saveProjectAiSettings(projectId: ProjectId, settings: ProjectAiSettings): Promise<void> {
  const associatedData = `${projectId}:manager-ai-settings`;
  const encrypted = encryptJson(settings, await getMasterKey(), associatedData);
  getRepository().upsertCredential({
    projectId,
    kind: "other",
    name: "manager-ai-settings",
    ciphertextBase64: encrypted.ciphertext,
    nonceBase64: encrypted.iv,
    authTagBase64: encrypted.tag,
    associatedData,
  });
}

export async function internalProjectView(project: Project, job?: DurableJob | null) {
  return {
    project: {
      ...project,
      dockerProject: dockerProjectName(project.id),
    },
    ...(job ? { job, events: getRepository().listJobEvents(job.id) } : {}),
    credentialsReady: Boolean(getRepository().getCredential(project.id, "project-credentials")),
  };
}

export async function internalJobView(jobId: JobId) {
  const repository = getRepository();
  const job = repository.getJob(jobId);
  if (!job?.projectId) return null;
  const project = repository.getProject(job.projectId);
  if (!project) return null;
  return internalProjectView(project, job);
}
