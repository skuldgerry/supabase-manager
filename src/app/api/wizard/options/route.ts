import { getAuthenticatedSession } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { getRepository } from "@/lib/db/manager";
import type { ProjectPorts } from "@/lib/orchestrator";
import { discoverProjectPorts, getRecentOfficialReleases } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

function candidatePorts(url: URL): ProjectPorts | undefined {
  const values = [url.searchParams.get("api"), url.searchParams.get("dbSession"), url.searchParams.get("dbTransaction")];
  if (values.every((value) => value === null)) return undefined;
  const [api, dbSession, dbTransaction] = values.map(Number);
  if (![api, dbSession, dbTransaction].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) return undefined;
  return { api, dbSession, dbTransaction };
}

export async function GET(request: Request) {
  if (!(await getAuthenticatedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const host = getRepository().listHosts()[0];
  if (!host) return Response.json({ error: "No Docker host is registered" }, { status: 503 });

  const [releases, ports] = await Promise.all([
    getRecentOfficialReleases(3),
    discoverProjectPorts(host.id, candidatePorts(new URL(request.url))),
  ]);
  return Response.json({
    managerPublicUrl: getConfig().publicUrl,
    host: { id: host.id, name: host.name },
    releases,
    latestRelease: releases[0],
    ...ports,
  }, { headers: { "Cache-Control": "no-store" } });
}
