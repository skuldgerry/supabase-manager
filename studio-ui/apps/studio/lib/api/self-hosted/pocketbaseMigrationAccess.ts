import type { NextApiRequest } from 'next'
import { STUDIO_AUTH_GOTRUE, STUDIO_AUTH_MANAGER } from '@/lib/constants'
import { COOKIE_NAME, decodeSessionPayload, verifyToken } from '@/pages/api/self-hosted/session'
import { getManagerSessionMember } from './managerSession'
import { getGoTrueAuthMember } from './studioGoTrue'
import { getBaseRoleId, getOrgMembers, type StoredMember } from './membersStore'
import { getStoredProjects, type StoredProject } from './projectsStore'
import { authorizeManagerBrokerMigration, getManagerBrokerProxyConfig, MANAGER_BROKER_ENABLED } from './managerBroker'
import { getPgMetaProxyConfig } from './pgMetaProxy'
import { encryptString } from './util'

export class MigrationAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export type MigrationTarget = {
  id: string
  name: string
  url: string
  organizationSlug: string
  projectRef?: string
  collectionPrefix?: string
}
export type SupabaseMigrationRequest = (path: string, init?: RequestInit) => Promise<Response>

export const isPocketBaseProject = (project: StoredProject) =>
  project.creation_mode === 'pocketbase' || project.creation_mode === 'pocketbase-embedded'

export function migrationEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) throw new MigrationAccessError(400, 'Invalid migration endpoint')
  let url: URL
  try { url = new URL(value) } catch { throw new MigrationAccessError(400, 'Invalid migration endpoint') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new MigrationAccessError(400, 'Migration endpoints require HTTP(S), without credentials, query strings or fragments')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** Operator configuration is the trust boundary for otherwise unregistered endpoints. */
export function migrationTargets(): MigrationTarget[] {
  const registered = getStoredProjects().filter(isPocketBaseProject).map((project) => ({
    id: `project:${project.ref}`, name: project.name, url: migrationEndpoint(project.public_url),
    organizationSlug: project.organization_slug, projectRef: project.ref,
    ...(project.pocketbase_collection_prefix ? { collectionPrefix: project.pocketbase_collection_prefix } : {}),
  }))
  let configured: unknown
  try { configured = JSON.parse(process.env.STUDIO_MIGRATION_POCKETBASE_TARGETS || '[]') }
  catch { throw new MigrationAccessError(503, 'PocketBase migration target configuration is invalid') }
  if (!Array.isArray(configured) || configured.length > 100) throw new MigrationAccessError(503, 'PocketBase migration target configuration is invalid')
  const ids = new Set<string>()
  const targets = configured.map((entry): MigrationTarget => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id)
      || ids.has(entry.id) || typeof entry.name !== 'string' || !entry.name.trim()
      || typeof entry.organizationSlug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.organizationSlug)) {
      throw new MigrationAccessError(503, 'PocketBase migration target configuration is invalid')
    }
    ids.add(entry.id)
    let url: string
    try { url = migrationEndpoint(entry.url) } catch { throw new MigrationAccessError(503, 'PocketBase migration target configuration is invalid') }
    return { id: `configured:${entry.id}`, name: entry.name.trim(), url, organizationSlug: entry.organizationSlug }
  })
  return [...registered, ...targets]
}

export function selectMigrationTarget(input: { pb_target_id?: unknown; pb_project_ref?: unknown; pb_url?: unknown }): MigrationTarget {
  const targets = migrationTargets()
  if (input.pb_target_id === undefined && input.pb_project_ref === undefined && typeof input.pb_url === 'string') {
    const matches = targets.filter((entry) => entry.url === migrationEndpoint(input.pb_url))
    if (matches.length > 1) throw new MigrationAccessError(400, 'Select a PocketBase project or target ID when endpoints are shared')
  }
  const target = typeof input.pb_target_id === 'string' ? targets.find((entry) => entry.id === input.pb_target_id)
    : typeof input.pb_project_ref === 'string' ? targets.find((entry) => entry.projectRef === input.pb_project_ref)
      : typeof input.pb_url === 'string' ? targets.find((entry) => entry.url === migrationEndpoint(input.pb_url)) : undefined
  if (!target) throw new MigrationAccessError(400, 'Choose a registered PocketBase project or an administrator-configured migration endpoint')
  if ((input.pb_project_ref !== undefined && input.pb_project_ref !== target.projectRef)
    || (input.pb_url !== undefined && migrationEndpoint(input.pb_url) !== target.url)) {
    throw new MigrationAccessError(400, 'PocketBase endpoint does not match the selected migration target')
  }
  if (target.collectionPrefix && !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(target.collectionPrefix)) throw new MigrationAccessError(409, 'PocketBase collection namespace is invalid')
  return target
}

export async function migrationIdentity(req: NextApiRequest): Promise<StoredMember | null> {
  if (STUDIO_AUTH_MANAGER) {
    const member = getManagerSessionMember(req)
    if (!member) throw new MigrationAccessError(401, 'Unauthorized')
    return member
  }
  if (STUDIO_AUTH_GOTRUE) {
    const member = await getGoTrueAuthMember(req)
    if (!member) throw new MigrationAccessError(401, 'Unauthorized')
    return member
  }
  if (process.env.DASHBOARD_PASSWORD && (!req.cookies[COOKIE_NAME] || !verifyToken(req.cookies[COOKIE_NAME]))) {
    throw new MigrationAccessError(401, 'Unauthorized')
  }
  const cookie = req.cookies[COOKIE_NAME]
  const member = cookie ? getManagerSessionMember(req) : null
  if (cookie && decodeSessionPayload(cookie)?.gotrue_id && !member) throw new MigrationAccessError(401, 'Unauthorized')
  return member
}

