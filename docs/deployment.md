# Deployment

The manager is distributed as a published image. The
Compose file does not build locally; it pulls the image named by
`SUPABASE_MANAGER_IMAGE` (default:
`skuldgerry/supabase-manager:0.1.0-dev`). Set that variable to the image
published by your release pipeline before starting the service.

## Requirements

- Linux Docker Engine with the Docker Compose v2 plugin
- Permission for the manager container to access the Docker socket
- Port `3000` available on the host (or a different `MANAGER_PORT`)

The mounted Docker socket gives the manager control of the local Docker
Engine. Treat the manager as a privileged control-plane service and protect
its UI and host accordingly.

## Start

Copy `compose.yml` to the target server, set the published image and public
URL in an untracked `.env` file, then start it:

```sh
SUPABASE_MANAGER_IMAGE=skuldgerry/supabase-manager:0.1.0-dev
MANAGER_PUBLIC_URL=http://localhost:3000
```

```sh
docker compose pull
docker compose up -d
docker compose ps
```

If the service is exposed on another host port, set `MANAGER_PORT`; the
container still listens on that same internal port. `MANAGER_BIND_ADDRESS`
controls the host-side published address and should normally remain
`0.0.0.0` or be restricted to a private interface.

The first visit to the UI creates the initial administrator account. The
manager stores its SQLite database, release cache, generated encryption key,
and other state in the single named volume `manager-data`. Back up that
volume before moving or replacing the container.

`MANAGER_MASTER_KEY` is optional. When supplied, provide it through the
untracked environment or an external secret mechanism; never commit it or
place it in an image. When omitted, the manager creates a key in `manager-data`.

## Health and diagnostics

The image includes a Docker healthcheck that requests `/api/health`.
Inspect startup and health state with:

```sh
docker compose ps
docker compose logs --tail=200 manager
```

The manager uses `/var/run/docker.sock` inside the container. To use a socket
at another host path, set `DOCKER_SOCKET_PATH` in `.env`; it is mounted at the
manager's standard in-container path.
