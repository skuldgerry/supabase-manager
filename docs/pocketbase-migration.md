# PocketBase and Supabase migration

Open a Supabase project and choose **Project Settings > Data Migration**. An
existing PocketBase project's settings also let you choose an authorized
Supabase project. Both import and export move base collection/table schemas
and records; they do not deploy a PocketBase service.

## Permissions and endpoints

Manager mode requires the Manager and broker versions that support migration
authorization. Update the two images together. An older or unavailable broker
keeps migration disabled. Existing Studio-only Supabase records must be imported
or associated with the broker before migration in Manager mode.

Starting a migration and reading its progress require an active organization
owner or administrator for the Supabase project and the PocketBase endpoint's
organization. Project-scoped accounts also need access to both registered
projects. An organization-scoped manager is required for an endpoint that is
configured separately from a project. The broker supplies Supabase access
through its private project proxy; service credentials remain on the server.

PocketBase endpoints must be registered projects or explicitly configured by
the operator. To add an existing external PocketBase endpoint, set the following
literal environment value on the Manager service, then recreate that service:

```yaml
environment:
  STUDIO_MIGRATION_POCKETBASE_TARGETS: '[{"id":"archive","name":"Archive PocketBase","url":"http://192.168.1.20:8090","organizationSlug":"my-organization"}]'
```

The organization must be registered with the broker in Manager mode. Only
HTTP(S) endpoints without URL credentials, query strings or fragments are
accepted. A path prefix is supported. Redirects are not followed. This setting
is a trusted operator allowlist: configure only endpoints you own or intend to
use for migration. URLs supplied with older API requests must match a registered
or configured endpoint exactly after normalization.
When projects share an endpoint, choose the project or target ID explicitly;
the URL alone cannot identify the intended collection namespace.

For a registered PocketBase project, saved administrator credentials are used
on the server when the fields are left empty. Otherwise enter its administrator
email and password. Passwords and Supabase credentials are excluded from saved
job metadata and progress responses. Known runtime secrets are redacted from
new migration log entries.

## Existing projects and recovery

Legacy dashboard and GoTrue authentication modes remain supported. GoTrue and
member-based sessions must have the appropriate organization role and project
scope. A legacy single-administrator dashboard keeps its existing session
authentication. Existing embedded PocketBase projects migrate only collections
in their registered collection namespace.
Legacy manually connected databases require the matching `PG_META_CRYPTO_KEY`
so pg-meta can use that project's encrypted connection instead of the default
database. Registered legacy gateways retain their project-specific routing.

Progress belongs to the exact Supabase project and PocketBase target recorded
when the task starts. It is not available through another project's URL.
Permissions and target registration are checked again when progress is read.
Older job metadata remains readable only while its endpoint is still registered
or explicitly configured and its project scope can be established.

A migration interrupted by a Studio restart is reported as failed rather than
remaining in progress indefinitely. Review any partial changes before starting
another migration. Migrations are not transactional across both services; keep
backups and check destination data before repeating an operation.

Authentication accounts, file contents, indexes, access policies, triggers,
relations and record identifiers do not receive a complete cross-platform
mapping. Existing collections may be reused; migration does not reconcile
incompatible schemas or automatically remove previously copied records.
