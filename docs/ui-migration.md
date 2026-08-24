# Studio UI migration

The UI migration is intentionally separated from broker integration.

## Source baseline

`studio-ui/` contains the exact Supabase Studio Multi-Head source imported from
commit `f88e4b4e6ba2f331ab1b2466cf7d120aaf9d47a2`. Its original license and
attribution are retained. `studio-ui/UPSTREAM.md` records the import provenance.

The baseline includes the real Studio implementations for:

- first-admin setup and sign-in;
- organization and project lists;
- organization and project selectors;
- project creation;
- project overview and navigation;
- Table, SQL, Database, Auth, Storage, Realtime, Logs, and Settings pages;
- Connect and command dialogs.

These surfaces are reused directly. They are not recreated in the broker app.

## Application boundary

- `Dockerfile.studio` builds the exact Studio/Multi-Head UI baseline.
- `Dockerfile` continues to build the existing Supabase Manager broker.
- The broker remains the source of truth for manager authentication,
  organizations, encrypted credentials, official-stack deployment, durable
  jobs, ports, volumes, and diagnostics.

The Studio image uses Next.js's Webpack production builder with its memory
optimization enabled. This is a build-only accommodation for smaller
self-hosted builders and does not alter the vendored UI behavior or
presentation.

During the visual-parity milestone, the Studio image still contains the
Multi-Head backend adapters so every reference route can render. Those adapters
will subsequently be replaced with private server-to-server calls to the
broker. The public project API and database ports will remain independent; the
manager will not become a public reverse proxy for project traffic.

## Build the UI image

From the repository root:

```sh
docker build --file Dockerfile.studio --target production --tag supabase-manager-ui:dev .
```

This must be built from the repository root because Studio depends on workspace
packages under `studio-ui/packages/`.
