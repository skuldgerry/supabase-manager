import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./index";
import type {
  DurableJob,
  CredentialKind,
  EncryptedCredential,
  CredentialSetId,
  DeploymentStage,
  Host,
  HostId,
  HostStatus,
  JobEvent,
  JobEventId,
  JobId,
  JobStatus,
  JobType,
  Organization,
  OrganizationId,
  OrganizationMembership,
  MembershipId,
  OrganizationRole,
  OrganizationTransfer,
  OrganizationTransferStatus,
  Project,
  ProjectOwnership,
  ProjectId,
  ProjectPorts,
  ProjectStatus,
  Session,
  SessionId,
  SessionStatus,
  Timestamp,
  User,
  UserId,
  VolumeInventory,
} from "../domain";

type Id<T> = T;

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  status: SessionStatus;
  expires_at: string;
  last_seen_at: string;
  created_at: string;
  revoked_at: string | null;
}

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface MembershipRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
  created_at: string;
  updated_at: string;
}

interface HostRow {
  id: string;
  name: string;
  driver: "local-docker";
  docker_socket_path: string;
  status: HostStatus;
  created_at: string;
  updated_at: string;
  last_health_check_at: string | null;
}

interface ProjectRow {
  id: string;
  organization_id: string;
  host_id: string;
  name: string;
  slug: string;
  status: ProjectStatus;
  ownership: ProjectOwnership;
  stack_release: string;
  public_url: string;
  site_url: string;
  api_port: number;
  db_session_port: number;
  db_transaction_port: number;
  database_username: string;
  dashboard_username: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
  deleted_at: string | null;
}

interface JobRow {
  id: string;
  type: JobType;
  project_id: string | null;
  requested_by: string;
  status: JobStatus;
  stage: DeploymentStage | null;
  attempt: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface JobEventRow {
  id: string;
  job_id: string;
  sequence: number;
  stage: DeploymentStage | null;
  level: "info" | "warning" | "error";
  message: string;
  details_json: string;
  created_at: string;
}

interface CredentialRow {
  id: string;
  project_id: string;
  kind: CredentialKind;
  name: string;
  algorithm: "aes-256-gcm";
  key_version: number;
  ciphertext_base64: string;
  nonce_base64: string;
  auth_tag_base64: string;
  associated_data: string;
  created_at: string;
  updated_at: string;
}

interface VolumeRow {
  id: string;
  project_id: string;
  docker_name: string;
  kind: VolumeInventory["kind"];
  purpose: string;
  stack_release: string;
  status: VolumeInventory["status"];
  created_at: string;
  last_seen_at: string | null;
}

const now = (): Timestamp => new Date().toISOString();
const id = <T extends string>(): Id<T> => randomUUID() as Id<T>;

function required(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function email(value: string): string {
  const normalized = required(value, "email").toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalized)) throw new Error("email is invalid");
  return normalized;
}

function slug(value: string): string {
  const normalized = required(value, "slug").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) throw new Error("slug is invalid");
  return normalized;
}

