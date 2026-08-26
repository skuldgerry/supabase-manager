import { getManagerBrokerAiRuntime, MANAGER_BROKER_ENABLED } from '@/lib/api/self-hosted/managerBroker'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

export async function getManagerAiRuntime(projectRef?: string) {
  if (!MANAGER_BROKER_ENABLED || !projectRef) return null
  const project = getStoredProjectByRef(projectRef)
  if (!project?.broker_project_id) return null
  return getManagerBrokerAiRuntime(project.broker_project_id)
}
