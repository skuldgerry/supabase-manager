# Supabase Manager

Supabase Manager is a local-first control plane for running multiple isolated
projects from Supabase's official self-hosted Docker stack. It provides one
login, organizations, project switching, per-project ports and initial secrets,
named volumes, durable provisioning progress, and retrievable encrypted
credentials.

The official stack's internal `postgres` role remains unchanged for
compatibility. The configurable usernames in the first release are the manager
administrator identity and each project's Studio login; creating a differently
privileged PostgreSQL role is intentionally left to normal database role
management after deployment.

The manager does not proxy project traffic. Each project publishes its own API
and database pooler ports, so you can keep them local or place your own reverse
proxy in front of individual projects.

## Current release adapter

The first adapter pins Supabase `self-hosted/v0.8.0`, whose official Compose
stack uses Envoy and PostgreSQL 17. Image versions remain owned by that upstream
release; the manager generates only a project environment and named-volume
override.

## Run

Use the published image with [compose.yml](./compose.yml). The manager requires
a Linux Docker Engine and access to its Docker socket.

The current development image is `skuldgerry/supabase-manager:0.1.0-dev`.
Development tags are published for testing and do not move `latest`.

```sh
docker compose pull
docker compose up -d
```

Open `http://localhost:3000`, create the first administrator, create an
organization, and deploy a project. See [deployment documentation](./docs/deployment.md)
and the [architecture](./docs/architecture.md) for security and operational
details.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run lint
npm run build
```

Do not expose the manager UI directly to the public internet. The mounted
Docker socket gives it control of the local engine, and the credentials page can
reveal project secrets to authenticated organization users.
