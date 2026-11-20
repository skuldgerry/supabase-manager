import { access, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { getConfig } from '@/lib/config'
import { getRepository } from '@/lib/db/manager'
import { dockerProjectName, type JobId, type ProjectId } from '@/lib/domain'
import { decryptJson, getMasterKey, type EncryptedEnvelope } from '@/lib/security/encryption'

import { DirectCommandRunner } from './command-runner'
import { boundedDiagnosticText, sanitizeText } from './diagnostics'
import { DockerCliHostDriver } from './docker-driver'
import { deploymentContainers, functionalCheckProject } from './broker'
import { waitForContainers } from './readiness'
import { loadProjectCredentials } from '@/lib/internal/project-view'
import { captureDeploymentDiagnostics } from './deployment-diagnostics'

const globalLifecycle = globalThis as typeof globalThis & {
  __supabaseManagerLifecycleJobs?: Map<string, Promise<void>>
}
const activeLifecycleJobs = (globalLifecycle.__supabaseManagerLifecycleJobs ??= new Map())

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false
  )
}

async function projectEnvironment(projectId: ProjectId): Promise<string> {
  const stored = getRepository().getCredential(projectId, 'project-environment')
  if (!stored) throw new Error('Encrypted project environment is unavailable')
  const envelope: EncryptedEnvelope = {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: stored.nonceBase64,
    tag: stored.authTagBase64,
    ciphertext: stored.ciphertextBase64,
  }
  return decryptJson<string>(envelope, await getMasterKey(), stored.associatedData)
}

export async function runLifecycleJob(jobId: JobId): Promise<void> {
  const repository = getRepository()
  const job = repository.getJob(jobId)
  if (
    !job?.projectId ||
    !['start-project', 'stop-project', 'restart-project'].includes(job.type) ||
    job.status === 'succeeded' ||
    job.status === 'cancelled'
  ) {
    return
  }
  const project = repository.getProject(job.projectId)
  if (!project) return

  if (project.ownership !== 'manager-owned') {
    repository.updateJobState(job.id, {
      status: 'failed',
      errorCode: 'EXTERNAL_PROJECT',
      errorMessage: 'Externally owned projects cannot be controlled through Docker lifecycle actions',
    })
    return
  }

  const projectDir = path.join(getConfig().dataDir, 'projects', project.id)
  const composePath = path.join(projectDir, 'docker-compose.yml')
  const overridePath = path.join(projectDir, 'manager.override.yml')
  const envPath = path.join(projectDir, `.env.lifecycle-${job.id}`)
  const runner = new DirectCommandRunner()
  const driver = new DockerCliHostDriver(runner)
  let secrets: string[] = []
  const stage = (message: string) => {
    repository.updateJobState(job.id, {
      status: 'running',
      stage: job.type === 'stop-project' ? 'stopping-services' : 'starting-services',
    })
    repository.appendJobEvent({
      jobId: job.id,
      stage: job.type === 'stop-project' ? 'stopping-services' : 'starting-services',
      level: 'info',
      message,
    })
  }

  try {
    if (!(await exists(composePath)) || !(await exists(overridePath))) {
      throw new Error('Manager-owned Compose configuration is unavailable')
    }
    const environment = await projectEnvironment(project.id)
    secrets = environment.split(/\r?\n/).filter((line) => /^[A-Z0-9_]*(PASSWORD|SECRET|TOKEN|KEY|JWT)/.test(line)).map((line) => line.slice(line.indexOf('=') + 1))
    await writeFile(envPath, environment, { mode: 0o600 })
    const compose = {
      files: [composePath, overridePath, ...(await exists(path.join(projectDir, 'manager.images.yml')) ? [path.join(projectDir, 'manager.images.yml')] : [])],
      envFile: envPath,
      projectName: dockerProjectName(project.id),
    } as const

    if (job.type === 'stop-project') {
      stage('Stopping project services while retaining containers and volumes')
      await driver.compose({ ...compose, args: ['stop'] })
      repository.updateProjectStatus(project.id, 'stopped')
      repository.updateJobState(job.id, { status: 'succeeded', stage: 'stopping-services' })
      repository.appendJobEvent({
        jobId: job.id,
        stage: 'stopping-services',
        level: 'info',
        message: 'Project services are stopped; containers, volumes, ports, and credentials were retained',
      })
      return
    }

    stage(job.type === 'start-project' ? 'Starting the existing project services' : 'Restarting project services')
    await driver.compose({
      ...compose,
      args: job.type === 'start-project' ? ['up', '--detach'] : ['restart'],
    })
    await waitForContainers(runner, deploymentContainers(project.id, project.stackRelease), { onProgress: (message) => repository.appendJobEvent({ jobId: job.id, stage: 'starting-services', level: 'info', message }) })
    const credentials = await loadProjectCredentials(project.id)
    if (!credentials) throw new Error('Saved project credentials are unavailable')
    await functionalCheckProject(runner, project.id, project.ports.api, credentials)
    repository.updateProjectStatus(project.id, 'ready')
    repository.updateJobState(job.id, { status: 'succeeded', stage: 'ready' })
    repository.appendJobEvent({
      jobId: job.id,
      stage: 'ready',
      level: 'info',
      message: job.type === 'start-project' ? 'Project services are ready' : 'Project restart completed',
    })
  } catch (error) {
    const message = boundedDiagnosticText(
      sanitizeText(error instanceof Error ? error.message : 'Project lifecycle action failed', secrets)
    )
    repository.updateJobState(job.id, {
      status: 'failed',
      errorCode: 'LIFECYCLE_FAILED',
      errorMessage: message,
    })
    repository.appendJobEvent({
      jobId: job.id,
      stage: repository.getJob(job.id)?.stage,
      level: 'error',
      message,
    })
    try {
      await captureDeploymentDiagnostics(runner, project.id, deploymentContainers(project.id, project.stackRelease), error, secrets, (details) => repository.appendJobEvent({ jobId: job.id, stage: repository.getJob(job.id)?.stage, level: 'error', message: `Container diagnostics: ${details.container}`, details: { ...details } }))
    } catch { /* The original lifecycle error remains authoritative. */ }
  } finally {
    await rm(envPath, { force: true }).catch(() => undefined)
  }
}

export function scheduleLifecycle(jobId: JobId): void {
  if (activeLifecycleJobs.has(jobId)) return
  const promise = Promise.resolve()
    .then(() => runLifecycleJob(jobId))
    .finally(() => activeLifecycleJobs.delete(jobId))
  activeLifecycleJobs.set(jobId, promise)
}