function mapUser(row: UserRow): User {
  return { id: row.id as UserId, email: row.email, displayName: row.display_name, passwordHash: row.password_hash, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapSession(row: SessionRow): Session {
  return { id: row.id as SessionId, userId: row.user_id as UserId, tokenHash: row.token_hash, status: row.status, expiresAt: row.expires_at, lastSeenAt: row.last_seen_at, createdAt: row.created_at, revokedAt: row.revoked_at };
}

function mapOrganization(row: OrganizationRow): Organization {
  return { id: row.id as OrganizationId, name: row.name, slug: row.slug, createdBy: row.created_by as UserId, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapMembership(row: MembershipRow): OrganizationMembership {
  return { id: row.id as MembershipId, organizationId: row.organization_id as OrganizationId, userId: row.user_id as UserId, role: row.role, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapHost(row: HostRow): Host {
  return { id: row.id as HostId, name: row.name, driver: row.driver, dockerSocketPath: row.docker_socket_path, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, lastHealthCheckAt: row.last_health_check_at };
}

function mapProject(row: ProjectRow): Project {
  const ports: ProjectPorts = { api: row.api_port, dbSession: row.db_session_port, dbTransaction: row.db_transaction_port };
  return { id: row.id as ProjectId, organizationId: row.organization_id as OrganizationId, hostId: row.host_id as HostId, name: row.name, slug: row.slug, status: row.status, ownership: row.ownership, stackRelease: row.stack_release, publicUrl: row.public_url, siteUrl: row.site_url, ports, databaseUsername: row.database_username, dashboardUsername: row.dashboard_username, createdBy: row.created_by as UserId, createdAt: row.created_at, updatedAt: row.updated_at, readyAt: row.ready_at, deletedAt: row.deleted_at };
}

function mapJob(row: JobRow): DurableJob {
  return { id: row.id as JobId, type: row.type, projectId: row.project_id as ProjectId | null, requestedBy: row.requested_by as UserId, status: row.status, stage: row.stage, attempt: row.attempt, maxAttempts: row.max_attempts, errorCode: row.error_code, errorMessage: row.error_message, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at };
}

function mapJobEvent(row: JobEventRow): JobEvent {
  let details: Record<string, string | number | boolean | null> = {};
  try {
    const parsed: unknown = JSON.parse(row.details_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed as Record<string, string | number | boolean | null>;
  } catch {
    // A malformed detail payload must not prevent diagnostics from loading.
  }
  return { id: row.id as JobEventId, jobId: row.job_id as JobId, sequence: row.sequence, stage: row.stage, level: row.level, message: row.message, details, createdAt: row.created_at };
}

function mapCredential(row: CredentialRow): EncryptedCredential {
  return {
    metadata: {
      id: row.id as CredentialSetId,
      projectId: row.project_id as ProjectId,
      kind: row.kind,
      name: row.name,
      algorithm: row.algorithm,
      keyVersion: row.key_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    ciphertextBase64: row.ciphertext_base64,
    nonceBase64: row.nonce_base64,
    authTagBase64: row.auth_tag_base64,
    associatedData: row.associated_data,
  };
}

function mapVolume(row: VolumeRow): VolumeInventory {
  return {
    id: row.id as VolumeInventory["id"],
    projectId: row.project_id as ProjectId,
    dockerName: row.docker_name,
    kind: row.kind,
    purpose: row.purpose,
    stackRelease: row.stack_release,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export interface CreateFirstAdminInput { readonly email: string; readonly displayName: string; readonly passwordHash: string; }
export interface BootstrapControlPlaneInput extends CreateFirstAdminInput {
  readonly organizationName: string;
  readonly organizationSlug: string;
}
export interface CreateSessionInput { readonly userId: UserId; readonly tokenHash: string; readonly expiresAt: Timestamp; }
export interface BootstrapHostInput { readonly name?: string; readonly dockerSocketPath?: string; }
export interface CreateOrganizationInput { readonly name: string; readonly slug: string; readonly createdBy: UserId; }
export interface CreateProjectInput { readonly organizationId: OrganizationId; readonly hostId: HostId; readonly name: string; readonly slug: string; readonly stackRelease: string; readonly publicUrl?: string; readonly siteUrl?: string; readonly ports: ProjectPorts; readonly databaseUsername: string; readonly dashboardUsername: string; readonly createdBy: UserId; readonly ownership?: ProjectOwnership; }
export interface AdoptExternalProjectInput extends CreateProjectInput { readonly ownership: "external"; }
export interface CreateJobInput { readonly type: JobType; readonly projectId?: ProjectId | null; readonly requestedBy: UserId; readonly maxAttempts?: number; }
export interface AppendJobEventInput { readonly jobId: JobId; readonly stage?: DeploymentStage | null; readonly level: "info" | "warning" | "error"; readonly message: string; readonly details?: Readonly<Record<string, string | number | boolean | null>>; }
export interface TransferProjectInput { readonly projectId: ProjectId; readonly toOrganizationId: OrganizationId; readonly requestedBy: UserId; readonly destinationApprovedBy: UserId; }
export interface CreateProjectDeploymentInput extends CreateProjectInput { readonly reservationTtlMinutes?: number; }
export interface UpsertCredentialInput {
  readonly projectId: ProjectId;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly ciphertextBase64: string;
  readonly nonceBase64: string;
  readonly authTagBase64: string;
  readonly associatedData: string;
}
export interface RecordVolumeInput {
  readonly projectId: ProjectId;
  readonly dockerName: string;
  readonly kind: "persistent" | "configuration" | "cache";
  readonly purpose: string;
  readonly stackRelease: string;
}

export class ControlPlaneRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public isSetupComplete(): boolean {
    return (this.db.prepare("SELECT 1 AS present FROM users LIMIT 1").get() as { present: number } | undefined)?.present === 1;
  }

  public createFirstAdmin(input: CreateFirstAdminInput): User {
    const created = now();
    return this.db.transaction(() => {
      if (this.isSetupComplete()) throw new Error("setup is already complete");
      const userId = id<UserId>();
      this.db.prepare("INSERT INTO users (id, email, display_name, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)").run(userId, email(input.email), required(input.displayName, "displayName"), required(input.passwordHash, "passwordHash"), created, created);
      return mapUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow);
    }).immediate();
  }

  /**
   * Creates the first manager account and its initial organization together.
   *
   * The organization is part of initial setup rather than a second UI step so
   * a successful login always has a workspace context. The transaction also
   * means a failure while creating the organization or owner membership cannot
   * leave a partially initialized control plane behind.
   */
  public bootstrapControlPlane(input: BootstrapControlPlaneInput): {
    user: User;
    organization: Organization;
    ownerMembership: OrganizationMembership;
  } {
    const timestamp = now();
    return this.db.transaction(() => {
      if (this.isSetupComplete()) throw new Error("setup is already complete");

      const userId = id<UserId>();
      this.db.prepare("INSERT INTO users (id, email, display_name, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)")
        .run(userId, email(input.email), required(input.displayName, "displayName"), required(input.passwordHash, "passwordHash"), timestamp, timestamp);

      const organizationId = id<OrganizationId>();
      this.db.prepare("INSERT INTO organizations (id, name, slug, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(organizationId, required(input.organizationName, "organizationName"), slug(input.organizationSlug), userId, timestamp, timestamp);

      const membershipId = id<MembershipId>();
      this.db.prepare("INSERT INTO organization_memberships (id, organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)")
        .run(membershipId, organizationId, userId, timestamp, timestamp);

      return {
        user: mapUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow),
        organization: mapOrganization(this.db.prepare("SELECT * FROM organizations WHERE id = ?").get(organizationId) as OrganizationRow),
        ownerMembership: mapMembership(this.db.prepare("SELECT * FROM organization_memberships WHERE id = ?").get(membershipId) as MembershipRow),
      };
    }).immediate();
  }

  public getUserById(userId: UserId): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  public getUserByEmail(value: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email(value)) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  public createSession(input: CreateSessionInput): Session {
    const timestamp = now();
    const sessionId = id<SessionId>();
    this.db.prepare("INSERT INTO sessions (id, user_id, token_hash, status, expires_at, last_seen_at, created_at) VALUES (?, ?, ?, 'active', ?, ?, ?)").run(sessionId, input.userId, required(input.tokenHash, "tokenHash"), input.expiresAt, timestamp, timestamp);
    return mapSession(this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow);
  }

  public getSessionByTokenHash(tokenHash: string, at: Timestamp = now()): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ? AND status = 'active' AND expires_at > ?").get(required(tokenHash, "tokenHash"), at) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  public revokeSession(sessionId: SessionId): boolean {
    return this.db.prepare("UPDATE sessions SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'").run(now(), sessionId).changes === 1;
  }

  public bootstrapLocalHost(input: BootstrapHostInput = {}): Host {
    const hostName = input.name?.trim() || "local";
    const socket = input.dockerSocketPath?.trim() || "/var/run/docker.sock";
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM hosts WHERE name = ?").get(hostName) as HostRow | undefined;
      if (existing) return mapHost(existing);
      const hostId = id<HostId>();
      const timestamp = now();
      this.db.prepare("INSERT INTO hosts (id, name, driver, docker_socket_path, status, created_at, updated_at) VALUES (?, ?, 'local-docker', ?, 'active', ?, ?)").run(hostId, hostName, socket, timestamp, timestamp);
      return mapHost(this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(hostId) as HostRow);
    })();
  }

  public listHosts(): readonly Host[] {
    return (this.db.prepare("SELECT * FROM hosts ORDER BY name").all() as HostRow[]).map(mapHost);
  }

  public listReservedPorts(hostId?: HostId): readonly number[] {
    const timestamp = now();
    this.db.prepare("UPDATE port_reservations SET status = 'released', released_at = ? WHERE status = 'held' AND expires_at IS NOT NULL AND expires_at <= ?")
      .run(timestamp, timestamp);
    const rows = hostId
      ? this.db.prepare("SELECT DISTINCT port FROM port_reservations WHERE host_id = ? AND status IN ('held', 'active') ORDER BY port").all(hostId)
      : this.db.prepare("SELECT DISTINCT port FROM port_reservations WHERE status IN ('held', 'active') ORDER BY port").all();
    return (rows as Array<{ port: number }>).map((row) => row.port);
  }

  public createOrganization(input: CreateOrganizationInput): { organization: Organization; ownerMembership: OrganizationMembership } {
    const timestamp = now();
    return this.db.transaction(() => {
      const organizationId = id<OrganizationId>();
      this.db.prepare("INSERT INTO organizations (id, name, slug, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(organizationId, required(input.name, "name"), slug(input.slug), input.createdBy, timestamp, timestamp);
      const membershipId = id<MembershipId>();
      this.db.prepare("INSERT INTO organization_memberships (id, organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)").run(membershipId, organizationId, input.createdBy, timestamp, timestamp);
      return {
        organization: mapOrganization(this.db.prepare("SELECT * FROM organizations WHERE id = ?").get(organizationId) as OrganizationRow),
        ownerMembership: mapMembership(this.db.prepare("SELECT * FROM organization_memberships WHERE id = ?").get(membershipId) as MembershipRow),
      };
    })();
  }

  public listOrganizations(userId?: UserId): readonly Organization[] {
    const rows = userId
      ? this.db.prepare("SELECT o.* FROM organizations o JOIN organization_memberships m ON m.organization_id = o.id WHERE m.user_id = ? ORDER BY o.name").all(userId)
      : this.db.prepare("SELECT * FROM organizations ORDER BY name").all();
    return (rows as OrganizationRow[]).map(mapOrganization);
  }

  public canManageOrganization(organizationId: OrganizationId, userId: UserId): boolean {
    const row = this.db.prepare("SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?")
      .get(organizationId, userId) as { role: OrganizationRole } | undefined;
    return row?.role === "owner" || row?.role === "admin";
  }

  public createProject(input: CreateProjectInput): Project {
    const timestamp = now();
    return this.db.transaction(() => {
      this.requireManager(input.organizationId, input.createdBy);
      const projectId = id<ProjectId>();
      this.db.prepare("INSERT INTO projects (id, organization_id, host_id, name, slug, status, ownership, stack_release, public_url, site_url, api_port, db_session_port, db_transaction_port, database_username, dashboard_username, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(projectId, input.organizationId, input.hostId, required(input.name, "name"), slug(input.slug), input.ownership ?? "manager-owned", required(input.stackRelease, "stackRelease"), required(input.publicUrl ?? `http://localhost:${input.ports.api}`, "publicUrl"), required(input.siteUrl ?? "http://localhost:3000", "siteUrl"), input.ports.api, input.ports.dbSession, input.ports.dbTransaction, required(input.databaseUsername, "databaseUsername"), required(input.dashboardUsername, "dashboardUsername"), input.createdBy, timestamp, timestamp);
      return mapProject(this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow);
    })();
  }

  /** Register a reachable stack without claiming any of its Docker resources. */
  public adoptExternalProject(input: AdoptExternalProjectInput): Project {
    const timestamp = now();
    if (new Set(Object.values(input.ports)).size !== 3) throw new Error("project ports must be unique");
    return this.db.transaction(() => {
      this.requireManager(input.organizationId, input.createdBy);
      const projectId = id<ProjectId>();
      this.db.prepare("INSERT INTO projects (id, organization_id, host_id, name, slug, status, ownership, stack_release, public_url, site_url, api_port, db_session_port, db_transaction_port, database_username, dashboard_username, created_by, created_at, updated_at, ready_at) VALUES (?, ?, ?, ?, ?, 'ready', 'external', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(projectId, input.organizationId, input.hostId, required(input.name, "name"), slug(input.slug), required(input.stackRelease, "stackRelease"), required(input.publicUrl ?? "", "publicUrl"), required(input.siteUrl ?? input.publicUrl ?? "", "siteUrl"), input.ports.api, input.ports.dbSession, input.ports.dbTransaction, required(input.databaseUsername, "databaseUsername"), required(input.dashboardUsername, "dashboardUsername"), input.createdBy, timestamp, timestamp, timestamp);
      return mapProject(this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow);
    })();
  }

  public createProjectDeployment(input: CreateProjectDeploymentInput): { project: Project; job: DurableJob } {
    return this.db.transaction(() => {
      const project = this.createProject(input);
      const createdAt = now();
      const expiresAt = new Date(Date.now() + (input.reservationTtlMinutes ?? 30) * 60_000).toISOString();
      const reservations = [
        ["api", project.ports.api],
        ["db-session", project.ports.dbSession],
        ["db-transaction", project.ports.dbTransaction],
      ] as const;
      for (const [endpoint, port] of reservations) {
        this.db.prepare("INSERT INTO port_reservations (id, host_id, project_id, endpoint, host_address, port, status, expires_at, created_at) VALUES (?, ?, ?, ?, '0.0.0.0', ?, 'held', ?, ?)")
          .run(randomUUID(), project.hostId, project.id, endpoint, port, expiresAt, createdAt);
      }
      const job = this.createJob({
        type: "create-project",
        projectId: project.id,
        requestedBy: input.createdBy,
        maxAttempts: 3,
      });
      this.appendJobEvent({
        jobId: job.id,
        stage: "validating",
        level: "info",
        message: "Project configuration accepted and ports reserved",
      });
      return { project, job };
    })();
  }

  public updateJobState(
    jobId: JobId,
    update: {
      status: JobStatus;
      stage?: DeploymentStage | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ): DurableJob {
    const timestamp = now();
    const existing = this.getJob(jobId);
    if (!existing) throw new Error("job not found");
    const startedAt = update.status === "running" && !existing.startedAt ? timestamp : existing.startedAt;
    const finishedAt = ["succeeded", "failed", "cancelled"].includes(update.status) ? timestamp : null;
    const attempt = update.status === "running" && existing.status === "queued" ? existing.attempt + 1 : existing.attempt;
    this.db.prepare("UPDATE jobs SET status = ?, stage = ?, attempt = ?, error_code = ?, error_message = ?, started_at = ?, finished_at = ? WHERE id = ?")
      .run(update.status, update.stage ?? existing.stage, attempt, update.errorCode ?? null, update.errorMessage ?? null, startedAt, finishedAt, jobId);
    return this.getJob(jobId)!;
  }

  public updateProjectStatus(projectId: ProjectId, status: ProjectStatus): Project {
    const timestamp = now();
    const readyAt = status === "ready" ? timestamp : null;
    const result = this.db.prepare("UPDATE projects SET status = ?, updated_at = ?, ready_at = COALESCE(ready_at, ?) WHERE id = ?")
      .run(status, timestamp, readyAt, projectId);
    if (result.changes !== 1) throw new Error("project not found");
    return this.getProject(projectId)!;
  }

  public updateProjectRelease(projectId: ProjectId, stackRelease: string): Project {
    const result = this.db.prepare("UPDATE projects SET stack_release = ?, updated_at = ? WHERE id = ?")
      .run(required(stackRelease, "stackRelease"), now(), projectId);
    if (result.changes !== 1) throw new Error("project not found");
    return this.getProject(projectId)!;
  }

  public activateProjectPorts(projectId: ProjectId): void {
    this.db.prepare("UPDATE port_reservations SET status = 'active', expires_at = NULL WHERE project_id = ? AND status = 'held'")
      .run(projectId);
  }

  public releaseProjectPorts(projectId: ProjectId): void {
    this.db.prepare("UPDATE port_reservations SET status = 'released', released_at = ? WHERE project_id = ? AND status IN ('held', 'active')")
      .run(now(), projectId);
  }

  public queueProjectDeletion(projectId: ProjectId, requestedBy: UserId): DurableJob {
    return this.db.transaction(() => {
      const project = this.getProject(projectId);
      if (!project) throw new Error("project not found");
      this.requireManager(project.organizationId, requestedBy);
      if (project.status === "deleting") throw new Error("project deletion is already queued");
      this.updateProjectStatus(projectId, "deleting");
      const job = this.createJob({ type: "delete-project", projectId, requestedBy, maxAttempts: 1 });
      this.appendJobEvent({ jobId: job.id, stage: "stopping-services", level: "info", message: "Project deletion accepted" });
      return job;
    })();
  }

  public markProjectDeleted(projectId: ProjectId): void {
    const timestamp = now();
    const result = this.db.prepare("UPDATE projects SET status = 'deleting', deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, projectId);
    if (result.changes !== 1) throw new Error("project not found");
  }

  public getProject(projectId: ProjectId): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  public listProjects(organizationId?: OrganizationId): readonly Project[] {
    const rows = organizationId ? this.db.prepare("SELECT * FROM projects WHERE organization_id = ? AND deleted_at IS NULL ORDER BY name").all(organizationId) : this.db.prepare("SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY name").all();
    return (rows as ProjectRow[]).map(mapProject);
  }

  public createJob(input: CreateJobInput): DurableJob {
    const timestamp = now();
    const jobId = id<JobId>();
    const maxAttempts = input.maxAttempts ?? 1;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");
    this.db.prepare("INSERT INTO jobs (id, type, project_id, requested_by, status, attempt, max_attempts, created_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)").run(jobId, input.type, input.projectId ?? null, input.requestedBy, maxAttempts, timestamp);
    return mapJob(this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow);
  }

  public getJob(jobId: JobId): DurableJob | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  public listRunnableJobs(): readonly DurableJob[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at").all() as JobRow[]).map(mapJob);
  }

  public appendJobEvent(input: AppendJobEventInput): JobEvent {
    const next = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM job_events WHERE job_id = ?").get(input.jobId) as { sequence: number };
    const eventId = id<JobEventId>();
    const timestamp = now();
    const details = JSON.stringify(input.details ?? {});
    this.db.prepare("INSERT INTO job_events (id, job_id, sequence, stage, level, message, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(eventId, input.jobId, next.sequence, input.stage ?? null, input.level, required(input.message, "message"), details, timestamp);
    return mapJobEvent(this.db.prepare("SELECT * FROM job_events WHERE id = ?").get(eventId) as JobEventRow);
  }

  public listJobEvents(jobId: JobId): readonly JobEvent[] {
    return (this.db.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY sequence").all(jobId) as JobEventRow[]).map(mapJobEvent);
  }

  public upsertCredential(input: UpsertCredentialInput): EncryptedCredential {
    const timestamp = now();
    const existing = this.db.prepare("SELECT id, created_at FROM credential_metadata WHERE project_id = ? AND name = ?")
      .get(input.projectId, required(input.name, "name")) as { id: string; created_at: string } | undefined;
    const credentialId = existing?.id ?? id<CredentialSetId>();
    this.db.prepare(`
      INSERT INTO credential_metadata
        (id, project_id, kind, name, algorithm, key_version, ciphertext_base64, nonce_base64, auth_tag_base64, associated_data, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'aes-256-gcm', 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, name) DO UPDATE SET
        kind = excluded.kind,
        ciphertext_base64 = excluded.ciphertext_base64,
        nonce_base64 = excluded.nonce_base64,
        auth_tag_base64 = excluded.auth_tag_base64,
        associated_data = excluded.associated_data,
        updated_at = excluded.updated_at
    `).run(
      credentialId,
      input.projectId,
      input.kind,
      required(input.name, "name"),
      required(input.ciphertextBase64, "ciphertextBase64"),
      required(input.nonceBase64, "nonceBase64"),
      required(input.authTagBase64, "authTagBase64"),
      required(input.associatedData, "associatedData"),
      existing?.created_at ?? timestamp,
      timestamp,
    );
    return mapCredential(this.db.prepare("SELECT * FROM credential_metadata WHERE project_id = ? AND name = ?")
      .get(input.projectId, input.name) as CredentialRow);
  }

  public getCredential(projectId: ProjectId, name: string): EncryptedCredential | null {
    const row = this.db.prepare("SELECT * FROM credential_metadata WHERE project_id = ? AND name = ?")
      .get(projectId, required(name, "name")) as CredentialRow | undefined;
    return row ? mapCredential(row) : null;
  }

  public listCredentialMetadata(projectId: ProjectId): readonly EncryptedCredential["metadata"][] {
    return (this.db.prepare("SELECT * FROM credential_metadata WHERE project_id = ? ORDER BY name").all(projectId) as CredentialRow[])
      .map((row) => mapCredential(row).metadata);
  }

  public deleteCredential(projectId: ProjectId, name: string): boolean {
    return this.db.prepare("DELETE FROM credential_metadata WHERE project_id = ? AND name = ?")
      .run(projectId, required(name, "name")).changes === 1;
  }

  public deleteProjectCredentials(projectId: ProjectId): number {
    return this.db.prepare("DELETE FROM credential_metadata WHERE project_id = ?").run(projectId).changes;
  }

  public recordVolume(input: RecordVolumeInput): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO volume_inventory (id, project_id, docker_name, kind, purpose, stack_release, status, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, 'present', ?, ?)
      ON CONFLICT(docker_name) DO UPDATE SET
        status = 'present', kind = excluded.kind, purpose = excluded.purpose,
        stack_release = excluded.stack_release, last_seen_at = excluded.last_seen_at
    `).run(randomUUID(), input.projectId, input.dockerName, input.kind, input.purpose, input.stackRelease, timestamp, timestamp);
  }

  public listProjectVolumes(projectId: ProjectId): readonly VolumeInventory[] {
    return (this.db.prepare("SELECT * FROM volume_inventory WHERE project_id = ? ORDER BY docker_name").all(projectId) as VolumeRow[])
      .map(mapVolume);
  }

  public markProjectVolumesMissing(projectId: ProjectId): void {
    this.db.prepare("UPDATE volume_inventory SET status = 'missing', last_seen_at = ? WHERE project_id = ?")
      .run(now(), projectId);
  }

  public transferProject(input: TransferProjectInput): OrganizationTransfer {
    return this.db.transaction(() => {
      const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(input.projectId) as ProjectRow | undefined;
      if (!project) throw new Error("project not found");
      if (project.organization_id === input.toOrganizationId) throw new Error("project already belongs to destination organization");
      this.requireManager(project.organization_id as OrganizationId, input.requestedBy);
      this.requireManager(input.toOrganizationId, input.destinationApprovedBy);
      const transferId = randomUUID();
      const timestamp = now();
      this.db.prepare("INSERT INTO organization_transfers (id, project_id, from_organization_id, to_organization_id, requested_by, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)").run(transferId, input.projectId, project.organization_id, input.toOrganizationId, input.requestedBy, timestamp, timestamp);
      this.db.prepare("UPDATE projects SET organization_id = ?, updated_at = ? WHERE id = ?").run(input.toOrganizationId, timestamp, input.projectId);
      return { id: transferId, projectId: input.projectId, fromOrganizationId: project.organization_id as OrganizationId, toOrganizationId: input.toOrganizationId, requestedBy: input.requestedBy, status: "completed" as OrganizationTransferStatus, createdAt: timestamp, completedAt: timestamp };
    })();
  }

  private requireManager(organizationId: OrganizationId, userId: UserId): void {
    const row = this.db.prepare("SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?").get(organizationId, userId) as { role: OrganizationRole } | undefined;
    if (!row || (row.role !== "owner" && row.role !== "admin")) throw new Error("organization manager permission required");
  }
}
