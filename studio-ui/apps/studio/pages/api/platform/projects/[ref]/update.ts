import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  getManagerBrokerProjectUpdateOptions,
  updateManagerBrokerProjectRelease,
} from '@/lib/api/self-hosted/managerBroker'
import { getManagerSessionAdministrator } from '@/lib/api/self-hosted/managerSession'
import { getStoredProjectByRef, updateProjectFields } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const administrator = getManagerSessionAdministrator(req)
  if (!administrator) {
    return res.status(403).json({ data: null, error: { message: 'Owner or administrator access is required' } })
  }
  const project = getStoredProjectByRef(String(req.query.ref))
  if (!project?.broker_project_id) {
    return res.status(404).json({ data: null, error: { message: 'Broker project not found' } })
  }

  if (req.method === 'GET') {
    try {
      const options = await getManagerBrokerProjectUpdateOptions(
        project.broker_project_id,
        administrator.primary_email
      )
      return res.status(200).json(options)
    } catch (error) {
      return res.status(502).json({ data: null, error: { message: error instanceof Error ? error.message : 'Release catalog is unavailable' } })
    }
  }

  if (req.method === 'POST') {
    try {
      const targetRelease = String(req.body?.targetRelease ?? '')
      const view = await updateManagerBrokerProjectRelease(project.broker_project_id, {
        actorEmail: administrator.primary_email,
        targetRelease,
      })
      updateProjectFields(project.ref, {
        status: 'COMING_UP',
        broker_job_id: view.job?.id,
        broker_stage: view.job?.stage ?? 'validating',
        broker_error: null,
      })
      return res.status(202).json({ jobId: view.job?.id, targetRelease })
    } catch (error) {
      return res.status(409).json({ data: null, error: { message: error instanceof Error ? error.message : 'Project update failed' } })
    }
  }

  res.setHeader('Allow', ['GET', 'POST'])
  return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
}
