import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { createStoredProject, importStoredProject } from '@/lib/api/self-hosted/projectsStore'
import { importManagerBrokerProject, MANAGER_BROKER_ENABLED } from '@/lib/api/self-hosted/managerBroker'
import { getManagerSessionAdministrator } from '@/lib/api/self-hosted/managerSession'
import { getStoredOrganizationBySlug } from '@/lib/api/self-hosted/organizationsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

/**
 * POST /api/platform/projects/import
 *
 * Registers an EXISTING Supabase self-hosted deployment as a project in multi-head Studio
 * without spawning any Docker containers.
 *
 * Two connection modes:
 *
 * 1. Same-host stack (running on this Docker host, different ports):
 *    {
 *      name, public_url, db_password, anon_key, service_key, jwt_secret,
 *      kong_http_port, postgres_port, pooler_port, pooler_tenant_id
 *    }
 *
 * 2. Remote/external stack (different host):
 *    {
 *      name, public_url, db_password, anon_key, service_key, jwt_secret,
 *      db_host, db_port, db_user, db_name
 *    }
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }

  if (MANAGER_BROKER_ENABLED) {
    const administrator = getManagerSessionAdministrator(req)
    if (!administrator) {
      return res.status(403).json({ data: null, error: { message: 'Owner or administrator access is required' } })
    }
    const organization = getStoredOrganizationBySlug(String(req.body?.organization_slug ?? ''))
    if (!organization) {
      return res.status(404).json({ data: null, error: { message: 'Organization not found' } })
    }
    try {
      const view = await importManagerBrokerProject({
        name: String(req.body.name ?? '').trim(),
        actorEmail: administrator.primary_email,
        organization: { name: organization.name, slug: organization.slug },
        publicUrl: String(req.body.public_url ?? ''),
        siteUrl: req.body.site_url ? String(req.body.site_url) : undefined,
        localApiPort: Number(req.body.local_api_port),
        dbHost: String(req.body.db_host ?? ''),
        dbPort: Number(req.body.db_port),
        dbSessionPort: Number(req.body.db_session_port),
        dbTransactionPort: Number(req.body.db_transaction_port),
        databaseUsername: String(req.body.database_username ?? 'postgres'),
        stackRelease: String(req.body.stack_release ?? 'self-hosted/v0.8.0'),
        dashboardUsername: String(req.body.dashboard_username ?? 'supabase'),
        credentials: {
          postgresPassword: String(req.body.postgres_password ?? ''),
          dashboardPassword: String(req.body.dashboard_password ?? ''),
          jwtSecret: String(req.body.jwt_secret ?? ''),
          anonKey: String(req.body.anon_key ?? ''),
          serviceRoleKey: String(req.body.service_role_key ?? ''),
          ...(req.body.publishable_key ? { publishableKey: String(req.body.publishable_key) } : {}),
          ...(req.body.secret_key ? { secretKey: String(req.body.secret_key) } : {}),
        },
      })
      const project = createStoredProject({
        ref: view.project.id,
        name: view.project.name,
        organization_slug: organization.slug,
        public_url: view.project.publicUrl,
        postgres_port: view.project.ports.dbSession,
        kong_http_port: view.project.ports.api,
        pooler_port: view.project.ports.dbTransaction,
        pooler_tenant_id: view.project.id.replaceAll('-', ''),
        docker_project: view.adoption.composeProject,
        db_password: '',
        anon_key: '',
        service_key: '',
        jwt_secret: '',
        status: 'ACTIVE_HEALTHY',
        broker_project_id: view.project.id,
        stack_release: view.project.stackRelease,
        ownership: 'external',
      })
      return res.status(201).json({
        id: project.id,
        ref: project.ref,
        name: project.name,
        organization_id: project.organization_id,
        organization_slug: project.organization_slug,
        cloud_provider: project.cloud_provider,
        status: project.status,
        region: project.region,
        inserted_at: project.inserted_at,
      })
    } catch (error) {
      return res.status(409).json({
        data: null,
        error: { message: error instanceof Error ? error.message : 'Project could not be imported' },
      })
    }
  }

  const {
    name,
    organization_slug,
    public_url,
    db_password,
    anon_key,
    service_key,
    jwt_secret,
    // Same-host fields
    kong_http_port,
    postgres_port,
    pooler_port,
    pooler_tenant_id,
    docker_project,
    // Remote fields
    db_host,
    db_port,
    db_user,
    db_name,
  } = req.body as Record<string, string | number | undefined>

  // ── Validation ───────────────────────────────────────────────────────────

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ data: null, error: { message: 'name is required' } })
  }
  if (!public_url || typeof public_url !== 'string') {
    return res.status(400).json({ data: null, error: { message: 'public_url is required' } })
  }
  if (!anon_key || typeof anon_key !== 'string') {
    return res.status(400).json({ data: null, error: { message: 'anon_key is required' } })
  }
  if (!service_key || typeof service_key !== 'string') {
    return res.status(400).json({ data: null, error: { message: 'service_key is required' } })
  }
  if (!jwt_secret || typeof jwt_secret !== 'string') {
    return res.status(400).json({ data: null, error: { message: 'jwt_secret is required' } })
  }

  // Must provide at least one connection mode
  const hasSameHost = kong_http_port !== undefined
  const hasRemote = db_host !== undefined
  if (!hasSameHost && !hasRemote) {
    return res.status(400).json({
      data: null,
      error: {
        message:
          'Provide either kong_http_port (same-host stack) or db_host + db_port + db_user + db_name (remote stack)',
      },
    })
  }

  // ── Register ─────────────────────────────────────────────────────────────

  const project = importStoredProject({
    name: (name as string).trim(),
    ...(organization_slug !== undefined && { organization_slug: String(organization_slug) }),
    public_url: public_url as string,
    db_password: (db_password as string) ?? '',
    anon_key: anon_key as string,
    service_key: service_key as string,
    jwt_secret: jwt_secret as string,
    // Same-host
    ...(kong_http_port !== undefined && { kong_http_port: Number(kong_http_port) }),
    ...(postgres_port !== undefined && { postgres_port: Number(postgres_port) }),
    ...(pooler_port !== undefined && { pooler_port: Number(pooler_port) }),
    ...(pooler_tenant_id !== undefined && { pooler_tenant_id: String(pooler_tenant_id) }),
    ...(docker_project !== undefined && { docker_project: String(docker_project) }),
    // Remote
    ...(db_host !== undefined && { db_host: String(db_host) }),
    ...(db_port !== undefined && { db_port: Number(db_port) }),
    ...(db_user !== undefined && { db_user: String(db_user) }),
    ...(db_name !== undefined && { db_name: String(db_name) }),
  })

  return res.status(201).json({
    id: project.id,
    ref: project.ref,
    name: project.name,
    organization_id: project.organization_id,
    cloud_provider: project.cloud_provider,
    status: project.status,
    region: project.region,
    inserted_at: project.inserted_at,
    public_url: project.public_url,
  })
}