export function requireStudioMigrationAccess(project: StoredProject, member: StoredMember | null) {
  if (!member) return // Legacy deployments may use a single dashboard administrator.
  const scoped = getOrgMembers(project.organization_slug).find((candidate) => candidate.gotrue_id === member.gotrue_id)
  const restrictions = scoped ?? member
  if (restrictions.project_refs != null && !restrictions.project_refs.includes(project.ref)) throw new MigrationAccessError(403, 'Project manager permission required')
  if (scoped && !scoped.role_ids.some((role) => [1, 2].includes(getBaseRoleId(role)))) throw new MigrationAccessError(403, 'Project manager permission required')
  if (!scoped && !STUDIO_AUTH_MANAGER) throw new MigrationAccessError(403, 'Project membership required')
}

export async function authorizeMigration(supabase: StoredProject, member: StoredMember | null, target?: MigrationTarget): Promise<void> {
  if (isPocketBaseProject(supabase)) throw new MigrationAccessError(400, 'Select a Supabase project for this migration')
  requireStudioMigrationAccess(supabase, member)
  if (target?.projectRef) {
    const pocketbase = getStoredProjects().find((project) => project.ref === target.projectRef)
    if (!pocketbase) throw new MigrationAccessError(404, 'PocketBase project not found')
    requireStudioMigrationAccess(pocketbase, member)
    if (pocketbase.status !== 'ACTIVE_HEALTHY') throw new MigrationAccessError(409, 'PocketBase project is not ready for migration')
  } else if (target && !STUDIO_AUTH_MANAGER && member) {
    const membership = getOrgMembers(target.organizationSlug).find((candidate) => candidate.gotrue_id === member.gotrue_id)
    if (!membership || membership.project_refs != null || !membership.role_ids.some((role) => [1, 2].includes(getBaseRoleId(role)))) {
      throw new MigrationAccessError(403, 'PocketBase organization manager permission required')
    }
  }
  if (STUDIO_AUTH_MANAGER) {
    if (!MANAGER_BROKER_ENABLED) throw new MigrationAccessError(503, 'Migration requires the private Manager broker')
    if (!supabase.broker_project_id || !member) throw new MigrationAccessError(409, 'Import or associate this Supabase project with the broker before migrating')
    if (target && !target.projectRef) {
      const local = getOrgMembers(target.organizationSlug).find((candidate) => candidate.gotrue_id === member.gotrue_id) ?? member
      if (local.project_refs != null) throw new MigrationAccessError(403, 'Configured endpoints require organization-scoped manager access')
    }
    let response: Response
    try { response = await authorizeManagerBrokerMigration(supabase.broker_project_id, member.primary_email, target?.organizationSlug) }
    catch { throw new MigrationAccessError(503, 'Migration authorization is unavailable') }
    if (!response.ok) {
      const status = [400, 403, 404, 409].includes(response.status) ? response.status : 503
      const message = response.status === 404 ? 'Migration requires a broker version with project migration authorization' : 'Project migration permission or readiness could not be confirmed'
      throw new MigrationAccessError(status, message)
    }
  }
}

export function supabaseMigrationConnection(project: StoredProject): { request: SupabaseMigrationRequest; secrets: string[] } {
  if (STUDIO_AUTH_MANAGER) {
    if (!project.broker_project_id) throw new MigrationAccessError(409, 'Project is not broker-managed')
    const proxy = getManagerBrokerProxyConfig(project.broker_project_id)
    const base = migrationEndpoint(proxy.baseUrl)
    return { secrets: Object.values(proxy.headers), request: (relative, init = {}) => fetch(`${base}${relative}`, {
      ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), ...proxy.headers },
      cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(30_000),
    }) }
  }
  if (!project.service_key) throw new MigrationAccessError(409, 'Supabase service credentials are unavailable')
  const gateway = migrationEndpoint(project.ref === 'default' ? process.env.SUPABASE_URL || project.public_url : project.public_url)
  const config = getPgMetaProxyConfig(project.ref)
  const metaHeaders = { ...config.projectHeaders }
  if (project.ref !== 'default' && project.db_host && !config.projectHeaders) {
    if (!process.env.PG_META_CRYPTO_KEY) throw new MigrationAccessError(409, 'Legacy database migration requires its configured pg-meta encryption key')
    const connection = `postgresql://${encodeURIComponent(project.db_user || 'postgres')}:${encodeURIComponent(project.db_password)}@${project.db_host}:${project.db_port ?? 5432}/${encodeURIComponent(project.db_name || 'postgres')}`
    metaHeaders['x-connection-encrypted'] = encryptString(connection)
  }
  // Never fall back to the default database for a different project.
  const metaBase = project.ref === 'default' || project.db_host || config.projectHeaders ? config.pgMetaBase : `${gateway}/pg-meta/v0`
  if (!metaBase) throw new MigrationAccessError(409, 'Project pg-meta endpoint is not configured')
  const meta = migrationEndpoint(metaBase)
  const headers = { apikey: project.service_key, Authorization: `Bearer ${project.service_key}` }
  return { secrets: [project.service_key, project.db_password, ...Object.values(metaHeaders)], request: (relative, init = {}) => fetch(
    relative.startsWith('/pg/') ? `${meta}${relative.slice(3)}` : `${gateway}${relative}`,
    { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), ...headers, ...(relative.startsWith('/pg/') ? metaHeaders : {}) },
      cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(30_000) },
  ) }
}
