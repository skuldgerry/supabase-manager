import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getManagerBrokerJob, MANAGER_BROKER_ENABLED } from '@/lib/api/self-hosted/managerBroker'
import { getManagerSessionAdministrator } from '@/lib/api/self-hosted/managerSession'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'
import { deleteStoredProject } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (!MANAGER_BROKER_ENABLED) return res.status(404).json({ data: null, error: { message: 'Broker is disabled' } })
  const administrator = getManagerSessionAdministrator(req)
  if (!administrator) return res.status(403).json({ data: null, error: { message: 'Owner or administrator access is required to view deployment diagnostics' } })
  const project = getStoredProjectByRef(String(req.query.ref))
  if (!project?.broker_job_id) return res.status(404).json({ data: null, error: { message: 'Deployment job not found' } })
  if (administrator.project_refs && !administrator.project_refs.includes(project.ref)) return res.status(403).json({ data: null, error: { message: 'Project access is required' } })
  try {
    const view = await getManagerBrokerJob(project.broker_job_id, administrator.primary_email)
    if (view.project.id !== project.broker_project_id) return res.status(403).json({ data: null, error: { message: 'Deployment project does not match' } })
    if (view.job?.type === 'delete-project' && view.job.status === 'succeeded') deleteStoredProject(project.ref)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json(view)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Broker is unavailable'
    return res.status(message === 'Organization manager permission required' ? 403 : 502).json({ data: null, error: { message } })
  }
}
