import { z } from "zod";
import { getRepository } from "@/lib/db/manager";
import type { Project, ProjectId } from "@/lib/domain";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { loadProjectAiSettings, saveProjectAiSettings } from "@/lib/internal/project-view";

export const dynamic = "force-dynamic";

const actorSchema = z.object({ actorEmail: z.email() });
const updateSchema = z.object({
  actorEmail: z.email(),
  provider: z.enum(["openai", "compatible"]).default("openai"),
  baseUrl: z.url().nullable().optional(),
  model: z.string().trim().max(120).nullable().optional(),
  apiKey: z.string().trim().min(8).max(1000).optional(),
  clearApiKey: z.boolean().optional(),
});

function authorizeProject(projectId: ProjectId, actorEmail: string) {
  const repository = getRepository();
  const project = repository.getProject(projectId);
  const actor = repository.getUserByEmail(actorEmail);
  if (!project) return { error: Response.json({ error: "Project not found" }, { status: 404 }) };
  if (!actor || !repository.canManageOrganization(project.organizationId, actor.id)) {
    return { error: Response.json({ error: "Organization manager permission required" }, { status: 403 }) };
  }
  return { project };
}

function safeView(project: Project, settings: Awaited<ReturnType<typeof loadProjectAiSettings>>) {
  return {
    publicUrl: project.publicUrl,
    siteUrl: project.siteUrl,
    ai: {
      provider: settings?.provider ?? "openai",
      baseUrl: settings?.baseUrl ?? null,
      model: settings?.model ?? null,
      apiKeyConfigured: Boolean(settings?.apiKey),
    },
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const projectId = (await params).projectId as ProjectId;
  if (new URL(request.url).searchParams.get("runtime") === "1") {
    if (!getRepository().getProject(projectId)) return Response.json({ error: "Project not found" }, { status: 404 });
    return Response.json(await loadProjectAiSettings(projectId) ?? { provider: "openai", baseUrl: null, model: null, apiKey: null }, {
      headers: { "Cache-Control": "no-store, private" },
    });
  }
  const query = actorSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return Response.json({ error: "actorEmail is required" }, { status: 400 });
  const authorized = authorizeProject(projectId, query.data.actorEmail);
  if ("error" in authorized) return authorized.error;
  return Response.json(safeView(authorized.project, await loadProjectAiSettings(projectId)), { headers: { "Cache-Control": "no-store, private" } });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  const projectId = (await params).projectId as ProjectId;
  const authorized = authorizeProject(projectId, parsed.data.actorEmail);
  if ("error" in authorized) return authorized.error;
  const current = await loadProjectAiSettings(projectId);
  await saveProjectAiSettings(projectId, {
    provider: parsed.data.provider,
    baseUrl: parsed.data.baseUrl ?? null,
    model: parsed.data.model ?? null,
    apiKey: parsed.data.clearApiKey ? null : (parsed.data.apiKey ?? current?.apiKey ?? null),
  });
  return Response.json(safeView(authorized.project, await loadProjectAiSettings(projectId)), { headers: { "Cache-Control": "no-store, private" } });
}
