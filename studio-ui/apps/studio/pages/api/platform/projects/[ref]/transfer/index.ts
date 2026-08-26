import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { transferManagerBrokerProject } from '@/lib/api/self-hosted/managerBroker'
import { getManagerSessionAdministrator } from '@/lib/api/self-hosted/managerSession'
import { getStoredOrganizationBySlug } from '@/lib/api/self-hosted/organizationsStore'
import { getStoredProjectByRef, updateProjectFields } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  const administrator = getManagerSessionAdministrator(req)
  if (!administrator) {
    return res.status(403).json({ data: null, error: { message: 'Owner or administrator access is required' } })
  }
  const project = getStoredProjectByRef(String(req.query.ref))
  const target = getStoredOrganizationBySlug(String(req.body?.target_organization_slug ?? ''))
  if (!project?.broker_project_id) {
    return res.status(404).json({ data: null, error: { message: 'Broker project not found' } })
  }
  if (!target) {
    return res.status(404).json({ data: null, error: { message: 'Target organization not found' } })
  }

  try {
    await transferManagerBrokerProject(project.broker_project_id, {
      actorEmail: administrator.primary_email,
      targetOrganization: { name: target.name, slug: target.slug },
    })
    updateProjectFields(project.ref, {
      organization_id: target.id,
      organization_slug: target.slug,
    })
    const updated = getStoredProjectByRef(project.ref)
    return res.status(200).json(updated)
  } catch (error) {
    return res.status(409).json({
      data: null,
      error: { message: error instanceof Error ? error.message : 'Project could not be transferred' },
    })
  }
}
