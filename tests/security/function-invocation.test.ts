import test from "node:test";
import assert from "node:assert/strict";
import { invokeProjectFunction, FunctionTestError, edgeFunctionPath } from "../../src/lib/internal/function-invocation.js";
import type { ProjectId } from "../../src/lib/domain/index.js";
import * as studio from "../../studio-ui/apps/studio/lib/api/edgeFunctions.js";
import * as upstreamCopy from "../../studio-ui/lib/api/edgeFunctions.js";

const projectId = "11111111-1111-4111-8111-111111111111" as ProjectId;
const project = { id: projectId, publicUrl: "https://project.example", apiPort: 18100, status: "ready", ownership: "manager-owned" };
const invalidUrls = [
  "http://127.0.0.1:3001/functions/v1/test",
  "https://project.example.attacker.test/functions/v1/test",
  "https://project.example:444/functions/v1/test",
  "https://user:password@project.example/functions/v1/test",
  "https://project.example/functions/v1/../../auth/v1/admin",
  "https://project.example/functions/v1/%2e%2e/%2e%2e/auth/v1/admin",
  "https://project.example/functions/v1/test%2f..%2fauth",
  "https://project.example/functions/v1/%252e%252e/admin",
  "https://project.example/functions/v1/test#fragment",
  "https://project.example\\@attacker.test/functions/v1/test",
  "https://project.example/functions/v1/test\n",
  "file:///functions/v1/test",
  "https://project.example/rest/v1/test",
];

