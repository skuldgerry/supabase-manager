# Updating projects

For a manager-owned project, open **Project Settings > General**, choose the
official self-hosted release (the newest available release is selected by
default), and select **Update**. The project page displays durable progress,
sanitized logs, and any recovery failure. This updates that project's official
stack, not the Manager images.

The broker prepares the official update script and checks its preview before
stopping the project. Manual migration requirements, merge conflicts,
PostgreSQL major-version changes, external S3 Storage, and unrecognized mounts
stop automatic updates rather than claim recovery coverage they cannot provide.

## Maintenance and recovery

1. Pull candidate images while the current project is still running. Retain
   exact local image IDs for both releases.
2. Pause Manager access, stop ingress, drain application writers, then stop
   PostgreSQL last. Verify that no running
   container is using a project volume, then archive all nine managed volumes,
   including PostgreSQL and Storage, and record their sizes and SHA-256 hashes.
3. Start the candidate with API and database pooler ports unpublished. Check
   database roles and schemas, Auth, REST, and Storage on the private network.
4. Persist the verified release, then reopen client ports. If validation fails
   before this point, verify every archive before restoring any volume, restore
   the original data and images together, and recheck the previous release.

Expect downtime for the snapshot, validation, and any recovery. Large databases
or Storage volumes need correspondingly more time and free space. This is a
cold recovery point, not online backup, PITR, an HA mechanism, or a PostgreSQL
major-version migration. Keep independent, tested off-host backups. Do not
attach external writers to the project's private Docker network during an update.

A persisted journal lets an interrupted broker resume safely. A failed recovery
offers **Retry recovery** on the project progress page. Once a verified release
is committed and client access may have reopened, retry completes activation;
it does not automatically restore an older snapshot and lose newer writes.

Recovery points remain under the broker's data directory:
`/data/projects/<project-id>/backups/update-<job-id>/`. They contain sensitive
database and object data; archive files have owner-only permissions, while the
saved environment is encrypted with the broker master key. Back up that key and
the Manager data volumes. Retention/pruning is currently operator-managed; do
not remove an active or failed job's recovery point. Preserve the previous local
images until recovery is no longer needed; Docker image pruning can remove them.

## Imported projects and security fixes

Imported projects remain externally owned. Use their original Compose directory
and the official updater; the Manager never modifies those deployments.

An update follows image versions in the selected official release, not every
service's newest tag. A security-fixed service image can therefore be newer than
the official stack manifest. Review upstream compatibility and test a pinned
override against a restored copy before applying such an override to production.

No additional persistent project service is introduced. Short-lived Alpine
helpers archive/restore named volumes and perform private-network health checks;
the Supabase services continue to use the official stack.
