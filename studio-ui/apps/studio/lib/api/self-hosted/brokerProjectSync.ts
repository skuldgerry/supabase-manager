import { getManagerBrokerJob, MANAGER_BROKER_ENABLED } from './managerBroker'
import {
  deleteStoredProject,
  getStoredProjectByRef,
  getStoredProjects,
  updateProjectFields,
  type StoredProject,
} from './projectsStore'

function localStatus(status: string): string {
  if (status === 'ready') return 'ACTIVE_HEALTHY'
  if (status === 'failed' || status === 'stopped') return 'INACTIVE'
  return 'COMING_UP'
}

async function sync(project: StoredProject): Promise<void> {
  if (!project.broker_job_id) return
  const view = await getManagerBrokerJob(project.broker_job_id)
  if (view.job?.type === 'delete-project' && view.job.status === 'succeeded') {
    deleteStoredProject(project.ref)
    return
  }
  updateProjectFields(project.ref, {
    status: localStatus(view.project.status),
    broker_stage: view.job?.stage ?? null,
    broker_error: view.job?.errorMessage ?? null,
    public_url: view.project.publicUrl,
    postgres_port: view.project.ports.dbSession,
    kong_http_port: view.project.ports.api,
    pooler_port: view.project.ports.dbTransaction,
    docker_project: view.project.dockerProject,
    stack_release: view.project.stackRelease,
  })
}

export async function syncBrokerProject(ref: string): Promise<void> {
  if (!MANAGER_BROKER_ENABLED) return
  const project = getStoredProjectByRef(ref)
  if (!project) return
  try {
    await sync(project)
  } catch (error) {
    updateProjectFields(ref, {
      broker_error: error instanceof Error ? error.message : 'Broker status is unavailable',
    })
  }
}

export async function syncBrokerProjects(): Promise<void> {
  if (!MANAGER_BROKER_ENABLED) return
  await Promise.all(getStoredProjects().map(sync).map((promise) => promise.catch(() => undefined)))
}
