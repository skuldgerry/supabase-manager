# Changelog

## 1.0.2 - 2026-11-02

### Improved

- Deployment readiness now follows actual container health and database, Auth, REST, and Storage checks, with retries for temporary startup failures.
- Live diagnostics includes expandable container log and healthcheck snapshots, with known credentials redacted and copyable Docker log commands.
- Failed new deployments stop their services while retaining volumes, configuration, credentials, and port reservations for recovery.

### Added

- **Recheck deployment** to verify services without changing them.
- **Resume deployment** to restart a retained deployment with its existing data and credentials.
- **Delete failed deployment** with project-name confirmation to remove the project's resources and data.

### Fixed

- Avoid treating transient `unhealthy`, restarting, or connection-refused states as immediate deployment failures.
- Preserve recovery progress across broker restarts and report when automatic stopping cannot be confirmed.
- Apply the same service readiness checks during project updates and lifecycle operations.

Existing imported deployments remain externally owned. Updating Manager does not automatically upgrade any Supabase project.

For earlier versions, see the [GitHub releases](https://github.com/skuldgerry/supabase-manager/releases).
