import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getRepository } from "@/lib/db/manager";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { discoverProjectPorts, getRecentOfficialReleases } from "@/lib/orchestrator";
import type { ProjectPorts } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  actorEmail: z.email(),
  managerOrigin: z.url(),
  api: z.coerce.number().int().min(1).max(65535).optional(),
  dbSession: z.coerce.number().int().min(1).max(65535).optional(),
  dbTransaction: z.coerce.number().int().min(1).max(65535).optional(),
});

function publicUrl(origin: string, port: number): string {
  const value = new URL(origin || getConfig().publicUrl);
  value.port = String(port);
  value.pathname = "";
  value.search = "";
  value.hash = "";
  return value.origin;
}

export async function GET(request: Request) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  const repository = getRepository();
  const actor = repository.getUserByEmail(parsed.data.actorEmail);
  if (!actor) return Response.json({ error: "Broker administrator not found" }, { status: 409 });
  const host = repository.listHosts()[0];
  if (!host) return Response.json({ error: "No Docker host is registered" }, { status: 503 });
  const candidates: ProjectPorts | undefined = parsed.data.api && parsed.data.dbSession && parsed.data.dbTransaction
    ? { api: parsed.data.api, dbSession: parsed.data.dbSession, dbTransaction: parsed.data.dbTransaction }
    : undefined;
  const [releases, ports] = await Promise.all([
    getRecentOfficialReleases(3),
    discoverProjectPorts(host.id, candidates),
  ]);
  return Response.json({
    managerPublicUrl: publicUrl(parsed.data.managerOrigin, ports.suggested.api),
    host: { id: host.id, name: host.name },
    releases,
    latestRelease: releases[0],
    ...ports,
  }, { headers: { "Cache-Control": "no-store" } });
}
