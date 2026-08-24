# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24-alpine
ARG DOCKER_CLI_IMAGE=docker:29.7.2-cli-alpine3.24

FROM ${NODE_IMAGE} AS dependencies

WORKDIR /app

# better-sqlite3 and argon2 may need to compile for the target architecture.
RUN apk add --no-cache g++ make python3
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder

COPY . .
RUN npm run build

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${DOCKER_CLI_IMAGE} AS runtime

# The Docker CLI image intentionally does not include Node. Copying the
# architecture-matched Node binary from the builder keeps the runtime based on
# the pinned official Docker CLI image while retaining the Next standalone
# deployment model.
RUN apk add --no-cache bash ca-certificates curl git jq libgcc libstdc++ openssl tini
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

WORKDIR /app
ENV NODE_ENV=production \
    MANAGER_DATA_DIR=/data \
    MANAGER_PORT=3000 \
    MANAGER_BIND_ADDRESS=0.0.0.0 \
    DOCKER_SOCKET_PATH=/var/run/docker.sock

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY scripts/entrypoint.sh /usr/local/bin/supabase-manager-entrypoint
RUN chmod 0755 /usr/local/bin/supabase-manager-entrypoint \
    && mkdir -p /data \
    && chmod 0700 /data

VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/supabase-manager-entrypoint"]
