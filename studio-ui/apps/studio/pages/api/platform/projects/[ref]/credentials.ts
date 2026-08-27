import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getManagerBrokerCredentials } from '@/lib/api/self-hosted/managerBroker'
import { getManagerSessionAdministrator } from '@/lib/api/self-hosted/managerSession'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
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

  try {
    const credentials = await getManagerBrokerCredentials(
      project.broker_project_id,
      administrator.primary_email
    )
    res.setHeader('Cache-Control', 'no-store, private')
    return res.status(200).json(credentials)
  } catch (error) {
    return res.status(409).json({
      data: null,
      error: { message: error instanceof Error ? error.message : 'Credentials are unavailable' },
    })
  }
}
