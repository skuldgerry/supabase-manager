import test from "node:test";
import assert from "node:assert/strict";
import {
  asProjectId,
  defaultPorts,
  dockerProjectName,
  ENVOY_PG17_ADAPTER,
  adapterForRelease,
  generateComposeOverride,
  parseDockerPublishedPorts,
  PortReservationRegistry,
  sanitizeDiagnostic,
  sortOfficialReleases,
  volumePlan,
} from "../../src/lib/orchestrator/index.js";
import { legacyJwt, patchEnv, versionAtLeast } from "../../src/lib/orchestrator/broker.js";

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

test("Compose version checks handle v-prefixed and major releases", () => {
  assert.equal(versionAtLeast("v2.24.4", "2.24.4"), true);
  assert.equal(versionAtLeast("2.23.9", "2.24.4"), false);
  assert.equal(versionAtLeast("5.0.1", "2.24.4"), true);
});
