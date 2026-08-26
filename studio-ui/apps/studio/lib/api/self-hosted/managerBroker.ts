import type { IncomingHttpHeaders } from 'node:http'
import { readFileSync } from 'node:fs'

export const MANAGER_BROKER_ENABLED = Boolean(process.env.MANAGER_BROKER_URL)

export type ManagerBrokerProject = {
  id: string
  name: string
  status: 'provisioning' | 'ready' | 'stopped' | 'failed' | 'deleting'
  stackRelease: string
  ownership: 'manager-owned' | 'external'
  publicUrl: string
  siteUrl: string
  ports: { api: number; dbSession: number; dbTransaction: number }
  dockerProject: string
}

export type ManagerBrokerJob = {
  id: string
  type: 'create-project' | 'delete-project' | string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  stage: string | null
  errorCode: string | null
  errorMessage: string | null
}

export type ManagerBrokerProjectView = {
  project: ManagerBrokerProject
  job?: ManagerBrokerJob
  events?: { sequence: number; stage?: string | null; level: string; message: string; createdAt: string }[]
  credentialsReady: boolean
}

export type ManagerBrokerOptions = {
  managerPublicUrl: string
  host: { id: string; name: string }
  releases: string[]
  latestRelease: string
  suggested: { api: number; dbSession: number; dbTransaction: number }
  conflicts: { field: 'api' | 'dbSession' | 'dbTransaction'; port: number; reason: string }[]
  dockerAvailable: boolean
}

export type ManagerBrokerCredentials = {
  publicUrl: string
  publishableKey: string
  secretKey: string
  anonKey: string
  serviceRoleKey: string
  database: {
    host: string
    username: string
    password: string
    sessionPort: number
    transactionPort: number
    sessionConnectionString: string
    transactionConnectionString: string
  }
}

export type ManagerBrokerSettings = {
  publicUrl: string
  siteUrl: string
  ai: {
    provider: 'openai' | 'compatible'
    baseUrl: string | null
    model: string | null
    apiKeyConfigured: boolean
  }
}

export type ManagerBrokerAiRuntime = {
  provider: 'openai' | 'compatible'
  baseUrl: string | null
  model: string | null
  apiKey: string | null
}

function configuration() {
  const baseUrl = process.env.MANAGER_BROKER_URL?.replace(/\/+$/, '')
  const tokenFile = process.env.MANAGER_INTERNAL_TOKEN_FILE
  const token =
    process.env.MANAGER_INTERNAL_TOKEN ??
    (tokenFile
      ? (() => {
          try {
            return readFileSync(tokenFile, 'utf8').trim()
          } catch {
            return ''
          }
        })()
      : '')
  if (!baseUrl || !token) throw new Error('The private manager broker is not configured')
  return { baseUrl, token }
}

async function brokerRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const { baseUrl, token } = configuration()
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `Broker request failed (${response.status})`)
  }
  return body as T
}

export function bootstrapManagerBroker(input: {
  email: string
  password: string
  displayName: string
  organizationName: string
}) {
  return brokerRequest<{ user: { id: string; email: string }; organization: { id: string; name: string }; existing: boolean }>(
    '/api/internal/v1/bootstrap',
    { method: 'POST', body: JSON.stringify(input) }
  )
}

export function authenticateManagerBroker(input: { email: string; password: string; code?: string }) {
  return brokerRequest<{ ok: boolean; mfaRequired?: boolean; user?: { id: string; email: string } }>(
    '/api/internal/v1/auth',
    { method: 'POST', body: JSON.stringify({ action: 'login', ...input }) }
  )
}

export function getManagerBrokerMfaStatus(email: string) {
  return brokerRequest<{ enabled: boolean; enrollmentPending: boolean }>(
    `/api/internal/v1/auth?email=${encodeURIComponent(email)}`
  )
}

export function updateManagerBrokerMfa(input: {
  action: 'enroll' | 'confirm' | 'disable'
  email: string
  password: string
  code?: string
}) {
  return brokerRequest<{ enabled: boolean; secret?: string; otpauthUri?: string; recoveryCodes?: string[] }>(
    '/api/internal/v1/auth',
    { method: 'POST', body: JSON.stringify(input) }
  )
}

export function createManagerBrokerProject(input: {
  name: string
  actorEmail: string
  organization: { name: string; slug: string }
  managerOrigin: string
  stackRelease?: string
  siteUrl?: string
  publicUrl?: string
  ports?: { api: number; dbSession: number; dbTransaction: number }
  dashboardUsername?: string
  customCredentials?: { postgresPassword: string; dashboardPassword: string; jwtSecret: string }
}) {
  return brokerRequest<ManagerBrokerProjectView>('/api/internal/v1/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function importManagerBrokerProject(input: {
  name: string
  actorEmail: string
  organization: { name: string; slug: string }
  publicUrl: string
  siteUrl?: string
  localApiPort: number
  dbHost: string
  dbPort: number
  dbSessionPort: number
  dbTransactionPort: number
  databaseUsername: string
  stackRelease: string
  dashboardUsername: string
  credentials: {
    postgresPassword: string
    dashboardPassword: string
    jwtSecret: string
    anonKey: string
    serviceRoleKey: string
    publishableKey?: string
    secretKey?: string
  }
}) {
  return brokerRequest<ManagerBrokerProjectView & { adoption: { connectivity: string; composeProject: string } }>(
    '/api/internal/v1/projects/import',
    { method: 'POST', body: JSON.stringify(input) }
  )
}

