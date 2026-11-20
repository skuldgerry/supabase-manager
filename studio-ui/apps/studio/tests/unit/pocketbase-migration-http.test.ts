import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextApiRequest, NextApiResponse } from 'next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ member: null as any, projects: [] as any[] }))
vi.mock('@/lib/constants', () => ({ STUDIO_AUTH_MANAGER: true, STUDIO_AUTH_GOTRUE: false }))
vi.mock('@/lib/api/apiWrapper', () => ({ default: (req: any, res: any, callback: any) => callback(req, res) }))
vi.mock('@/lib/api/self-hosted/managerSession', () => ({ getManagerSessionMember: (req: any) => req.cookies.studio_session === 'fixture' ? state.member : null }))
vi.mock('@/lib/api/self-hosted/studioGoTrue', () => ({ getGoTrueAuthMember: async () => null }))
vi.mock('@/pages/api/self-hosted/session', () => ({ COOKIE_NAME: 'studio_session', verifyToken: () => false, decodeSessionPayload: () => null }))
vi.mock('@/lib/api/self-hosted/membersStore', () => ({ getBaseRoleId: (id: number) => id, getOrgMembers: () => state.member ? [state.member] : [] }))
vi.mock('@/lib/api/self-hosted/projectsStore', () => ({ getStoredProjects: () => state.projects, getStoredProjectByRef: (ref: string) => state.projects.find((project) => project.ref === ref) }))
vi.mock('@/lib/api/self-hosted/pgMetaProxy', () => ({ getPgMetaProxyConfig: () => { throw new Error('Manager migrations must use the private broker') } }))
vi.mock('@/lib/api/self-hosted/util', () => ({ encryptString: () => { throw new Error('Manager migrations must not encrypt local connection strings') } }))

const token = 'fixture-private-token-0123456789abcdef0123456789abcdef'
const pbPassword = 'fixture-pocketbase-password'
const servers: Server[] = []
let dataDir = ''
let allowed = true
let redirectAuth = false
let collections: any[]
let inserts: any[]
let queries: string[]
let pbWrites: any[]
let received: string[]
let leakedRequests = 0
let handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>

