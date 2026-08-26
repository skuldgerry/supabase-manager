import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getManagerBrokerCredentials, MANAGER_BROKER_ENABLED } from '@/lib/api/self-hosted/managerBroker'
import { getManagerSessionAdministrator } from '@/lib/api/self-hosted/managerSession'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  const ref = req.query.ref as string
  const project = getStoredProjectByRef(ref)

  if (!project) return res.status(404).json({ data: null, error: { message: 'Project not found' } })

  if (MANAGER_BROKER_ENABLED && project.broker_project_id) {
    const administrator = getManagerSessionAdministrator(req)
    if (!administrator) return res.status(403).json({ data: null, error: { message: 'Owner or administrator access is required' } })
    try {
      const credentials = await getManagerBrokerCredentials(project.broker_project_id, administrator.primary_email)
      const insertedAt = project.inserted_at
      return res.status(200).json([
        {
          name: 'default', api_key: credentials.publishableKey, id: 'manager-publishable', type: 'publishable',
          hash: '', prefix: credentials.publishableKey.slice(0, 15), description: 'Official project publishable key', inserted_at: insertedAt,
        },
        {
          name: 'default', api_key: `${credentials.secretKey.slice(0, 15)}••••••••••••••••`, id: 'manager-secret', type: 'secret',
          hash: '', prefix: credentials.secretKey.slice(0, 15), description: 'Official project secret key', inserted_at: insertedAt,
          secret_jwt_template: { role: 'service_role' },
        },
        { name: 'anon', api_key: credentials.anonKey, id: 'anon', type: 'legacy', hash: '', prefix: '', description: 'Legacy anon API key' },
        { name: 'service_role', api_key: credentials.serviceRoleKey, id: 'service_role', type: 'legacy', hash: '', prefix: '', description: 'Legacy service_role API key' },
      ])
    } catch (error) {
      return res.status(409).json({ data: null, error: { message: error instanceof Error ? error.message : 'Credentials are unavailable' } })
    }
  }

  return res.status(200).json([
    {
      name: 'anon',
      api_key: project?.anon_key ?? process.env.SUPABASE_ANON_KEY ?? '',
      id: 'anon',
      type: 'legacy',
      hash: '',
      prefix: '',
      description: 'Legacy anon API key',
    },
    {
      name: 'service_role',
      api_key: project?.service_key ?? process.env.SUPABASE_SERVICE_KEY ?? '',
      id: 'service_role',
      type: 'legacy',
      hash: '',
      prefix: '',
      description: 'Legacy service_role API key',
    },
  ])
}
