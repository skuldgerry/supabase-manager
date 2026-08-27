import { z } from 'zod'

import { getRepository } from '@/lib/db/manager'
import type { ProjectId } from '@/lib/domain'
import { authorizeInternalRequest, unauthorizedInternalResponse } from '@/lib/internal/auth'
import { internalProjectView } from '@/lib/internal/project-view'
import { adapterForRelease } from '@/lib/orchestrator/adapters'
import { scheduleUpdate } from '@/lib/orchestrator/broker'
import { getRecentOfficialReleases } from '@/lib/orchestrator/release-catalog'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  actorEmail: z.email(),
  targetRelease: z.string().trim().regex(/^self-hosted\/v\d+\.\d+\.\d+$/),
})
const querySchema = z.object({ actorEmail: z.email() })

function version(release: string): number[] {
  return release.match(/v(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number) ?? [0, 0, 0]
}

function isNewer(target: string, current: string): boolean {
  const left = version(target)
  const right = version(current)
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0)
  }
  return false
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse()
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) return Response.json({ error: 'actorEmail is required' }, { status: 400 })

  const repository = getRepository()
  const project = repository.getProject((await params).projectId as ProjectId)
  const actor = repository.getUserByEmail(parsed.data.actorEmail)
  if (!project) return Response.json({ error: 'Project not found' }, { status: 404 })
  if (!actor || !repository.canManageOrganization(project.organizationId, actor.id)) {
    return Response.json({ error: 'Organization manager permission required' }, { status: 403 })
  }
  const releases = await getRecentOfficialReleases(3)
  return Response.json({
    currentRelease: project.stackRelease,
    ownership: project.ownership,
    releases,
    latestRelease: releases[0],
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse()
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 })

  const repository = getRepository()
  const project = repository.getProject((await params).projectId as ProjectId)
  const actor = repository.getUserByEmail(parsed.data.actorEmail)
  if (!project) return Response.json({ error: 'Project not found' }, { status: 404 })
  if (!actor || !repository.canManageOrganization(project.organizationId, actor.id)) {
    return Response.json({ error: 'Organization manager permission required' }, { status: 403 })
  }
  if (project.ownership !== 'manager-owned') {
    return Response.json({ error: 'Imported projects remain under their external operator and cannot be updated by the broker' }, { status: 409 })
  }
  if (project.status !== 'ready') {
    return Response.json({ error: 'The project must be ready before it can be updated' }, { status: 409 })
  }
  if (!isNewer(parsed.data.targetRelease, project.stackRelease)) {
    return Response.json({ error: 'Choose an official release newer than the current project release' }, { status: 409 })
  }
  try {
    adapterForRelease(parsed.data.targetRelease)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unsupported release' }, { status: 400 })
  }

  const existing = repository.listRunnableJobs().find((job) => job.projectId === project.id)
  if (existing) return Response.json(await internalProjectView(project, existing), { status: 202 })

  const job = repository.createJob({
    type: 'update-project',
    projectId: project.id,
    requestedBy: actor.id,
    maxAttempts: 1,
  })
  repository.appendJobEvent({
    jobId: job.id,
    stage: 'validating',
    level: 'info',
    message: `Project update to ${parsed.data.targetRelease} accepted`,
    details: { targetRelease: parsed.data.targetRelease },
  })
  scheduleUpdate(job.id)
  return Response.json(await internalProjectView(project, job), { status: 202 })
}
