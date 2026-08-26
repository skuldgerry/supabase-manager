import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getManagerSessionAdministrator } from '@/lib/api/self-hosted/managerSession'
import { getStoredOrganizationBySlug } from '@/lib/api/self-hosted/organizationsStore'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (!getManagerSessionAdministrator(req)) {
    return res.status(403).json({ data: null, error: { message: 'Owner or administrator access is required' } })
  }
  const project = getStoredProjectByRef(String(req.query.ref))
  const target = getStoredOrganizationBySlug(String(req.body?.target_organization_slug ?? ''))
  const errors: { key: string; message: string }[] = []
  if (!project) errors.push({ key: 'project', message: 'Project not found' })
  if (!target) errors.push({ key: 'target', message: 'Target organization not found' })
  if (project && target && project.organization_id === target.id) {
    errors.push({ key: 'same_organization', message: 'Project already belongs to this organization' })
  }
  return res.status(200).json({
    errors,
    warnings: [],
    info: [{ key: 'metadata_only', message: 'Organization transfer changes manager ownership only. The official Supabase stack is not restarted or modified.' }],
    members_exceeding_free_project_limit: [],
    source_subscription_plan: 'enterprise',
    target_subscription_plan: target?.plan.id ?? 'free',
    has_access_to_target_organization: Boolean(target),
    has_permissions_on_source_organization: Boolean(project),
    valid: errors.length === 0,
  })
}
