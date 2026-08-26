import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getManagerBrokerJob, MANAGER_BROKER_ENABLED } from '@/lib/api/self-hosted/managerBroker'
import { getManagerSessionMember } from '@/lib/api/self-hosted/managerSession'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'
import { deleteStoredProject } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (!MANAGER_BROKER_ENABLED) return res.status(404).json({ data: null, error: { message: 'Broker is disabled' } })
  if (!getManagerSessionMember(req)) return res.status(401).json({ data: null, error: { message: 'Unauthorized' } })
  const project = getStoredProjectByRef(String(req.query.ref))
  if (!project?.broker_job_id) return res.status(404).json({ data: null, error: { message: 'Deployment job not found' } })
  try {
    const view = await getManagerBrokerJob(project.broker_job_id)
    if (view.job?.type === 'delete-project' && view.job.status === 'succeeded') deleteStoredProject(project.ref)
    return res.status(200).json(view)
  } catch (error) {
    return res.status(502).json({ data: null, error: { message: error instanceof Error ? error.message : 'Broker is unavailable' } })
  }
}
