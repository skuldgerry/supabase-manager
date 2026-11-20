import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const base = "studio-ui/apps/studio/";
function load<T>(relative: string, stubs: Record<string, unknown>): T {
  const source = ts.transpileModule(readFileSync(base + relative, "utf8"), { fileName: relative, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const compiledModule = { exports: {} };
  const localRequire = (id: string) => {
    const value = id in stubs ? stubs[id] : require(id);
    return value && typeof value === "object" && "default" in value ? { __esModule: true, ...value } : value;
  };
  runInNewContext(source, { module: compiledModule, exports: compiledModule.exports, require: localRequire, process, URL, Error, console, setTimeout, clearTimeout });
  return compiledModule.exports as T;
}

const block = ({ children }: { children?: ReactNode }) => React.createElement("div", null, children);
const button = ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) => React.createElement("button", { disabled }, children);
const ui = { Button: button, Card: block, cn: (...items: unknown[]) => items.filter((item) => typeof item === "string").join(" ") };

test("failure logs render as collapsed, escaped details with copyable diagnostic commands", () => {
  const { DeploymentDiagnosticEvent } = load<{ DeploymentDiagnosticEvent: React.ComponentType<{ event: unknown }> }>("components/interfaces/ProjectHome/DeploymentDiagnosticEvent.tsx", {
    ui,
    "@/components/ui/CopyButton": { default: ({ text }: { text: string }) => React.createElement("button", null, "Copy: ", text) },
  });
  const html = renderToStaticMarkup(React.createElement(DeploymentDiagnosticEvent, { event: { sequence: 1, level: "error", createdAt: "2026-11-02T20:39:38Z", message: "Storage diagnostics", details: { kind: "container-diagnostics", state: "unhealthy", healthOutput: "Connection refused", logs: '<script>alert("not executed")</script>', command: "docker logs --tail 100 --timestamps sm_storage", truncated: true } } }));
  assert.match(html, /<details/);
  assert.ok(!html.includes("<details open"));
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Docker healthcheck output/);
  assert.match(html, /Copy: docker logs --tail 100/);
  assert.match(html, /limited or incomplete/);
});

test("failed deployment UI distinguishes real verification, resume and destructive cleanup", () => {
  const view = { project: { name: "Fixture", status: "failed" }, job: { id: "job", type: "create-project", status: "failed", stage: "starting-services", errorMessage: "deadline exceeded" }, events: [], recovery: { canRecheck: true, canResume: false, canDelete: true } };
  let stateIndex = 0;
  const icon = () => React.createElement("span");
  const { BrokerDeploymentProgress } = load<{ BrokerDeploymentProgress: React.ComponentType<{ projectRef: string; projectName: string; organizationSlug: string }> }>("components/interfaces/ProjectHome/BrokerDeploymentProgress.tsx", {
    ui,
    react: { ...React, useState: (initial: unknown) => [stateIndex++ === 0 ? view : typeof initial === "function" ? (initial as () => unknown)() : initial, () => undefined] },
    "next/router": { useRouter: () => ({ reload: () => undefined, replace: async () => undefined }) },
    "lucide-react": { AlertTriangle: icon, Check: icon, Circle: icon, Loader2: icon },
    "@/components/layouts/Scaffold": { ScaffoldContainer: block, ScaffoldSection: block },
    "@/components/ui/TextConfirmModalWrapper": { TextConfirmModal: ({ confirmString }: { confirmString: string }) => { assert.equal(confirmString, "Fixture"); return null; } },
    "./DeploymentDiagnosticEvent": { DeploymentDiagnosticEvent: block },
  });
  const html = renderToStaticMarkup(React.createElement(BrokerDeploymentProgress, { projectRef: "fixture", projectName: "Fixture", organizationSlug: "org" }));
  assert.match(html, /Recheck deployment/);
  assert.match(html, /<button disabled="">Resume deployment/);
  assert.match(html, /Delete failed deployment/);
  assert.match(html, /does not recheck services/);
  assert.match(html, /read-only recheck never stops services/);
  assert.match(html, /permanently removes/);
});

