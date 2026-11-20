## Supabase Manager v1.0.2

### More resilient deployments

- Follow actual container health and database, Auth, REST, and Storage checks, with retries for temporary startup failures.
- Stop failed new deployments while preserving their data, credentials, configuration, and port reservations.
- Recheck recovered services without changing them, resume a retained deployment, or explicitly delete it with project-name confirmation.
- Preserve recovery progress across broker restarts and report when automatic stopping cannot be confirmed.

### Clearer failure diagnostics

- Expand container entries in **Live diagnostics** to see healthcheck output and recent logs captured at failure.
- Copy the exact Docker log command for further inspection on the server.
- Redact known credentials and limit captured output to keep the progress page readable.

The official Supabase images remain unchanged. Imported/manual deployments retain their original operator-managed lifecycle.

See [Deployment and recovery](https://github.com/skuldgerry/supabase-manager/blob/v1.0.2/docs/deployment.md#health-and-diagnostics) and the [changelog](https://github.com/skuldgerry/supabase-manager/blob/v1.0.2/CHANGELOG.md).

### Images

- UI: `skuldgerry/supabase-manager:1.0.2` (also `latest`).
- Broker: `skuldgerry/supabase-manager:1.0.2-broker` (also `latest-broker`).

### Before updating

> [!WARNING]
> Back up all three Manager data volumes together: `broker-data`, `studio-data`, and `manager-shared` (Compose may prefix their names).
> They contain your administrator accounts, encrypted project credentials, encryption key, and internal authentication token. Losing these can prevent access to the Manager or decryption of saved credentials.
> Take a consistent backup with no lifecycle job running and both Manager and broker stopped, and keep a secure copy off the host. Back up each project's database and Storage data separately as well.

Updating Manager does not automatically upgrade any Supabase project.
