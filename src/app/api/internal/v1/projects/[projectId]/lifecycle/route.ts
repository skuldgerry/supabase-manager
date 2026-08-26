import { z } from 'zod'

import { getRepository } from '@/lib/db/manager'
import type { JobType, ProjectId } from '@/lib/domain'
import { authorizeInternalRequest, unauthorizedInternalResponse } from '@/lib/internal/auth'
import { internalProjectView } from '@/lib/internal/project-view'
import { scheduleLifecycle } from '@/lib/orchestrator/lifecycle'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  actorEmail: z.email(),
  action: z.enum(['start', 'stop', 'restart']),
})

const jobTypeByAction = {
  start: 'start-project',
  stop: 'stop-project',
  restart: 'restart-project',
} as const satisfies Record<'start' | 'stop' | 'restart', JobType>

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse()

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 })
  }

  const repository = getRepository()
  const project = repository.getProject((await params).projectId as ProjectId)
  const actor = repository.getUserByEmail(parsed.data.actorEmail)
  if (!project) return Response.json({ error: 'Project not found' }, { status: 404 })
  if (!actor || !repository.canManageOrganization(project.organizationId, actor.id)) {
    return Response.json({ error: 'Organization manager permission required' }, { status: 403 })
  }
  if (project.ownership !== 'manager-owned') {
    return Response.json(
      { error: 'Externally managed projects cannot be controlled by the broker' },
      { status: 409 }
    )
  }

  const action = parsed.data.action
  if (action === 'start' && project.status !== 'stopped') {
    return Response.json({ error: 'Only a paused project can be resumed' }, { status: 409 })
  }
  if (action !== 'start' && project.status !== 'ready') {
    return Response.json({ error: 'The project must be ready for this action' }, { status: 409 })
  }

  const existing = repository
    .listRunnableJobs()
    .find(
      (job) =>
        job.projectId === project.id &&
        ['start-project', 'stop-project', 'restart-project'].includes(job.type)
    )
  if (existing) {
    return Response.json(await internalProjectView(project, existing), { status: 202 })
  }

  const job = repository.createJob({
    type: jobTypeByAction[action],
    projectId: project.id,
    requestedBy: actor.id,
    maxAttempts: 1,
  })
  repository.appendJobEvent({
    jobId: job.id,
    stage: action === 'stop' ? 'stopping-services' : 'starting-services',
    level: 'info',
    message: `${action[0].toUpperCase()}${action.slice(1)} project request accepted`,
  })
  scheduleLifecycle(job.id)
  return Response.json(await internalProjectView(project, job), { status: 202 })
}
