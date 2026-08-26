import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getRepository } from "@/lib/db/manager";
import type { HostId, OrganizationId } from "@/lib/domain";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { internalProjectView } from "@/lib/internal/project-view";
import { adapterForRelease, discoverProjectPorts } from "@/lib/orchestrator";
import { validateProjectPorts } from "@/lib/orchestrator";
import { scheduleProvisioning } from "@/lib/orchestrator/broker";
import { encryptJson, getMasterKey } from "@/lib/security/encryption";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  name: z.string().trim().min(2).max(100),
  actorEmail: z.email(),
  organization: z.object({
    name: z.string().trim().min(2).max(100),
    slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/),
  }),
  managerOrigin: z.url(),
  stackRelease: z.string().trim().min(1).max(100).default("self-hosted/v0.8.0"),
  siteUrl: z.url().optional(),
  publicUrl: z.url().optional(),
  ports: z.object({
    api: z.number().int().min(1).max(65535),
    dbSession: z.number().int().min(1).max(65535),
    dbTransaction: z.number().int().min(1).max(65535),
  }).optional(),
  dashboardUsername: z.string().trim().min(3).max(64).default("supabase"),
  customCredentials: z.object({
    postgresPassword: z.string().min(12).max(256).refine((value) => !/[\r\n]/.test(value), "Line breaks are not allowed"),
    dashboardPassword: z.string().min(12).max(256).refine((value) => !/[\r\n]/.test(value), "Line breaks are not allowed"),
    jwtSecret: z.string().min(32).max(512).refine((value) => !/[\r\n]/.test(value), "Line breaks are not allowed"),
  }).optional(),
});

function projectPublicUrl(origin: string, port: number): string {
  const url = new URL(origin);
  url.port = String(port);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

export async function POST(request: Request) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });

  try {
    adapterForRelease(parsed.data.stackRelease);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unsupported release" }, { status: 400 });
  }

  const repository = getRepository();
  const actor = repository.getUserByEmail(parsed.data.actorEmail);
  if (!actor) return Response.json({ error: "Broker administrator not found" }, { status: 409 });

  let organization = repository.listOrganizations().find((item) => item.slug === parsed.data.organization.slug);
  if (!organization) {
    organization = repository.createOrganization({
      name: parsed.data.organization.name,
      slug: parsed.data.organization.slug,
      createdBy: actor.id,
    }).organization;
  }
  if (!repository.canManageOrganization(organization.id, actor.id)) {
    return Response.json({ error: "Administrator cannot manage this organization" }, { status: 403 });
  }

  const host = repository.listHosts()[0];
  if (!host) return Response.json({ error: "No Docker host is registered" }, { status: 503 });
  const discovery = await discoverProjectPorts(host.id, parsed.data.ports);
  if (!discovery.dockerAvailable) {
    return Response.json({ error: "The Docker daemon is unavailable" }, { status: 503 });
  }
  const ports = parsed.data.ports ?? discovery.suggested;
  try {
    validateProjectPorts(ports);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid project ports" }, { status: 400 });
  }
  const conflicts = discovery.conflicts;
  if (conflicts.length > 0) {
    return Response.json({ error: `Project port ${conflicts[0].port} is already in use` }, { status: 409 });
  }
  const publicUrl = parsed.data.publicUrl ?? projectPublicUrl(parsed.data.managerOrigin || getConfig().publicUrl, ports.api);
  const siteUrl = parsed.data.siteUrl ?? publicUrl;

  try {
    const deployment = repository.createProjectDeployment({
      organizationId: organization.id as OrganizationId,
      hostId: host.id as HostId,
      name: parsed.data.name,
      slug: parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project",
      stackRelease: parsed.data.stackRelease,
      publicUrl,
      siteUrl,
      ports,
      databaseUsername: "postgres",
      dashboardUsername: parsed.data.dashboardUsername,
      createdBy: actor.id,
    });
    if (parsed.data.customCredentials) {
      const associatedData = `${deployment.project.id}:provisioning-input`;
      const encrypted = encryptJson(parsed.data.customCredentials, await getMasterKey(), associatedData);
      repository.upsertCredential({
        projectId: deployment.project.id,
        kind: "other",
        name: "provisioning-input",
        ciphertextBase64: encrypted.ciphertext,
        nonceBase64: encrypted.iv,
        authTagBase64: encrypted.tag,
        associatedData,
      });
    }
    scheduleProvisioning(deployment.job.id);
    return Response.json(await internalProjectView(deployment.project, deployment.job), { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Project could not be queued" }, { status: 409 });
  }
}
