# Deployment

The manager is distributed as two published images. The Compose file is
self-contained, uses literal configuration, and does not build locally or
require a `.env` file.

## Requirements

- Linux Docker Engine with the Docker Compose v2 plugin
- Permission for the broker container to access the Docker socket
- Port `3000` available on the host

The mounted Docker socket gives the broker control of the local Docker Engine.
The Studio manager does not mount it. Treat the complete deployment as a
privileged control plane and protect its UI and host accordingly.

## Start

Copy `compose.yml` to the target server and start it:

```sh
docker compose pull
docker compose up -d
docker compose ps
```

To change the UI port, image tags, session lifetime, project host, or Docker
socket path, edit the corresponding literal value directly in `compose.yml`.

The first visit to the UI creates the initial administrator account and a
default organization. Control-plane state is split across `broker-data`,
`studio-data`, and `manager-shared`. Back up all three volumes before moving or
replacing the deployment. The shared volume contains the generated private
token that authenticates Studio to the broker.

When creating a project, the manager prefers a non-loopback hostname from
`MANAGER_PUBLIC_URL`; otherwise it uses the hostname or IP through which the
browser reached the UI. The project URL remains editable. Host-port defaults
are suggestions calculated from live Docker published ports and existing
manager reservations; they are only reserved when **Deploy project** is
pressed, so cancelling a wizard does not consume a port.

The Auth site URL is the default redirect origin for the application using
Supabase Auth. It is not the manager URL. The wizard initially uses the new
project URL to avoid assuming that host port `3000` belongs to an application.

The broker creates its encryption key in `broker-data`; no master-key value is
required in Compose. Back up the volume because both the encrypted credentials
and their generated key are stored there.

## Importing an existing project

Open the organization project page and select **Import project**. V1 imports
only official Supabase Compose deployments on the same Docker Engine. The
broker validates Docker Compose ownership and credential consistency without
sending secrets to arbitrary user-supplied network endpoints.

An imported project is recorded as externally owned. Removing its manager
record does not remove, stop, or reconfigure the original Compose deployment.

## Health and diagnostics

Both images include Docker healthchecks. Inspect startup and health state with:

```sh
docker compose ps
docker compose logs --tail=200 broker manager
```

The broker uses `/var/run/docker.sock` inside the container. If the host uses a
different path, edit the source side of the socket bind directly in
`compose.yml` while keeping the container path unchanged.
