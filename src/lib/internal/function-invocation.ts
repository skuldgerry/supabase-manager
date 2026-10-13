import type { ProjectId } from "../domain";

export function edgeFunctionPath(url: string, expectedOrigin?: string): string | undefined {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || /[\\\s]/.test(url)) return
    const parsed = new URL(url)
    if (parsed.username || parsed.password || parsed.hash) return
    if (expectedOrigin !== undefined) {
      const expected = new URL(expectedOrigin)
      if (!['http:', 'https:'].includes(expected.protocol) || expected.username || expected.password) return
      if (parsed.origin !== expected.origin) return
    }
    // Inspect raw segments before URL parsing can normalize traversal away.
    const rawPath = url.match(/^https?:\/\/[^/?#]*(\/[^?#]*)?/)?.[1] ?? ''
    for (const segment of rawPath.split('/')) {
      const decoded = decodeURIComponent(segment)
      if (decoded === '.' || decoded === '..' || /[/\\%]/.test(decoded)) return
    }
    if (!/^\/functions\/v[0-9]\/[^/]+(?:\/.*)?$/.test(parsed.pathname)) return
    return parsed.pathname + parsed.search
  } catch {
    return
  }
}

export class FunctionTestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export type FunctionTestInput = {
  projectId: ProjectId;
  actorEmail: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
};

export type FunctionTestProject = {
  id: ProjectId;
  publicUrl: string;
  apiPort: number;
  status: string;
  ownership: string;
};

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const ROUTING_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-connection", "forwarded"]);

export async function invokeProjectFunction(input: FunctionTestInput, dependencies: {
  getProject: (id: ProjectId) => FunctionTestProject | undefined;
  canInvoke: (project: FunctionTestProject, email: string) => boolean;
  verifyExternal: (project: FunctionTestProject) => Promise<boolean>;
  projectHost: string;
  fetch: typeof fetch;
}): Promise<Response> {
  const project = dependencies.getProject(input.projectId);
  if (!project) throw new FunctionTestError(404, "Project not found");
  if (!dependencies.canInvoke(project, input.actorEmail)) throw new FunctionTestError(403, "Organization membership required");
  if (project.status !== "ready") throw new FunctionTestError(409, "Project is not ready");
  const path = edgeFunctionPath(input.url, project.publicUrl);
  if (!path || !path.startsWith("/functions/v1/") || !METHODS.has(input.method)) {
    throw new FunctionTestError(400, "Invalid project function request");
  }
  if (project.ownership === "external" && !(await dependencies.verifyExternal(project))) {
    throw new FunctionTestError(409, "The imported project's local API port no longer matches its verified Compose deployment");
  }
  const headers = new Headers();
  try {
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      const key = name.toLowerCase();
      if (!ROUTING_HEADERS.has(key) && !key.startsWith("x-forwarded-") && key !== "x-test-authorization") headers.set(name, value);
    }
    const testAuthorization = Object.entries(input.headers ?? {}).find(([name]) => name.toLowerCase() === "x-test-authorization")?.[1];
    if (testAuthorization) headers.set("authorization", testAuthorization);
  } catch {
    throw new FunctionTestError(400, "Invalid function request headers");
  }
  // Never use the client/public URL authority for the outgoing request.
  const upstream = await dependencies.fetch(`http://${dependencies.projectHost}:${project.apiPort}${path}`, {
    method: input.method, headers,
    body: input.method === "GET" || input.method === "HEAD" ? undefined : input.body,
    redirect: "manual", cache: "no-store",
  });
  // Fetch decompresses the body but retains wire encoding/length metadata.
  // Rebuild the response so Studio never attempts a second decompression.
  const responseHeaders = new Headers(upstream.headers);
  for (const name of ["content-encoding", "content-length", "connection", "transfer-encoding", "keep-alive", "upgrade"]) responseHeaders.delete(name);
  responseHeaders.set("cache-control", "no-store");
  const noBody = input.method === "HEAD" || [204, 205, 304].includes(upstream.status);
  return new Response(noBody ? null : await upstream.arrayBuffer(), {
    status: upstream.status, statusText: upstream.statusText, headers: responseHeaders,
  });
}
