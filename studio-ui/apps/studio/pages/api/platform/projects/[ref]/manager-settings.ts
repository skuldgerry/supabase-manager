import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getManagerBrokerSettings, MANAGER_BROKER_ENABLED, updateManagerBrokerSettings } from '@/lib/api/self-hosted/managerBroker'
import { getManagerSessionAdministrator } from '@/lib/api/self-hosted/managerSession'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!MANAGER_BROKER_ENABLED) return res.status(404).json({ data: null, error: { message: 'Broker is disabled' } })
  const administrator = getManagerSessionAdministrator(req)
  if (!administrator) return res.status(403).json({ data: null, error: { message: 'Owner or administrator access is required' } })
  const project = getStoredProjectByRef(String(req.query.ref))
  if (!project?.broker_project_id) return res.status(404).json({ data: null, error: { message: 'Broker project not found' } })
  try {
    if (req.method === 'GET') return res.status(200).json(await getManagerBrokerSettings(project.broker_project_id, administrator.primary_email))
    if (req.method === 'PATCH') {
      const { provider, baseUrl, model, apiKey, clearApiKey } = req.body ?? {}
      return res.status(200).json(await updateManagerBrokerSettings(project.broker_project_id, {
        actorEmail: administrator.primary_email, provider, baseUrl, model, apiKey, clearApiKey,
      }))
    }
    res.setHeader('Allow', ['GET', 'PATCH'])
    return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  } catch (error) {
    return res.status(409).json({ data: null, error: { message: error instanceof Error ? error.message : 'Settings are unavailable' } })
  }
}
