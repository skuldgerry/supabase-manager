## Supabase Manager v1.0.3

- Move collection and table schemas and records between PocketBase and Supabase from **Project Settings → Data Migration**. The Manager checks project permissions and keeps Supabase credentials on the server.
- Test Edge Functions through the selected project's gateway from Studio.
- Block missing and example pg-meta encryption keys for manually connected databases in production. Existing custom keys continue to work with the official pg-meta protocol.
- Update Studio runtime dependencies.

Update the Manager and broker together. For supported migration data, configuration, and recovery guidance, see [PocketBase migration](https://github.com/skuldgerry/supabase-manager/blob/v1.0.3/docs/pocketbase-migration.md) and [pg-meta encryption](https://github.com/skuldgerry/supabase-manager/blob/v1.0.3/docs/pg-meta-encryption.md).

### Docker images

- Manager: `skuldgerry/supabase-manager:1.0.3` (also `latest`)
- Broker: `skuldgerry/supabase-manager:1.0.3-broker` (also `latest-broker`)

### Before updating

> [!WARNING]
> Back up all three Manager volumes together: `broker-data`, `studio-data`, and `manager-shared`. Wait for any deployment or update jobs to finish, stop both Manager services, and keep a secure copy of the backup off the host. Back up each project's database and Storage data separately.