function harness(overrides: Partial<{ authorized: boolean; ready: boolean; exists: boolean; external: boolean; owned: boolean }> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const dependencies = {
    getProject: () => overrides.exists === false ? undefined : { ...project, status: overrides.ready === false ? "stopped" : "ready", ownership: overrides.external ? "external" : "manager-owned" },
    canInvoke: () => overrides.authorized !== false,
    verifyExternal: async () => overrides.owned !== false,
    projectHost: "gateway.internal",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(init?.method === "HEAD" ? null : '{"ok":true}', { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  };
  return { calls, dependencies };
}

test("all URL representations reject arbitrary authorities and traversal in broker and both Studio copies", async () => {
  for (const url of invalidUrls) {
    for (const validator of [edgeFunctionPath, studio.edgeFunctionPath, upstreamCopy.edgeFunctionPath]) {
      assert.equal(validator(url, project.publicUrl), undefined, url);
    }
    const h = harness();
    await assert.rejects(invokeProjectFunction({ projectId, actorEmail: "member@example.com", url, method: "POST" }, h.dependencies),
      (error: unknown) => error instanceof FunctionTestError && error.status === 400);
    assert.equal(h.calls.length, 0, url);
  }
});

test("project, organization membership, readiness, and imported ownership deny before any outgoing function request", async () => {
  for (const [overrides, status] of [
    [{ authorized: false }, 403], [{ exists: false }, 404], [{ ready: false }, 409],
    [{ external: true, owned: false }, 409],
  ] as const) {
    const h = harness(overrides);
    await assert.rejects(invokeProjectFunction({ projectId, actorEmail: "outsider@example.com", url: project.publicUrl + "/functions/v1/test", method: "GET" }, h.dependencies),
      (error: unknown) => error instanceof FunctionTestError && error.status === status);
    assert.equal(h.calls.length, 0);
  }
});

test("function invocation preserves selected role auth, body, query, methods and manual redirects on a trusted stored port", async () => {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    const h = harness({ external: true, owned: true });
    const response = await invokeProjectFunction({
      projectId, actorEmail: "member@example.com", method,
      url: project.publicUrl + "/functions/v1/hello/nested?q=one%20two",
      body: '{"name":"Functions"}',
      headers: { authorization: "Bearer selected-role", apikey: "function-key", "x-custom": "value", Host: "evil.test", "X-Forwarded-Host": "evil.test", "Proxy-Authorization": "secret" },
    }, h.dependencies);
    assert.equal(response.status, 200);
    assert.equal(h.calls[0].url, "http://gateway.internal:18100/functions/v1/hello/nested?q=one%20two");
    assert.equal(h.calls[0].init?.redirect, "manual");
    assert.equal(h.calls[0].init?.body, method === "GET" || method === "HEAD" ? undefined : '{"name":"Functions"}');
    const headers = new Headers(h.calls[0].init?.headers);
    assert.equal(headers.get("authorization"), "Bearer selected-role");
    assert.equal(headers.get("apikey"), "function-key");
    assert.equal(headers.get("x-custom"), "value");
    for (const key of ["host", "x-forwarded-host", "proxy-authorization"]) assert.equal(headers.get(key), null);
  }
});

test("invalid methods and headers fail without fetching", async () => {
  for (const input of [{ method: "TRACE" }, { method: "POST", headers: { "x-custom": "bad\r\nheader" } }]) {
    const h = harness();
    await assert.rejects(invokeProjectFunction({ projectId, actorEmail: "member@example.com", url: project.publicUrl + "/functions/v1/test", ...input }, h.dependencies));
    assert.equal(h.calls.length, 0);
  }
});

test("broker removes wire compression/length metadata from decoded responses and preserves no-body statuses", async () => {
  const h = harness();
  h.dependencies.fetch = (async () => new Response('{"ok":true}', {
    headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": "31", "x-function-header": "ok" },
  })) as typeof fetch;
  const result = await invokeProjectFunction({ projectId, actorEmail: "member@example.com", url: project.publicUrl + "/functions/v1/test", method: "GET" }, h.dependencies);
  assert.equal(await result.text(), '{"ok":true}');
  assert.equal(result.headers.get("content-encoding"), null);
  assert.equal(result.headers.get("content-length"), null);
  assert.equal(result.headers.get("x-function-header"), "ok");
  for (const status of [204, 205, 304]) {
    h.dependencies.fetch = (async () => new Response(null, { status })) as typeof fetch;
    const empty = await invokeProjectFunction({ projectId, actorEmail: "member@example.com", url: project.publicUrl + "/functions/v1/test", method: "GET" }, h.dependencies);
    assert.equal(empty.status, status);
    assert.equal(await empty.text(), "");
  }
});

test("Studio membership uses stable identity and rejects a different organization and empty/revoked project scope", () => {
  for (const helper of [studio.hasFunctionProjectAccess, upstreamCopy.hasFunctionProjectAccess]) {
    assert.equal(helper("user-1", "project-1", [{ gotrue_id: "user-2" }]), false);
    assert.equal(helper("user-1", "project-1", [{ gotrue_id: "user-1", project_refs: ["project-2"] }]), false);
    assert.equal(helper("user-1", "project-1", [{ gotrue_id: "user-1", project_refs: [] }]), false);
    assert.equal(helper("user-1", "project-1", [{ gotrue_id: "user-1", project_refs: ["project-1"] }]), true);
    assert.equal(helper("user-1", "project-1", [{ gotrue_id: "user-1" }]), true);
  }
});

test("self-hosted URL validation fails closed without a trusted origin while hosted URLs remain supported", () => {
  const valid = "https://uniquetwentychararef.supabase.co/functions/v1/hello-world";
  for (const api of [studio, upstreamCopy]) {
    assert.equal(api.isValidEdgeFunctionURL("http://kong:8000/functions/v1/hello", false), false);
    assert.equal(api.isValidEdgeFunctionURL("http://kong:8000/functions/v1/hello", false, "http://kong:8000"), true);
    assert.equal(api.isValidEdgeFunctionURL(valid, true), true);
    assert.equal(api.isValidEdgeFunctionURL(valid.replace(".supabase.co", "XsupabaseXco"), true), false);
  }
});

test("header matching is case insensitive, strips routing overrides and preserves impersonated function auth", () => {
  for (const api of [studio, upstreamCopy]) {
    const headers = api.edgeFunctionRequestHeaders({ Authorization: "Bearer default", "X-Test-Authorization": "Bearer role", "X-Custom": "ok", HOST: "evil.test" });
    assert.equal(headers.get("authorization"), "Bearer role");
    assert.equal(headers.get("x-test-authorization"), null);
    assert.equal(headers.get("host"), null);
    assert.equal(headers.get("x-custom"), "ok");
    assert.throws(() => api.edgeFunctionRequestHeaders({ "x-custom": 3 }));
  }
});
