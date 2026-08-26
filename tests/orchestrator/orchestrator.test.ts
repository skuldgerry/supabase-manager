import test from "node:test";
import assert from "node:assert/strict";
import {
  asProjectId,
  defaultPorts,
  dockerProjectName,
  ENVOY_PG17_ADAPTER,
  adapterForRelease,
  boundedDiagnosticText,
  generateComposeOverride,
  parseDockerConfiguredPorts,
  parseDockerPublishedPorts,
  PortReservationRegistry,
  sanitizeDiagnostic,
  sortOfficialReleases,
  volumePlan,
} from "../../src/lib/orchestrator/index.js";
import { legacyJwt, patchEnv, projectPublicEnvironment, versionAtLeast } from "../../src/lib/orchestrator/broker.js";
import { validateExternalAdoption } from "../../src/lib/orchestrator/external-adoption.js";

const projectId = asProjectId("11111111-1111-4111-8111-111111111111");

test("project identity and volume plan are deterministic", () => {
  assert.equal(dockerProjectName(projectId), "sm_11111111111141118111111111111111");
  const plan = volumePlan(projectId, "v1.2.3");
  assert.equal(plan.length, 9);
  assert.equal(plan.find((item) => item.purpose === "postgres")?.name, "sm_11111111111141118111111111111111_postgres");
  assert.equal(plan.find((item) => item.purpose === "envoy")?.name, "sm_11111111111141118111111111111111_envoy_v1.2.3");
});

test("port reservations are atomic and reusable after release", async () => {
  const registry = new PortReservationRegistry();
  const reservation = await registry.reserve(defaultPorts(8100));
  await assert.rejects(() => registry.reserve(defaultPorts(8100)), /already reserved/);
  await reservation.release();
  const next = await registry.reserve(defaultPorts(8100));
  await next.commit();
  assert.equal(registry.isReserved(8100), true);
});

test("override replaces bind mounts and keeps official internal ports", () => {
  const volumes = volumePlan(projectId, "self-hosted/v0.8.0");
  const output = generateComposeOverride({
    projectId,
    release: "self-hosted/v0.8.0",
    ports: { api: 18100, dbSession: 18101, dbTransaction: 18102 },
    volumes,
    mounts: [
      { service: "db", purpose: "postgres", target: "/var/lib/postgresql/data" },
      { service: "storage", purpose: "storage", target: "/var/lib/storage" },
    ],
    services: ENVOY_PG17_ADAPTER.services,
    gatewayService: ENVOY_PG17_ADAPTER.gatewayService,
    realtimeService: ENVOY_PG17_ADAPTER.realtimeService,
    gatewayEntrypoint: ENVOY_PG17_ADAPTER.gatewayEntrypoint,
  });
  assert.match(output, /volumes: !override/);
  assert.match(output, /18100:8000/);
  assert.match(output, /18101:5432/);
  assert.match(output, /18102:6543/);
  assert.match(output, /api-gw:/);
  assert.match(output, /realtime-dev\.sm_/);
  assert.match(output, /com\.supabase-manager\.project-id/);
  assert.doesNotMatch(output, /8000:18100/);
});

test("official gateway mounts match their entrypoint write requirements", () => {
  const envoyMount = ENVOY_PG17_ADAPTER.mounts.find((mount) => mount.service === "api-gw");
  const kongMount = adapterForRelease("self-hosted/v0.7.2").mounts.find((mount) => mount.service === "kong");
  assert.equal(envoyMount?.target, "/etc/envoy");
  assert.equal(envoyMount?.readOnly, undefined);
  assert.equal(kongMount?.readOnly, true);
});

test("recent official release tags select their version-compatible gateway adapter", () => {
  assert.equal(adapterForRelease("self-hosted/v0.7.2").release, "self-hosted/v0.7.2");
  assert.equal(adapterForRelease("self-hosted/v0.7.2").gatewayService, "kong");
  assert.equal(adapterForRelease("self-hosted/v0.8.0").gatewayService, "api-gw");
  assert.throws(() => adapterForRelease("main"), /Unsupported official Supabase release/);
  assert.deepEqual(sortOfficialReleases([
    "self-hosted/v0.7.1", "self-hosted/v0.8.0", "self-hosted/v0.7.2",
  ]), ["self-hosted/v0.8.0", "self-hosted/v0.7.2", "self-hosted/v0.7.1"]);
});

test("Docker published port discovery handles IPv4, IPv6, and JSON formatted output", () => {
  const output = [
    JSON.stringify("0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp"),
    JSON.stringify("127.0.0.1:8100->8000/tcp, 0.0.0.0:54321->5432/tcp"),
    "0.0.0.0:55100->6543/tcp",
  ].join("\n");
  assert.deepEqual([...parseDockerPublishedPorts(output)].sort((a, b) => a - b), [3000, 8100, 54321, 55100]);
});

