import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { updateManagerBrokerProjectLifecycle } from '@/lib/api/self-hosted/managerBroker'
import { getManagerSessionAdministrator } from '@/lib/api/self-hosted/managerSession'
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
  if (!project?.broker_project_id) {
    return res.status(404).json({ data: null, error: { message: 'Broker project not found' } })
  }
  const action = req.body?.action
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ data: null, error: { message: 'Invalid lifecycle action' } })
  }

  try {
    const view = await updateManagerBrokerProjectLifecycle(project.broker_project_id, {
      actorEmail: administrator.primary_email,
      action,
    })
    updateProjectFields(project.ref, {
      status: action === 'start' ? 'COMING_UP' : project.status,
      broker_job_id: view.job?.id,
      broker_stage: view.job?.stage ?? (action === 'stop' ? 'stopping-services' : 'starting-services'),
      broker_error: null,
    })
    return res.status(202).json({ jobId: view.job?.id, action })
  } catch (error) {
    return res.status(409).json({
      data: null,
      error: { message: error instanceof Error ? error.message : 'Project lifecycle action failed' },
    })
  }
}
