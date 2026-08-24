import type { NamedVolumeMount } from "./compose";

export interface StackReleaseAdapter {
  readonly adapterVersion: 1;
  readonly release: string;
  readonly gatewayService: "api-gw" | "kong";
  readonly services: readonly string[];
  readonly mounts: readonly NamedVolumeMount[];
  readonly realtimeService: string;
  readonly gatewayEntrypoint?: readonly string[];
  readonly requiredComposeVersion: string;
}

/**
 * Adapter for the current Envoy/Postgres 17 official self-hosted layout.
 * Runtime image tags still come exclusively from the pinned upstream Compose.
 */
export const ENVOY_PG17_ADAPTER = Object.freeze({
  adapterVersion: 1,
  release: "self-hosted/v0.8.0",
  gatewayService: "api-gw",
  services: [
    "studio",
    "api-gw",
    "auth",
    "rest",
    "realtime",
    "storage",
    "imgproxy",
    "meta",
    "functions",
    "db",
    "supavisor",
  ],
  realtimeService: "realtime",
  requiredComposeVersion: "2.24.4",
  gatewayEntrypoint: ["/bin/sh", "/etc/envoy/docker-entrypoint.sh"],
  mounts: [
    { service: "studio", purpose: "snippets", target: "/app/snippets" },
    { service: "studio", purpose: "functions", target: "/app/edge-functions", readOnly: true },
    { service: "api-gw", purpose: "envoy", target: "/etc/envoy", readOnly: true },
    { service: "storage", purpose: "storage", target: "/var/lib/storage" },
    { service: "imgproxy", purpose: "storage", target: "/var/lib/storage" },
    { service: "functions", purpose: "functions", target: "/home/deno/functions" },
    { service: "functions", purpose: "deno_cache", target: "/root/.cache/deno" },
    { service: "db", purpose: "db_init", target: "/docker-entrypoint-initdb.d", readOnly: true },
    { service: "db", purpose: "postgres", target: "/var/lib/postgresql/data" },
    { service: "db", purpose: "db_config", target: "/etc/postgresql-custom" },
    { service: "supavisor", purpose: "pooler", target: "/etc/pooler", readOnly: true },
  ],
} satisfies StackReleaseAdapter);

export const KONG_ADAPTER = Object.freeze({
  ...ENVOY_PG17_ADAPTER,
  release: "self-hosted/v0.7.2",
  gatewayService: "kong",
  services: ENVOY_PG17_ADAPTER.services.map((service) => service === "api-gw" ? "kong" : service),
  gatewayEntrypoint: ["/bin/sh", "/home/kong/kong-entrypoint.sh"],
  mounts: ENVOY_PG17_ADAPTER.mounts.map((mount) => mount.service === "api-gw"
    ? { ...mount, service: "kong", target: "/home/kong" }
    : mount),
} satisfies StackReleaseAdapter);

export function adapterForRelease(release: string): StackReleaseAdapter {
  if (!/^self-hosted\/v\d+\.\d+\.\d+$/.test(release)) {
    throw new Error(`Unsupported official Supabase release: ${release}`);
  }
  const version = release.match(/v(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number) ?? [];
  const base = (version[0] ?? 0) > 0 || (version[1] ?? 0) >= 8 ? ENVOY_PG17_ADAPTER : KONG_ADAPTER;
  return Object.freeze({ ...base, release });
}
