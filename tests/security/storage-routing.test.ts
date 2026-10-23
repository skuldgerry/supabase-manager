import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const projectA = { ref: "a", broker_project_id: "managed-a", organization_slug: "org-a", public_url: "https://a.example", ownership: "manager-owned" };
const projectB = { ref: "b", broker_project_id: "imported-b", organization_slug: "org-b", public_url: "http://10.0.0.5:8000", ownership: "external" };

type RequestFixture = { method: string; query: Record<string, string>; body?: { id: string }; cookies: Record<string, string> };
type ModuleExports = {
  default: (req: RequestFixture, res: ReturnType<typeof response>) => Promise<unknown>;
  projectStorageUrl: (req: { query: { ref: string } }, source: string) => string;
  remapStorageUrl: (source: string, publicUrl: string) => string;
};

function harness(copy: "apps/studio" | "", allowed = true, role = 1, projectRefs: string[] | null = null, organizationMember = true, brokerManager: boolean | "unavailable" = false) {
  const base = path.resolve("studio-ui", copy);
  const member = { gotrue_id: "user-1", primary_email: "owner@example.invalid", role_ids: [role], project_refs: projectRefs };
  const load = (relative: string) => {
    const source = ts.transpileModule(readFileSync(path.join(base, relative), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const compiledModule = { exports: {} };
    const localRequire = (id: string): unknown => {
      if (id === "@/lib/api/self-hosted/storageClient") return helper;
      if (id.endsWith("managerBroker")) return {
        MANAGER_BROKER_ENABLED: true,
        getManagerBrokerProxyConfig: (ref: string) => ({ baseUrl: `http://broker/api/internal/v1/projects/${ref}/proxy`, headers: { Authorization: "Bearer private-broker-token" } }),
        getManagerBrokerSettings: async (id: string, email: string) => {
          assert.equal(email, member.primary_email);
          assert.ok(["managed-a", "imported-b"].includes(id));
          if (brokerManager === "unavailable") throw new Error("Broker request failed (503)");
          if (!brokerManager) throw new Error("Organization manager permission required");
          return {};
        },
      };
      if (id.endsWith("managerSession")) return { getManagerSessionMember: () => allowed ? member : null };
      if (id.endsWith("membersStore")) return { getBaseRoleId: (n: number) => n, getOrgMembers: () => organizationMember ? [member] : [] };
      if (id.endsWith("projectsStore")) return { getStoredProjectByRef: (ref: string) => ({ a: projectA, b: projectB })[ref as "a" | "b"] };
      if (id.endsWith("studioGoTrue")) return { getGoTrueAuthMember: () => null };
      if (id === "@/lib/constants") return { STUDIO_AUTH_MANAGER: true, STUDIO_AUTH_GOTRUE: false };
      return require(id);
    };
    runInNewContext(source, { module: compiledModule, exports: compiledModule.exports, require: localRequire, process, URL, Headers, Buffer, Error, console });
    return compiledModule.exports as ModuleExports;
  };
  const helper = load("lib/api/self-hosted/storageClient.ts");
  return { helper, load };
}

function response() {
  return { statusCode: 200, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; }, setHeader() { return this; } };
}

test("both Studio copies list the selected managed/imported project's buckets without global Supabase variables", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; authorization: string | null }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json([{ id: "proof", name: "proof" }]);
  };
  try {
    for (const copy of ["apps/studio", ""] as const) {
      const h = harness(copy);
      const handler = h.load("pages/api/platform/storage/[ref]/buckets/index.ts").default;
      for (const ref of ["a", "b"]) {
        const res = response();
        await handler({ method: "GET", query: { ref, limit: "100" }, cookies: {} }, res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, [{ id: "proof", name: "proof" }]);
        const call = calls.at(-1)!;
        assert.match(call.url, new RegExp(`/projects/${ref === "a" ? "managed-a" : "imported-b"}/proxy/storage/v1/bucket`));
        assert.equal(call.authorization, "Bearer private-broker-token");
      }
    }
  } finally { globalThis.fetch = original; }
});

test("missing authentication/project and read-only mutations return JSON errors before Storage access", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
  try {
    for (const copy of ["apps/studio", ""] as const) {
      for (const [allowed, role, ref, method, status] of [
        [false, 1, "a", "GET", 401], [true, 1, "missing", "GET", 404], [true, 4, "a", "POST", 403],
      ] as const) {
        const h = harness(copy, allowed, role);
        const res = response();
        await h.load("pages/api/platform/storage/[ref]/buckets/index.ts").default({ method, query: { ref }, body: { id: "bucket" }, cookies: {} }, res);
        assert.equal(res.statusCode, status);
        assert.equal(typeof (res.body as { error: { message: string } }).error.message, "string");
      }
      for (const h of [harness(copy, true, 1, []), harness(copy, true, 1, ["b"]), harness(copy, true, 1, null, false)]) {
        const res = response();
        await h.load("pages/api/platform/storage/[ref]/buckets/index.ts").default({ method: "GET", query: { ref: "a" }, cookies: {} }, res);
        assert.equal(res.statusCode, 403);
      }
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("legacy organizations require authoritative broker permission when the local member mirror is missing", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json([{ id: "proof", name: "proof" }]); };
  try {
    for (const copy of ["apps/studio", ""] as const) {
      const authorized = harness(copy, true, 1, null, false, true);
      for (const ref of ["a", "b"]) {
        const res = response();
        await authorized.load("pages/api/platform/storage/[ref]/buckets/index.ts").default({ method: "GET", query: { ref }, cookies: {} }, res);
        assert.equal(res.statusCode, 200);
      }
      const beforeDenied = calls;
      for (const [h, method, status] of [
        [harness(copy, true, 1, null, false, false), "GET", 403],
        [harness(copy, true, 1, null, false, "unavailable"), "GET", 502],
        [harness(copy, true, 4, null, true, true), "POST", 403],
        [harness(copy, true, 1, ["b"], false, true), "GET", 403],
      ] as const) {
        const res = response();
        await h.load("pages/api/platform/storage/[ref]/buckets/index.ts").default({ method, query: { ref: "a" }, body: { id: "bucket" }, cookies: {} }, res);
        assert.equal(res.statusCode, status);
      }
      assert.equal(calls, beforeDenied, "Denied or unavailable authorization must not reach Storage");
    }
  } finally { globalThis.fetch = original; }
});

test("signed/public URLs remove the private broker prefix and preserve project origin, object path and token", () => {
  for (const copy of ["apps/studio", ""] as const) {
    const { helper } = harness(copy);
    const privateUrl = "http://broker/api/internal/v1/projects/managed-a/proxy/storage/v1/object/sign/proof/a%20file.png?token=signed-object-token";
    assert.equal(helper.projectStorageUrl({ query: { ref: "a" } }, privateUrl), "https://a.example/storage/v1/object/sign/proof/a%20file.png?token=signed-object-token");
    assert.equal(helper.projectStorageUrl({ query: { ref: "b" } }, privateUrl), "http://10.0.0.5:8000/storage/v1/object/sign/proof/a%20file.png?token=signed-object-token");
    assert.throws(() => helper.remapStorageUrl(privateUrl, "file:///etc"), /invalid/);
  }
});
