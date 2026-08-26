import { NextApiRequest, NextApiResponse } from 'next'
import apiWrapper from '@/lib/api/apiWrapper'
import { getManagerBrokerHealth, MANAGER_BROKER_ENABLED } from '@/lib/api/self-hosted/managerBroker'
import { getManagerSessionAdministrator } from '@/lib/api/self-hosted/managerSession'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', ['GET']); return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } }) }
  const project = getStoredProjectByRef(String(req.query.ref ?? ''))
  if (!project) return res.status(404).json({ data: null, error: { message: 'Project not found' } })
  if (!MANAGER_BROKER_ENABLED || !project.broker_project_id) return res.status(500).json({ data: null, error: { message: 'Project health is unavailable without the manager broker' } })
  if (!getManagerSessionAdministrator(req)) return res.status(403).json({ data: null, error: { message: 'Owner or administrator access is required' } })
  try { return res.status(200).json(await getManagerBrokerHealth(project.broker_project_id, req.query.services)) }
  catch (error) { return res.status(500).json({ data: null, error: { message: error instanceof Error ? error.message : 'Project health is unavailable' } }) }
}