test("Docker configured port discovery includes created and restarting containers", () => {
  const output = [
    `"running"\t${JSON.stringify({ "3000/tcp": [{ HostIp: "", HostPort: "3000" }] })}`,
    `"restarting"\t${JSON.stringify({ "8000/tcp": [{ HostIp: "", HostPort: "8100" }] })}`,
    `"created"\t${JSON.stringify({ "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54100" }] })}`,
    `"exited"\t${JSON.stringify({ "6543/tcp": [{ HostIp: "", HostPort: "55100" }] })}`,
  ].join("\n");
  assert.deepEqual([...parseDockerConfiguredPorts(output)].sort((a, b) => a - b), [3000, 8100, 54100]);
});

test("bounded diagnostics retain the command context and final Docker error", () => {
  const output = boundedDiagnosticText(`compose progress ${"x".repeat(5_000)} final failure: read-only file system`, 300);
  assert.match(output, /^compose progress/);
  assert.match(output, /diagnostic output omitted/);
  assert.match(output, /final failure: read-only file system$/);
  assert.equal(output.length, 300);
});

test("diagnostic sanitization redacts values but preserves useful context", () => {
  const report = sanitizeDiagnostic({
    projectId,
    stage: "starting_services",
    message: "AUTH_PASSWORD=top-secret",
    logs: "Bearer eyJverylongsecretvalue1234567890",
    health: { status: "unhealthy", JWT_SECRET: "jwt-value" },
    createdAt: new Date().toISOString(),
  }, ["top-secret"]);
  assert.match(report.message, /REDACTED/);
  assert.match(report.logs ?? "", /REDACTED/);
  assert.equal((report.health as { JWT_SECRET: string }).JWT_SECRET, "[REDACTED]");
});

test("custom JWT credentials remain a consistent official-style HS256 bundle", () => {
  const token = legacyJwt("a-custom-jwt-secret-that-is-long-enough", "anon", 1_700_000_000);
  const [header, payload] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "HS256", typ: "JWT" });
  assert.equal(JSON.parse(Buffer.from(payload, "base64url").toString()).role, "anon");
  assert.equal(token.split(".").length, 3);
});

test("dotenv updates replace known values and append new official keys", () => {
  const output = patchEnv("JWT_SECRET=old\nSITE_URL=http://old\n", {
    JWT_SECRET: "new-value",
    SUPABASE_PUBLIC_URL: "http://localhost:8100",
  });
  assert.match(output, /^JWT_SECRET=new-value$/m);
  assert.match(output, /^SUPABASE_PUBLIC_URL=http:\/\/localhost:8100$/m);
  assert.doesNotMatch(output, /JWT_SECRET=old/);
});

test("official Auth receives the gateway root as its external URL", () => {
  const environment = projectPublicEnvironment({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Customer portal",
    publicUrl: "https://supabase.example.com/",
    siteUrl: "https://app.example.com/",
    dashboardUsername: "studio-admin",
  });
  assert.equal(environment.SUPABASE_PUBLIC_URL, "https://supabase.example.com");
  assert.equal(environment.API_EXTERNAL_URL, "https://supabase.example.com");
  assert.equal(environment.SITE_URL, "https://app.example.com");
  assert.doesNotMatch(environment.API_EXTERNAL_URL, /\/auth\/v1$/);
});

test("Compose version checks handle v-prefixed and major releases", () => {
  assert.equal(versionAtLeast("v2.24.4", "2.24.4"), true);
  assert.equal(versionAtLeast("2.23.9", "2.24.4"), false);
  assert.equal(versionAtLeast("5.0.1", "2.24.4"), true);
});

test("external adoption validates compatibility and never probes the supplied host", () => {
  const result = validateExternalAdoption({
    apiUrl: "https://supabase.example.com",
    dbHost: "db.example.com",
    dbPort: 5432,
    anonKey: "header.payload.signature-long-enough",
    serviceRoleKey: "header.payload.signature-long-enough",
    postgresPassword: "postgres-password-123",
    dashboardPassword: "dashboard-password-123",
    jwtSecret: "jwt-secret-that-is-at-least-32-characters-long",
    release: "self-hosted/v0.8.0",
  });
  assert.deepEqual(result, { connectivity: "not-probed", compatibility: "compatible" });
  assert.throws(() => validateExternalAdoption({
    apiUrl: "file:///etc/passwd",
    dbHost: "db.example.com",
    dbPort: 5432,
    anonKey: "header.payload.signature-long-enough",
    serviceRoleKey: "header.payload.signature-long-enough",
    postgresPassword: "postgres-password-123",
    dashboardPassword: "dashboard-password-123",
    jwtSecret: "jwt-secret-that-is-at-least-32-characters-long",
    release: "self-hosted/v0.8.0",
  }), /HTTP or HTTPS/);
});
