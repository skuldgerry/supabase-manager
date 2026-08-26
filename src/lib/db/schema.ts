/** SQLite schema for the control plane. The application should execute this
 * statement once inside a transaction before serving requests. */
export const SCHEMA_VERSION = 2;

export const CONTROL_PLANE_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')) DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')) DEFAULT 'active',
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_status ON sessions(user_id, status);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON organization_memberships(user_id);

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  driver TEXT NOT NULL CHECK (driver = 'local-docker'),
  docker_socket_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'offline', 'degraded', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_health_check_at TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  host_id TEXT NOT NULL REFERENCES hosts(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'stopped', 'failed', 'deleting')),
  ownership TEXT NOT NULL DEFAULT 'manager-owned' CHECK (ownership IN ('manager-owned', 'external')),
  stack_release TEXT NOT NULL,
  public_url TEXT NOT NULL,
  site_url TEXT NOT NULL,
  api_port INTEGER NOT NULL CHECK (api_port BETWEEN 1 AND 65535),
  db_session_port INTEGER NOT NULL CHECK (db_session_port BETWEEN 1 AND 65535),
  db_transaction_port INTEGER NOT NULL CHECK (db_transaction_port BETWEEN 1 AND 65535),
  database_username TEXT NOT NULL,
  dashboard_username TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ready_at TEXT,
  deleted_at TEXT,
  UNIQUE(organization_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_projects_host ON projects(host_id, status);

CREATE TABLE IF NOT EXISTS port_reservations (
  id TEXT PRIMARY KEY NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL CHECK (endpoint IN ('api', 'db-session', 'db-transaction')),
  host_address TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  status TEXT NOT NULL CHECK (status IN ('held', 'active', 'released')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  released_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_port_reservations
  ON port_reservations(host_id, host_address, port)
  WHERE status IN ('held', 'active');
CREATE INDEX IF NOT EXISTS idx_port_reservations_project ON port_reservations(project_id);

CREATE TABLE IF NOT EXISTS credential_metadata (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('project-api', 'database', 'jwt', 'dashboard', 'storage', 'other')),
  name TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm = 'aes-256-gcm'),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  ciphertext_base64 TEXT NOT NULL,
  nonce_base64 TEXT NOT NULL,
  auth_tag_base64 TEXT NOT NULL,
  associated_data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_credentials_project ON credential_metadata(project_id);

CREATE TABLE IF NOT EXISTS mfa_factors (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  ciphertext_base64 TEXT NOT NULL,
  nonce_base64 TEXT NOT NULL,
  auth_tag_base64 TEXT NOT NULL,
  associated_data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user ON mfa_recovery_codes(user_id, used_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('create-project', 'start-project', 'stop-project', 'restart-project', 'delete-project', 'check-project')),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  stage TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts > 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at);

CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  stage TEXT,
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  message TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(job_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, sequence);

CREATE TABLE IF NOT EXISTS volume_inventory (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  docker_name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('persistent', 'configuration', 'cache')),
  purpose TEXT NOT NULL,
  stack_release TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('expected', 'present', 'missing', 'orphaned')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_volumes_project ON volume_inventory(project_id);

CREATE TABLE IF NOT EXISTS organization_transfers (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_organization_id TEXT NOT NULL REFERENCES organizations(id),
  to_organization_id TEXT NOT NULL REFERENCES organizations(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (from_organization_id <> to_organization_id)
);
CREATE INDEX IF NOT EXISTS idx_transfers_project_status ON organization_transfers(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_project_transfer
  ON organization_transfers(project_id)
  WHERE status = 'pending';
`;

export const SCHEMA_STATEMENTS = CONTROL_PLANE_SCHEMA
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
