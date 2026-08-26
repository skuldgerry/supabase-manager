import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getManagerBrokerCredentials, MANAGER_BROKER_ENABLED } from '@/lib/api/self-hosted/managerBroker'
import { getManagerSessionAdministrator } from '@/lib/api/self-hosted/managerSession'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  const project = getStoredProjectByRef(String(req.query.ref))
  const id = String(req.query.id)
  if (!project) return res.status(404).json({ data: null, error: { message: 'Project not found' } })
  if (!MANAGER_BROKER_ENABLED || !project.broker_project_id) return res.status(404).json({ data: null, error: { message: 'API key not found' } })
  const administrator = getManagerSessionAdministrator(req)
  if (!administrator) return res.status(403).json({ data: null, error: { message: 'Owner or administrator access is required' } })
  const credentials = await getManagerBrokerCredentials(project.broker_project_id, administrator.primary_email)
  if (id === 'manager-secret') return res.status(200).json({ id, type: 'secret', name: 'default', api_key: credentials.secretKey })
  if (id === 'manager-publishable') return res.status(200).json({ id, type: 'publishable', name: 'default', api_key: credentials.publishableKey })
  return res.status(404).json({ data: null, error: { message: 'API key not found' } })
}
