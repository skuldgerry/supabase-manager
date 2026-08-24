# Supabase Manager v1 architecture

## Scope

The manager is a single-server control plane. It owns the lifecycle of
project-scoped Supabase Compose deployments on the local Docker Engine. The
upstream Supabase stack is pinned per project and is not edited in place. The
manager generates the project-specific environment and Compose override,
including host ports, credentials, immutable Docker identity, and named
volumes.

## Identity and tenancy

The first account created during setup becomes the initial administrator. Users
belong to organizations through memberships (`owner`, `admin`, `member`, or
`viewer`). A project is owned by exactly one organization at a time.

Project IDs are immutable identifiers and are the only source for Docker
identity. Container, network, and volume names are derived from the project ID,
never from an organization or project display name. Consequently, renaming a
project or transferring it between organizations does not restart containers,
move data, change ports, or change credentials.

## Deployment model

Each project has an isolated Compose project, network, and named-volume set.
Persistent volumes hold database and storage data; configuration and cache
volumes hold release-specific generated files. The control plane keeps a volume
inventory so it can detect missing or orphaned Docker volumes after a restart.

Host port reservations are acquired before provisioning and are unique per host,
bind address, and port while held or active. Reservations are released when a
deployment is rolled back or deleted. Internal Supabase container ports remain
the official ports; user-selected values affect only host publishing.

## Credentials

Credential records contain only encrypted envelopes and metadata. Plaintext
values are returned to the UI only through an authorized credentials action and
are never placed in job events, logs, URLs, or error messages. The installation
master key is outside this domain model and is required to decrypt an envelope.
The complete upstream environment is also encrypted in SQLite. A mode-`0600`
`.env` file is materialized only while Compose is executing and removed in the
broker's cleanup path, along with backup files made by upstream key helpers.

## Durable jobs and diagnostics

Every lifecycle operation is a durable job. Jobs survive manager restarts and
emit ordered, sanitized events. Project creation reports stages from validation
through functional checks and is marked `ready` only after the broker verifies
the required services. Failure retains the job and project metadata for
diagnosis; user-facing error fields contain safe summaries rather than raw
secret-bearing output.

## Organization transfers

A transfer is an explicit metadata operation represented by
`organization_transfers`. It requires approval by an owner or administrator of
both the source and destination organizations. Completion changes only
`projects.organization_id` and authorization metadata. The host, immutable
project ID, Docker resources, ports, volumes, jobs, and credentials remain
unchanged.

## Persistence

SQLite stores control-plane state with foreign keys enabled. All timestamps are
UTC ISO-8601 strings. IDs are generated as UUID-like opaque values by the
application and stored as text. The schema is intentionally versioned by the
application (`SCHEMA_VERSION`) so future migrations can be added without
coupling the domain contracts to a database driver.
