# Deployment

The manager is distributed as a published image. The Compose file is
self-contained and pulls `skuldgerry/supabase-manager:0.1.1-dev`; it does not
build locally or require a `.env` file.

## Requirements

- Linux Docker Engine with the Docker Compose v2 plugin
- Permission for the manager container to access the Docker socket
- Port `3000` available on the host

The mounted Docker socket gives the manager control of the local Docker
Engine. Treat the manager as a privileged control-plane service and protect
its UI and host accordingly.

## Start

Copy `compose.yml` to the target server and start it:

```sh
docker compose pull
docker compose up -d
docker compose ps
```

To change the port, bind address, public URL, session lifetime, image tag, or
Docker socket path, edit the corresponding literal value directly in
`compose.yml`.

The first visit to the UI creates the initial administrator account. The
manager stores its SQLite database, release cache, generated encryption key,
and other state in the single named volume `manager-data`. Back up that
volume before moving or replacing the container.

When creating a project, the manager prefers a non-loopback hostname from
`MANAGER_PUBLIC_URL`; otherwise it uses the hostname or IP through which the
browser reached the UI. The project URL remains editable. Host-port defaults
are suggestions calculated from live Docker published ports and existing
manager reservations; they are only reserved when **Deploy project** is
pressed, so cancelling a wizard does not consume a port.

The Auth site URL is the default redirect origin for the application using
Supabase Auth. It is not the manager URL. The wizard initially uses the new
project URL to avoid assuming that host port `3000` belongs to an application.

The manager creates its encryption key in `manager-data`; no master-key value
is required in Compose. Back up the volume because both the encrypted
credentials and their generated key are stored there.

## Health and diagnostics

The image includes a Docker healthcheck that requests `/api/health`.
Inspect startup and health state with:

```sh
docker compose ps
docker compose logs --tail=200 manager
```

The manager uses `/var/run/docker.sock` inside the container. If the host uses
a different path, edit the source side of the socket bind directly in
`compose.yml` while keeping the container path unchanged.
