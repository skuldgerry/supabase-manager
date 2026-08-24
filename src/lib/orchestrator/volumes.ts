import { labelsForProject, volumeName } from "./naming";
import type { HostDriver, ProjectIdentity, ProjectId } from "./types";

export type VolumePurpose =
  | "postgres"
  | "storage"
  | "functions"
  | "snippets"
  | "db_config"
  | "deno_cache"
  | "db_init"
  | "envoy"
  | "pooler"
  | "vector";

export interface PlannedVolume {
  readonly purpose: VolumePurpose;
  readonly name: string;
  readonly persistent: boolean;
  readonly releaseScoped: boolean;
}

const PERSISTENT: readonly VolumePurpose[] = ["postgres", "storage", "functions", "snippets", "db_config", "deno_cache"];
const CONFIG: readonly VolumePurpose[] = ["db_init", "envoy", "pooler"];

export function volumePlan(projectId: ProjectId, release: string): readonly PlannedVolume[] {
  return [
    ...PERSISTENT.map((purpose) => ({ purpose, name: volumeName(projectId, purpose), persistent: true, releaseScoped: false })),
    ...CONFIG.map((purpose) => ({ purpose, name: volumeName(projectId, purpose, release), persistent: false, releaseScoped: true })),
  ];
}

export async function ensureProjectVolumes(driver: HostDriver, identity: ProjectIdentity): Promise<readonly PlannedVolume[]> {
  const plan = volumePlan(identity.projectId, identity.release);
  const labels = labelsForProject(identity);
  const existing = new Set((await driver.listVolumes(labels)).map((volume) => volume.name));
  for (const volume of plan) if (!existing.has(volume.name)) await driver.createVolume(volume.name, labels);
  return plan;
}