export function getManagerBrokerOptions(input: {
  actorEmail: string
  managerOrigin: string
  ports?: { api: number; dbSession: number; dbTransaction: number }
}) {
  const query = new URLSearchParams({ actorEmail: input.actorEmail, managerOrigin: input.managerOrigin })
  for (const [key, value] of Object.entries(input.ports ?? {})) query.set(key, String(value))
  return brokerRequest<ManagerBrokerOptions>(`/api/internal/v1/options?${query.toString()}`)
}

export function getManagerBrokerJob(jobId: string) {
  return brokerRequest<ManagerBrokerProjectView>(`/api/internal/v1/jobs/${encodeURIComponent(jobId)}`)
}

export function getManagerBrokerHealth(projectId: string, services?: string | string[]) {
  const values = services ? (Array.isArray(services) ? services : [services]).flatMap((value) => value.split(',')) : []
  const query = values.length ? `?${values.map((value) => `services=${encodeURIComponent(value)}`).join('&')}` : ''
  return brokerRequest<unknown[]>(`/api/internal/v1/projects/${encodeURIComponent(projectId)}/health${query}`)
}

export function getManagerBrokerCredentials(projectId: string, actorEmail: string) {
  return brokerRequest<ManagerBrokerCredentials>(
    `/api/internal/v1/projects/${encodeURIComponent(projectId)}/credentials?actorEmail=${encodeURIComponent(actorEmail)}`
  )
}

export function getManagerBrokerSettings(projectId: string, actorEmail: string) {
  return brokerRequest<ManagerBrokerSettings>(
    `/api/internal/v1/projects/${encodeURIComponent(projectId)}/settings?actorEmail=${encodeURIComponent(actorEmail)}`
  )
}

export function getManagerBrokerAiRuntime(projectId: string) {
  return brokerRequest<ManagerBrokerAiRuntime>(
    `/api/internal/v1/projects/${encodeURIComponent(projectId)}/settings?runtime=1`
  )
}

export function updateManagerBrokerSettings(
  projectId: string,
  input: {
    actorEmail: string
    provider: 'openai' | 'compatible'
    baseUrl?: string | null
    model?: string | null
    apiKey?: string
    clearApiKey?: boolean
  }
) {
  return brokerRequest<ManagerBrokerSettings>(
    `/api/internal/v1/projects/${encodeURIComponent(projectId)}/settings`,
    { method: 'PATCH', body: JSON.stringify(input) }
  )
}

export function deleteManagerBrokerProject(
  projectId: string,
  input: { actorEmail: string; confirmName: string }
) {
  return brokerRequest<ManagerBrokerProjectView>(
    `/api/internal/v1/projects/${encodeURIComponent(projectId)}`,
    { method: 'DELETE', body: JSON.stringify(input) }
  )
}

export function updateManagerBrokerProjectLifecycle(
  projectId: string,
  input: { actorEmail: string; action: 'start' | 'stop' | 'restart' }
) {
  return brokerRequest<ManagerBrokerProjectView>(
    `/api/internal/v1/projects/${encodeURIComponent(projectId)}/lifecycle`,
    { method: 'POST', body: JSON.stringify(input) }
  )
}

export function transferManagerBrokerProject(
  projectId: string,
  input: {
    actorEmail: string
    targetOrganization: { name: string; slug: string }
  }
) {
  return brokerRequest<ManagerBrokerProjectView>(
    `/api/internal/v1/projects/${encodeURIComponent(projectId)}/transfer`,
    { method: 'POST', body: JSON.stringify(input) }
  )
}

export function getManagerBrokerProxyConfig(projectId: string): {
  baseUrl: string
  headers: Record<string, string>
} {
  const { baseUrl, token } = configuration()
  return {
    baseUrl: `${baseUrl}/api/internal/v1/projects/${encodeURIComponent(projectId)}/proxy`,
    headers: { Authorization: `Bearer ${token}` },
  }
}

export function managerOrigin(headers: IncomingHttpHeaders): string {
  const forwardedProto = String(headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim()
  const forwardedHost = String(headers['x-forwarded-host'] ?? headers.host ?? 'localhost').split(',')[0].trim()
  return `${forwardedProto}://${forwardedHost}`
}
