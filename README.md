# Supabase Manager

Supabase Manager is a local-first control plane for running multiple isolated
projects from Supabase's official self-hosted Docker stack. It provides one
login, organizations, project switching, per-project ports and initial secrets,
named volumes, durable provisioning progress, and retrievable encrypted
credentials.

![Supabase Manager project switcher and project status](https://raw.githubusercontent.com/skuldgerry/supabase-manager/main/docs/images/parcel-proof-project-switcher.svg)

The V1 deployment has two control-plane containers. `manager` serves the
Studio-based UI and never receives the Docker socket. `broker` owns lifecycle
operations and is the only service with access to Docker. They share only a
generated internal authentication token through a named volume.

The official stack's internal `postgres` role remains unchanged for
compatibility. The configurable usernames in the first release are the manager
administrator identity and each project's Studio login; creating a differently
privileged PostgreSQL role is intentionally left to normal database role
management after deployment.

The manager does not proxy project traffic. Each project publishes its own API
and database pooler ports, so you can keep them local or place your own reverse
proxy in front of individual projects.

## Official release adapters

The project wizard reads Supabase's official self-hosted tags and offers the
latest three, with the latest selected by default. `self-hosted/v0.8.0` uses
the current Envoy/PostgreSQL 17 adapter; the preceding `v0.7.x` releases use
their version-compatible Kong adapter. A custom official `self-hosted/vX.Y.Z`
tag can also be entered and is structurally validated before provisioning.

Image versions remain owned by the selected upstream release. The manager
generates only the project environment and named-volume override.

## Existing projects

V1 can import an official Supabase Compose deployment running on the same
Docker Engine. The broker verifies that the published API port belongs to one
Compose project and that the supplied credentials match its containers before
registering it. Imported deployments remain externally owned: manager
lifecycle and deletion operations never stop or remove their containers,
networks, or volumes.

Remote Docker hosts will be supported through a future agent. Until then,
deploy Supabase Manager on the Docker host that owns the project being
imported.

Supabase Cloud preview branches are not part of the official self-hosted
stack. Database backups are operator-managed in V1; the manager does not imply
that Cloud backup or PITR services are available.

## Run

The broker requires a Linux Docker Engine and access to its Docker socket. The
Studio manager does not mount the socket. Replace `192.168.1.10` with the LAN
IP address of the Docker host, then save the following as `compose.yml`:

```yaml
services:
  broker:
    image: skuldgerry/supabase-manager:latest-broker
    restart: unless-stopped
    environment:
      NODE_ENV: production
      MANAGER_DATA_DIR: /data
      MANAGER_PORT: 3001
      MANAGER_BIND_ADDRESS: 0.0.0.0
      MANAGER_PUBLIC_URL: http://manager:3000
      MANAGER_PROJECT_HOST: 192.168.1.10
      MANAGER_INTERNAL_TOKEN_FILE: /run/supabase-manager/internal-token
      DOCKER_SOCKET_PATH: /var/run/docker.sock
      SESSION_TTL_HOURS: 24
    volumes:
      - broker-data:/data
      - manager-shared:/run/supabase-manager
      - /var/run/docker.sock:/var/run/docker.sock
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          node -e "fetch('http://127.0.0.1:3001/api/health')
          .then((response) => process.exit(response.ok ? 0 : 1))
          .catch(() => process.exit(1))"
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 15s

  manager:
    image: skuldgerry/supabase-manager:latest
    restart: unless-stopped
    depends_on:
      broker:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: 3000
      HOSTNAME: 0.0.0.0
      STUDIO_DATA_DIR: /data
      MANAGER_BROKER_URL: http://broker:3001
      MANAGER_INTERNAL_TOKEN_FILE: /run/supabase-manager/internal-token
      NEXT_PUBLIC_STUDIO_AUTH: manager
      DEFAULT_ORGANIZATION_NAME: Default Organization
    ports:
      - "3000:3000"
    volumes:
      - studio-data:/data
      - manager-shared:/run/supabase-manager:ro
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          node -e "fetch('http://127.0.0.1:3000/api/self-hosted/session')
          .then((response) => process.exit(response.ok ? 0 : 1))
          .catch(() => process.exit(1))"
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s

volumes:
  broker-data:
  studio-data:
  manager-shared:
```

The same file is available as [compose.yml](./compose.yml). Start the manager:

```sh
docker compose pull
docker compose up -d
```

Open `http://localhost:3000`, create the first administrator, create or select
an organization, and deploy or import a project. See
[deployment documentation](./docs/deployment.md) and the
[architecture](./docs/architecture.md) for security and operational details.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run lint
npm run build
```

Do not expose the manager UI directly to the public internet. Although only the
broker mounts the Docker socket, authenticated manager administrators can issue
privileged lifecycle requests and reveal project secrets. Protect the host and
back up all three manager volumes.

