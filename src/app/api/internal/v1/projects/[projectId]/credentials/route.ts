import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getRepository } from "@/lib/db/manager";
import type { ProjectId } from "@/lib/domain";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { loadProjectCredentials } from "@/lib/internal/project-view";

export const dynamic = "force-dynamic";

const querySchema = z.object({ actorEmail: z.email() });

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return Response.json({ error: "actorEmail is required" }, { status: 400 });

  const repository = getRepository();
  const project = repository.getProject((await params).projectId as ProjectId);
  const actor = repository.getUserByEmail(query.data.actorEmail);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!actor || !repository.canManageOrganization(project.organizationId, actor.id)) {
    return Response.json({ error: "Organization manager permission required" }, { status: 403 });
  }
  const credentials = await loadProjectCredentials(project.id);
  if (!credentials) return Response.json({ error: "Project credentials are not ready" }, { status: 409 });

  const host = getConfig().projectHost;
  const password = credentials.POSTGRES_PASSWORD;
  const encodedPassword = encodeURIComponent(password);
  const database = {
    host,
    username: project.databaseUsername,
    password,
    sessionPort: project.ports.dbSession,
    transactionPort: project.ports.dbTransaction,
    sessionConnectionString: `postgresql://${project.databaseUsername}:${encodedPassword}@${host}:${project.ports.dbSession}/postgres`,
    transactionConnectionString: `postgresql://${project.databaseUsername}:${encodedPassword}@${host}:${project.ports.dbTransaction}/postgres`,
  };
  return Response.json({
    publicUrl: project.publicUrl,
    publishableKey: credentials.SUPABASE_PUBLISHABLE_KEY,
    secretKey: credentials.SUPABASE_SECRET_KEY,
    anonKey: credentials.ANON_KEY,
    serviceRoleKey: credentials.SERVICE_ROLE_KEY,
    jwtSecret: credentials.JWT_SECRET,
    dashboard: {
      username: credentials.DASHBOARD_USERNAME ?? project.dashboardUsername,
      password: credentials.DASHBOARD_PASSWORD,
    },
    storage: {
      accessKeyId: credentials.S3_PROTOCOL_ACCESS_KEY_ID ?? null,
      secretAccessKey: credentials.S3_PROTOCOL_ACCESS_KEY_SECRET ?? null,
    },
    database,
  }, { headers: { "Cache-Control": "no-store, private" } });
}