async function serve(callback: (path: string, method: string, body: any, headers: any) => { code?: number; body?: unknown; location?: string }): Promise<string> {
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      const result = callback(req.url!, req.method!, raw ? JSON.parse(raw) : undefined, req.headers)
      res.writeHead(result.code ?? 200, { 'Content-Type': 'application/json', ...(result.location ? { Location: result.location } : {}) })
      res.end(JSON.stringify(result.body ?? {}))
    } catch { res.writeHead(500); res.end(JSON.stringify({ message: 'Fixture request failed' })) }
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}`
}

async function request(method: 'GET' | 'POST', body: Record<string, unknown> = {}, query: Record<string, unknown> = {}) {
  const req = { method, cookies: { studio_session: 'fixture' }, query: { ref: 'supa-one', ...query }, body: { direction: 'pb-to-supa', pb_target_id: 'project:pb-one', ...body } }
  const res = { code: 0, payload: undefined as any, setHeader() {}, status(code: number) { this.code = code; return this }, json(value: unknown) { this.payload = value; return this } }
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse)
  return res
}

async function finish(id: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const response = await request('GET', {}, { job: id })
    expect(response.code).toBe(200)
    if (['done', 'error'].includes(response.payload.status)) return response.payload
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Fixture migration did not finish')
}

describe('isolated HTTP migration workflow', () => {
  beforeEach(async () => {
    vi.resetModules()
    allowed = true; redirectAuth = false; leakedRequests = 0
    inserts = []; queries = []; pbWrites = []; received = []
    collections = [{ id: 'items', name: 'scope_items', type: 'base', fields: [{ name: 'title', type: 'text' }] }, { id: 'other', name: 'foreign_items', type: 'base', fields: [] }]
    dataDir = mkdtempSync(join(tmpdir(), 'manager-pb-migration-'))
    vi.stubEnv('STUDIO_DATA_DIR', dataDir)
    vi.stubEnv('MANAGER_INTERNAL_TOKEN', token)
    vi.stubEnv('STUDIO_MIGRATION_POCKETBASE_TARGETS', '[]')
    state.member = { gotrue_id: 'fixture-owner', primary_email: 'owner@example.test', role_ids: [1] }
    const leak = await serve(() => { leakedRequests++; return {} })
    const pocketbase = await serve((path, method, body, headers) => {
      received.push(`pb ${method} ${path}`)
      if (path.endsWith('/auth-with-password')) {
        expect(body.password).toBe(pbPassword)
        if (redirectAuth) return { code: 302, body: { message: pbPassword }, location: leak }
        return { body: { token: 'fixture-pocketbase-auth-token' } }
      }
      expect(headers.authorization).toBe('fixture-pocketbase-auth-token')
      if (path === '/api/collections?perPage=500') return { body: { items: collections } }
      if (path === '/api/collections' && method === 'POST') { pbWrites.push(body); return { code: 201, body: { id: 'items' } } }
      if (path.includes('/records') && method === 'POST') { pbWrites.push(body); return { code: 201, body: { id: 'new-record' } } }
      if (path.includes('/records')) return { body: { items: [{ id: 'fixture-record', title: 'Fictitious parcel', created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' }] } }
      return { code: 404 }
    })
    const broker = await serve((path, method, body, headers) => {
      received.push(`broker ${method} ${path}`)
      expect(headers.authorization).toBe(`Bearer ${token}`)
      const url = new URL(path, 'http://fixture')
      if (url.pathname.endsWith('/migration-access')) {
        expect(url.searchParams.get('actorEmail')).toBe('owner@example.test')
        return { code: allowed ? 200 : 403, body: allowed ? { projectId: 'broker-one' } : { error: 'Forbidden' } }
      }
      if (!allowed) return { code: 403 }
      expect(url.pathname.startsWith('/api/internal/v1/projects/broker-one/proxy/')).toBe(true)
      expect(headers.apikey).toBeUndefined()
      if (url.pathname.endsWith('/pg/query')) { queries.push(body.query); return { body: [] } }
      if (url.pathname.endsWith('/pg/tables')) return { body: [{ id: 1, name: 'items', schema: 'public' }] }
      if (url.pathname.endsWith('/pg/columns')) return { body: [{ name: 'id', data_type: 'text' }, { name: 'title', data_type: 'text' }] }
      if (url.pathname.includes('/rest/v1/') && method === 'POST') { inserts.push(body); return { code: 201 } }
      if (url.pathname.includes('/rest/v1/')) return { body: [{ id: 'source-record', title: 'Fictitious parcel' }] }
      return { code: 404 }
    })
    vi.stubEnv('MANAGER_BROKER_URL', broker)
    state.projects = [
      { ref: 'supa-one', name: 'Supabase', organization_slug: 'org-one', public_url: 'https://unused-public.example.test', broker_project_id: 'broker-one', service_key: '', status: 'ACTIVE_HEALTHY' },
      { ref: 'pb-one', name: 'PocketBase', creation_mode: 'pocketbase-embedded', pocketbase_collection_prefix: 'scope_', organization_slug: 'org-one', public_url: pocketbase, pocketbase_admin_email: 'fixture@example.test', pocketbase_admin_password: pbPassword, status: 'ACTIVE_HEALTHY' },
    ]
    handler = (await import('../../pages/api/platform/projects/[ref]/pocketbase-migrate')).default
  })

  afterEach(async () => {
    for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
    vi.unstubAllEnvs()
    if (!dataDir.startsWith(join(tmpdir(), 'manager-pb-migration-'))) throw new Error('Unexpected fixture directory')
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('imports fictitious records through the broker, scopes collections and never serializes credentials', async () => {
    const started = await request('POST')
    expect(started.code).toBe(202)
    const job = await finish(started.payload.job_id)
    expect(job.status).toBe('done')
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('public."items"')
    expect(queries.join('\n')).not.toContain('foreign_items')
    expect(inserts[0][0].title).toBe('Fictitious parcel')
    expect(job.pbProjectRef).toBe('pb-one')
    for (const secret of [token, pbPassword, 'fixture-pocketbase-auth-token']) {
      expect(JSON.stringify(job)).not.toContain(secret)
      for (const file of readdirSync(join(dataDir, 'pb-migrations'))) expect(readFileSync(join(dataDir, 'pb-migrations', file), 'utf8')).not.toContain(secret)
    }
    expect(received.some((path) => path.includes('unused-public'))).toBe(false)
    allowed = false
    expect((await request('GET', {}, { job: job.id })).code).toBe(403)
  })

  it('exports fictitious rows into the authorized PocketBase namespace', async () => {
    const started = await request('POST', { direction: 'supa-to-pb' })
    const job = await finish(started.payload.job_id)
    expect(job.status).toBe('done')
    expect(pbWrites[0]).toMatchObject({ name: 'scope_items', type: 'base', fields: [{ name: 'title', type: 'text' }] })
    expect(pbWrites[1]).toEqual({ title: 'Fictitious parcel' })
    expect(received.some((path) => path.includes('/scope_items/records'))).toBe(true)
  })

  it('quotes remote SQL identifiers and skips authentication collections', async () => {
    collections[0].name = 'scope_items"; SELECT 1; --'
    collections[0].fields[0].name = 'title"field'
    collections.push({ id: 'auth', name: 'scope_accounts', type: 'auth', fields: [] })
    const started = await request('POST')
    expect((await finish(started.payload.job_id)).status).toBe('done')
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('public."items""; SELECT 1; --"')
    expect(queries[0]).toContain('"title""field" TEXT')
    expect(queries[0]).not.toContain('accounts')
  })

  it('does not send credentials through a PocketBase redirect and redacts an echoed password', async () => {
    redirectAuth = true
    const started = await request('POST')
    const job = await finish(started.payload.job_id)
    expect(job.status).toBe('error')
    expect(leakedRequests).toBe(0)
    expect(job.logs.join('\n')).not.toContain(pbPassword)
    expect(job.logs.join('\n')).toContain('[REDACTED]')
    expect(queries).toHaveLength(0)
  })

  it('rejects unauthenticated and unauthorized requests before migration I/O', async () => {
    state.member = null
    expect((await request('POST')).code).toBe(401)
    expect(received).toHaveLength(0)
    state.member = { gotrue_id: 'fixture-owner', primary_email: 'owner@example.test', role_ids: [1] }
    allowed = false
    expect((await request('POST')).code).toBe(403)
    expect(received.some((path) => path.startsWith('pb '))).toBe(false)
  })

  it('does not read or mutate another project\'s saved task through an authorized project URL', async () => {
    const directory = join(dataDir, 'pb-migrations')
    mkdirSync(directory)
    const id = '1122334455667788'
    const file = join(directory, `${id}.json`)
    const metadata = { id, supaRef: 'foreign-project', status: 'running', direction: 'pb-to-supa', pbUrl: state.projects[1].public_url, logs: [] }
    writeFileSync(file, JSON.stringify(metadata))
    expect((await request('GET', {}, { job: id })).code).toBe(404)
    expect(JSON.parse(readFileSync(file, 'utf8')).status).toBe('running')
  })

  it('rejects non-canonical task IDs at the runner file boundary', async () => {
    const { getPBMigrationJob } = await import('../../lib/api/self-hosted/pocketbaseMigrationRunner')
    for (const id of ['../1122334455667788', '..\\1122334455667788', '%2e%2e%2f1122334455667788', '1122334455667788\n', '1122334455667788\0']) {
      expect(getPBMigrationJob(id, 'supa-one')).toBeUndefined()
    }
    expect(readdirSync(dataDir)).not.toContain('pb-migrations')
  })
})