type Request = { method: string; query: { ref: string }; body?: Record<string, string> };
function response() {
  return { code: 0, payload: undefined as unknown, setHeader: () => undefined, status(code: number) { this.code = code; return this; }, json(payload: unknown) { this.payload = payload; return this; } };
}
type Handler = { default: (req: Request, res: ReturnType<typeof response>) => Promise<unknown> };

function recoveryRoute(options: { member?: boolean; refs?: string[]; denyOrg?: boolean } = {}) {
  const calls: { projectId: string; actorEmail: string; mode: string }[] = [];
  const mutations: unknown[] = [];
  const route = load<Handler>("pages/api/platform/projects/[ref]/recovery.ts", {
    "@/lib/api/apiWrapper": { default: (req: Request, res: ReturnType<typeof response>, handler: Handler["default"]) => handler(req, res) },
    "@/lib/api/self-hosted/managerSession": { getManagerSessionAdministrator: () => options.member === false ? null : { primary_email: "owner@example.invalid", project_refs: options.refs ?? null } },
    "@/lib/api/self-hosted/projectsStore": { getStoredProjectByRef: () => ({ ref: "a", broker_project_id: "managed-a" }), updateProjectFields: (...args: unknown[]) => mutations.push(args) },
    "@/lib/api/self-hosted/managerBroker": { recoverManagerBrokerDeployment: async (projectId: string, body: { actorEmail: string; mode: string }) => { calls.push({ projectId, ...body }); if (options.denyOrg) throw new Error("Organization manager permission required"); return { job: { id: "check-a", stage: "validating" } }; } },
  });
  return { route, calls, mutations };
}

test("deployment recovery authenticates before actions and ignores caller-supplied actor identity", async () => {
  const request: Request = { method: "POST", query: { ref: "a" }, body: { mode: "verify", actorEmail: "forged@example.invalid" } };
  const fixture = recoveryRoute();
  const res = response();
  await fixture.route.default(request, res);
  assert.equal(res.code, 202);
  assert.equal(fixture.calls[0].actorEmail, "owner@example.invalid");
  assert.equal(fixture.calls[0].projectId, "managed-a");
  for (const denied of [recoveryRoute({ member: false }), recoveryRoute({ refs: ["different-project"] })]) {
    const result = response();
    await denied.route.default(request, result);
    assert.equal(result.code, 403);
    assert.deepEqual(denied.calls, []);
    assert.deepEqual(denied.mutations, []);
  }
  const foreignOrg = recoveryRoute({ denyOrg: true });
  const denied = response();
  await foreignOrg.route.default(request, denied);
  assert.equal(denied.code, 403);
  assert.deepEqual(foreignOrg.mutations, []);
});

test("deployment diagnostics require authoritative project-organization permission before exposing logs", async () => {
  let allowed = false;
  const handler = load<Handler>("pages/api/platform/projects/[ref]/deployment.ts", {
    "@/lib/api/apiWrapper": { default: (req: Request, res: ReturnType<typeof response>, next: Handler["default"]) => next(req, res) },
    "@/lib/api/self-hosted/managerSession": { getManagerSessionAdministrator: () => ({ primary_email: "owner@example.invalid", project_refs: ["a"] }) },
    "@/lib/api/self-hosted/projectsStore": { getStoredProjectByRef: () => ({ ref: "a", broker_project_id: "managed-a", broker_job_id: "job-a" }) },
    "@/lib/api/self-hosted/managerBroker": { MANAGER_BROKER_ENABLED: true, getManagerBrokerJob: async (_job: string, actor: string) => { assert.equal(actor, "owner@example.invalid"); if (!allowed) throw new Error("Organization manager permission required"); return { project: { id: "managed-a" }, job: { type: "create-project" }, events: [{ details: { logs: "private fixture logs" } }] }; } },
  });
  const req: Request = { method: "GET", query: { ref: "a" } };
  const denied = response();
  await handler.default(req, denied);
  assert.equal(denied.code, 403);
  assert.ok(!JSON.stringify(denied.payload).includes("private fixture logs"));
  allowed = true;
  const permitted = response();
  await handler.default(req, permitted);
  assert.equal(permitted.code, 200);
  assert.match(JSON.stringify(permitted.payload), /private fixture logs/);
});
