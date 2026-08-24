import type { ProjectIdentity, ProjectId } from "./types";

export const MANAGER_LABEL = "com.supabase-manager.managed";
export const PROJECT_LABEL = "com.supabase-manager.project-id";
export const ORGANIZATION_LABEL = "com.supabase-manager.organization-id";
export const RELEASE_LABEL = "com.supabase-manager.release";

/** Docker-safe identity derived only from the immutable project UUID. */
export function dockerProjectName(projectId: ProjectId): string {
  return `sm_${projectId.replaceAll("-", "")}`;
}

export function projectNetworkName(projectId: ProjectId): string {
  return `${dockerProjectName(projectId)}_network`;
}

export function projectContainerName(projectId: ProjectId, service: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(service)) throw new Error("service must be Docker-name safe");
  return `${dockerProjectName(projectId)}_${service}`;
}

export function labelsForProject(identity: ProjectIdentity): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {
    [MANAGER_LABEL]: "true",
    [PROJECT_LABEL]: identity.projectId,
    [RELEASE_LABEL]: identity.release,
  };
  if (identity.organizationId) labels[ORGANIZATION_LABEL] = identity.organizationId;
  return Object.freeze(labels);
}

export function volumeName(projectId: ProjectId, purpose: string, release?: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(purpose)) throw new Error("volume purpose must be name safe");
  const suffix = release ? `_${release.replace(/[^a-z0-9_.-]/gi, "_")}` : "";
  return `${dockerProjectName(projectId)}_${purpose}${suffix}`;
}
