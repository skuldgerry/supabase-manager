import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
type State = { token?: boolean; active?: boolean; ready?: boolean; deleted?: boolean; primaryRole?: string; targetRole?: string };
function route(state: State = {}) {
  const source = readFileSync("src/app/api/internal/v1/projects/[projectId]/migration-access/route.ts", "utf8");
  const compiledModule = { exports: {} as { GET: (request: Request, context: unknown) => Promise<Response> } };
  const repository = {
    getUserByEmail: (email: string) => email === "owner@example.test" ? { id: "owner", status: state.active === false ? "disabled" : "active" } : null,
    getProject: (id: string) => id === "project-one" ? { id, organizationId: "org-one", status: state.ready === false ? "failed" : "ready", deletedAt: state.deleted ? "deleted" : null } : null,
    listOrganizations: () => [{ id: "org-two", slug: "other-org" }],
    canManageOrganization: (organization: string) => ["owner", "admin"].includes((organization === "org-one" ? state.primaryRole : state.targetRole) ?? "owner"),
  };
  const stubs: Record<string, unknown> = {
    "@/lib/db/manager": { getRepository: () => repository },
    "@/lib/internal/auth": { authorizeInternalRequest: () => state.token !== false, unauthorizedInternalResponse: () => Response.json({ error: "Unauthorized" }, { status: 401 }) },
  };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, { module: compiledModule, exports: compiledModule.exports, require: (id: string) => stubs[id] ?? require(id), URL, Response, Request });
  return (query = "actorEmail=owner%40example.test", project = "project-one") => compiledModule.exports.GET(new Request(`http://broker/migration-access?${query}`), { params: Promise.resolve({ projectId: project }) });
}

test("migration authorization requires private authentication and an active project manager", async () => {
  assert.equal((await route({ token: false })()).status, 401);
  assert.equal((await route({ active: false })()).status, 403);
  assert.equal((await route({ primaryRole: "member" })()).status, 403);
  assert.equal((await route({ primaryRole: "readonly" })()).status, 403);
  assert.equal((await route()('actorEmail=stranger%40example.test')).status, 403);
});

test("migration authorization rejects deleted, missing and unready projects", async () => {
  assert.equal((await route({ deleted: true })()).status, 404);
  assert.equal((await route()('actorEmail=owner%40example.test', 'another-project')).status, 404);
  assert.equal((await route({ ready: false })()).status, 409);
  assert.equal((await route()('actorEmail=invalid')).status, 400);
});

test("cross-organization migration requires manager access to the destination organization", async () => {
  const query = "actorEmail=owner%40example.test&targetOrganizationSlug=other-org";
  assert.equal((await route({ targetRole: "member" })(query)).status, 403);
  assert.equal((await route()('actorEmail=owner%40example.test&targetOrganizationSlug=unknown')).status, 403);
  const response = await route({ primaryRole: "admin", targetRole: "admin" })(query);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { projectId: "project-one" });
  assert.match(response.headers.get("cache-control")!, /no-store/);
});
