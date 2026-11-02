import type { NextApiRequest, NextApiResponse } from 'next'
import apiWrapper from '@/lib/api/apiWrapper'
import { recoverManagerBrokerDeployment } from '@/lib/api/self-hosted/managerBroker'
import { getManagerSessionAdministrator } from '@/lib/api/self-hosted/managerSession'
import { getStoredProjectByRef, updateProjectFields } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ error: { message: 'Method Not Allowed' } })
  }
  const administrator = getManagerSessionAdministrator(req)
  if (!administrator) return res.status(403).json({ error: { message: 'Owner or administrator access is required' } })
  const project = getStoredProjectByRef(String(req.query.ref))
  if (!project?.broker_project_id) return res.status(404).json({ error: { message: 'Broker project not found' } })
  if (administrator.project_refs && !administrator.project_refs.includes(project.ref)) return res.status(403).json({ error: { message: 'Project access is required' } })
  const mode = req.body?.mode
  if (mode !== 'verify' && mode !== 'resume') return res.status(400).json({ error: { message: 'Choose verify or resume' } })
  try {
    const view = await recoverManagerBrokerDeployment(project.broker_project_id, { actorEmail: administrator.primary_email, mode })
    updateProjectFields(project.ref, { status: 'COMING_UP', broker_job_id: view.job?.id, broker_stage: view.job?.stage ?? 'validating', broker_error: null })
    res.setHeader('Cache-Control', 'no-store')
    return res.status(202).json(view)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Deployment recovery could not be queued'
    return res.status(message === 'Organization manager permission required' ? 403 : 409).json({ error: { message } })
  }
}
