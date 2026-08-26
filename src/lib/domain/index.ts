/**
 * Control-plane domain contracts.
 *
 * Values in this module are persistence/API-neutral.  Secrets are represented
 * by encrypted envelopes only; plaintext secret values must never cross this
 * boundary or be written to job events.
 */

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type UserId = Brand<string, "UserId">;
export type SessionId = Brand<string, "SessionId">;
export type OrganizationId = Brand<string, "OrganizationId">;
export type MembershipId = Brand<string, "MembershipId">;
export type HostId = Brand<string, "HostId">;
export type ProjectId = Brand<string, "ProjectId">;
export type PortReservationId = Brand<string, "PortReservationId">;
export type CredentialSetId = Brand<string, "CredentialSetId">;
export type VolumeId = Brand<string, "VolumeId">;
export type JobId = Brand<string, "JobId">;
export type JobEventId = Brand<string, "JobEventId">;
export type Timestamp = string;

export type OrganizationRole = "owner" | "admin" | "member" | "viewer";
export type UserStatus = "active" | "disabled";
export type SessionStatus = "active" | "revoked";

export interface User {
  readonly id: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly status: UserStatus;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface Session {
  readonly id: SessionId;
  readonly userId: UserId;
  /** Hash of the bearer token; the raw token is returned only at login. */
  readonly tokenHash: string;
  readonly status: SessionStatus;
  readonly expiresAt: Timestamp;
  readonly lastSeenAt: Timestamp;
  readonly createdAt: Timestamp;
  readonly revokedAt: Timestamp | null;
}

export interface Organization {
  readonly id: OrganizationId;
  readonly name: string;
  readonly slug: string;
  readonly createdBy: UserId;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface OrganizationMembership {
  readonly id: MembershipId;
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly role: OrganizationRole;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export type HostStatus = "active" | "offline" | "degraded" | "disabled";

export interface Host {
  readonly id: HostId;
  readonly name: string;
  /** v1 supports the manager's local Docker Engine. */
  readonly driver: "local-docker";
  readonly dockerSocketPath: string;
  readonly status: HostStatus;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly lastHealthCheckAt: Timestamp | null;
}

export type ProjectStatus =
  | "provisioning"
  | "ready"
  | "stopped"
  | "failed"
  | "deleting";

/** Whether the manager is allowed to mutate Docker resources for a project. */
export type ProjectOwnership = "manager-owned" | "external";

export type ProjectEndpoint =
  | "api"
  | "db-session"
  | "db-transaction";

export interface ProjectPorts {
  readonly api: number;
  readonly dbSession: number;
  readonly dbTransaction: number;
}

export interface Project {
  /** Immutable UUID-like identifier. Names and organization ownership may change. */
  readonly id: ProjectId;
  readonly organizationId: OrganizationId;
  readonly hostId: HostId;
  readonly name: string;
  readonly slug: string;
  readonly status: ProjectStatus;
  readonly ownership: ProjectOwnership;
  readonly stackRelease: string;
  readonly publicUrl: string;
  readonly siteUrl: string;
  readonly ports: ProjectPorts;
  readonly databaseUsername: string;
  readonly dashboardUsername: string;
  readonly createdBy: UserId;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly readyAt: Timestamp | null;
  readonly deletedAt: Timestamp | null;
}

export type PortReservationStatus = "held" | "active" | "released";

export interface PortReservation {
  readonly id: PortReservationId;
  readonly hostId: HostId;
  readonly projectId: ProjectId | null;
  readonly endpoint: ProjectEndpoint;
  readonly hostAddress: string;
  readonly port: number;
  readonly status: PortReservationStatus;
  readonly expiresAt: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly releasedAt: Timestamp | null;
}

export type CredentialKind =
  | "project-api"
  | "database"
  | "jwt"
  | "dashboard"
  | "storage"
  | "other";

export interface CredentialMetadata {
  readonly id: CredentialSetId;
  readonly projectId: ProjectId;
  readonly kind: CredentialKind;
  /** Stable name shown in the credentials UI, never the secret value. */
  readonly name: string;
  readonly algorithm: "aes-256-gcm";
  readonly keyVersion: number;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface EncryptedCredential {
  readonly metadata: CredentialMetadata;
  readonly ciphertextBase64: string;
  readonly nonceBase64: string;
  readonly authTagBase64: string;
  /** Bound to project and credential name to prevent envelope swapping. */
  readonly associatedData: string;
}

export type JobType =
  | "create-project"
  | "start-project"
  | "stop-project"
  | "restart-project"
  | "delete-project"
  | "check-project";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type DeploymentStage =
  | "validating"
  | "reserving-ports"
  | "preparing-release"
  | "generating-credentials"
  | "creating-volumes"
  | "initializing-configuration"
  | "pulling-images"
  | "starting-database"
  | "starting-services"
  | "functional-checks"
  | "ready"
  | "stopping-services"
  | "removing-containers"
  | "removing-volumes"
  | "removing-configuration"
  | "deleted";

export interface DurableJob {
  readonly id: JobId;
  readonly type: JobType;
  readonly projectId: ProjectId | null;
  readonly requestedBy: UserId;
  readonly status: JobStatus;
  readonly stage: DeploymentStage | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Safe, user-facing error code/message. Never include credentials. */
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: Timestamp;
  readonly startedAt: Timestamp | null;
  readonly finishedAt: Timestamp | null;
}

export interface JobEvent {
  readonly id: JobEventId;
  readonly jobId: JobId;
  readonly sequence: number;
  readonly stage: DeploymentStage | null;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  /** Structured, sanitized details suitable for the UI. */
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
  readonly createdAt: Timestamp;
}

export type VolumeKind = "persistent" | "configuration" | "cache";
export type VolumeStatus = "expected" | "present" | "missing" | "orphaned";

export interface VolumeInventory {
  readonly id: VolumeId;
  readonly projectId: ProjectId;
  readonly dockerName: string;
  readonly kind: VolumeKind;
  readonly purpose: string;
  readonly stackRelease: string;
  readonly status: VolumeStatus;
  readonly createdAt: Timestamp;
  readonly lastSeenAt: Timestamp | null;
}

export type OrganizationTransferStatus = "pending" | "completed" | "cancelled";

export interface OrganizationTransfer {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly fromOrganizationId: OrganizationId;
  readonly toOrganizationId: OrganizationId;
  readonly requestedBy: UserId;
  readonly status: OrganizationTransferStatus;
  readonly createdAt: Timestamp;
  readonly completedAt: Timestamp | null;
}

/**
 * An organization transfer changes only project metadata and authorization.
 * Docker project IDs, networks, volumes, ports, credentials, and host remain
 * unchanged. Both organizations must authorize the transfer before completion.
 */
export interface OrganizationTransferContract {
  readonly transfer: OrganizationTransfer;
  readonly sourceApprovalBy: UserId;
  readonly destinationApprovalBy: UserId;
}

export function dockerProjectName(projectId: ProjectId): string {
  return `sm_${projectId.replaceAll("-", "")}`;
}

export function dockerVolumeName(projectId: ProjectId, purpose: string): string {
  const safePurpose = purpose.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!safePurpose) throw new Error("Volume purpose must contain at least one alphanumeric character");
  return `${dockerProjectName(projectId)}_${safePurpose}`;
}

export function canTransferProject(
  sourceRole: OrganizationRole,
  destinationRole: OrganizationRole,
): boolean {
  const canSourceApprove = sourceRole === "owner" || sourceRole === "admin";
  const canDestinationApprove = destinationRole === "owner" || destinationRole === "admin";
  return canSourceApprove && canDestinationApprove;
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
