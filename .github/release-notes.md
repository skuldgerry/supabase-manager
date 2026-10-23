## Supabase Manager v1.0.1

### Storage routing

- Route Studio Storage operations through the selected project's private broker connection rather than process-wide credentials.
- Preserve signed/public object URLs using the project's public endpoint.
- Verify project organization access, including older installations whose Studio membership mirror is missing. Read-only and project-scoped restrictions remain enforced.

### Managed updates and recovery

- Retain cold snapshots of all managed project volumes, including PostgreSQL and file-backed Storage, with integrity checks, configuration, and pinned images.
- Validate candidate services privately before reopening client ports, with durable progress, interrupted-job recovery, and retry diagnostics.
- Refuse automatic updates with unsupported recovery requirements, including PostgreSQL major changes and external S3 Storage. Imported/manual deployments remain operator-managed.
- No new persistent project services or modifications to the official Supabase images.

See [Updating projects](https://github.com/skuldgerry/supabase-manager/blob/v1.0.1/docs/updating.md) for downtime, independent backup requirements, retention, and recovery limitations.

### Verification and remaining limitations

- Root typecheck/lint and focused routing/recovery tests passed, including isolated Docker PostgreSQL/schema/data and Storage restore tests.
- The Studio production build and isolated runtime Storage smoke test passed. Live bucket listing, folder navigation, and project switching were verified for existing managed/imported projects without changing their stacks.
- A complete official Supabase release-upgrade/rollback rehearsal remains pending; this release does not claim that end-to-end test has passed.
- Full Studio TypeScript validation remains outside the build checks. Previously identified dependency advisories are not remediated by this routing/recovery patch.

### Images

- UI: `skuldgerry/supabase-manager:1.0.1` (also `latest`).
- Broker: `skuldgerry/supabase-manager:1.0.1-broker` (also `latest-broker`).

Back up all three Manager data volumes before updating the control plane. Updating Manager does not automatically upgrade any Supabase project.
