import { z } from 'zod'

import { getRepository } from '@/lib/db/manager'
import type { OrganizationId, ProjectId } from '@/lib/domain'
import { authorizeInternalRequest, unauthorizedInternalResponse } from '@/lib/internal/auth'
import { internalProjectView } from '@/lib/internal/project-view'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  actorEmail: z.email(),
  targetOrganization: z.object({
    name: z.string().trim().min(2).max(100),
    slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/),
  }),
})

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
    return Response.json({ error: 'Source organization manager permission required' }, { status: 403 })
  }

  let target = repository
    .listOrganizations()
    .find((organization) => organization.slug === parsed.data.targetOrganization.slug)
  if (!target) {
    target = repository.createOrganization({
      name: parsed.data.targetOrganization.name,
      slug: parsed.data.targetOrganization.slug,
      createdBy: actor.id,
    }).organization
  }
  if (!repository.canManageOrganization(target.id, actor.id)) {
    return Response.json({ error: 'Target organization manager permission required' }, { status: 403 })
  }

  try {
    const transfer = repository.transferProject({
      projectId: project.id,
      toOrganizationId: target.id as OrganizationId,
      requestedBy: actor.id,
      destinationApprovedBy: actor.id,
    })
    return Response.json({
      ...(await internalProjectView(repository.getProject(project.id)!)),
      transfer,
    })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Project could not be transferred' },
      { status: 409 }
    )
  }
}
