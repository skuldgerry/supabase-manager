import type { NextApiRequest, NextApiResponse } from 'next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import handler from '../../pages/api/platform/projects/[ref]/pocketbase-migrate'

const state = vi.hoisted(() => ({
  mode: { STUDIO_AUTH_MANAGER: true, STUDIO_AUTH_GOTRUE: false }, brokerEnabled: true,
  member: null as any, projects: [] as any[], members: {} as Record<string, any[]>,
  authorize: vi.fn(), getJob: vi.fn(), startMigration: vi.fn(), encrypt: vi.fn(),
}))
vi.mock('@/lib/constants', () => state.mode)
vi.mock('@/lib/api/apiWrapper', () => ({ default: (req: any, res: any, callback: any) => callback(req, res) }))
vi.mock('@/lib/api/self-hosted/managerSession', () => ({ getManagerSessionMember: (req: any) => req.cookies.studio_session === 'valid' ? state.member : null }))
vi.mock('@/lib/api/self-hosted/studioGoTrue', () => ({ getGoTrueAuthMember: async () => state.member }))
vi.mock('@/pages/api/self-hosted/session', () => ({ COOKIE_NAME: 'studio_session', verifyToken: (token: string) => token === 'valid', decodeSessionPayload: () => ({}) }))
vi.mock('@/lib/api/self-hosted/membersStore', () => ({ getBaseRoleId: (id: number) => id >= 1000 ? id % 10 : id, getOrgMembers: (slug: string) => state.members[slug] ?? [] }))
vi.mock('@/lib/api/self-hosted/projectsStore', () => ({ getStoredProjects: () => state.projects, getStoredProjectByRef: (ref: string) => state.projects.find((project) => project.ref === ref) }))
vi.mock('@/lib/api/self-hosted/managerBroker', () => ({
  get MANAGER_BROKER_ENABLED() { return state.brokerEnabled }, authorizeManagerBrokerMigration: (...args: any[]) => state.authorize(...args),
  getManagerBrokerProxyConfig: (id: string) => ({ baseUrl: `http://broker.test/projects/${id}/proxy`, headers: { Authorization: 'Bearer private-fixture-token' } }),
}))
vi.mock('@/lib/api/self-hosted/pgMetaProxy', () => ({ getPgMetaProxyConfig: () => ({ pgMetaBase: 'http://meta.test/pg', projectHeaders: null }) }))
vi.mock('@/lib/api/self-hosted/util', () => ({ encryptString: (...args: any[]) => state.encrypt(...args) }))
vi.mock('@/lib/api/self-hosted/pocketbaseMigrationRunner', () => ({ getPBMigrationJob: (...args: any[]) => state.getJob(...args), startPBMigration: (...args: any[]) => state.startMigration(...args) }))

const jobId = 'aabbccddeeff0011'
async function request(method = 'POST', body: Record<string, unknown> = {}, query: Record<string, unknown> = {}, cookie = 'valid') {
  const req = { method, cookies: cookie ? { studio_session: cookie } : {}, query: { ref: 'supa-one', job: jobId, ...query },
    body: { direction: 'pb-to-supa', pb_target_id: 'project:pb-one', ...body } } as unknown as NextApiRequest
  const res = { code: 0, payload: undefined as any, setHeader: vi.fn(), status(code: number) { this.code = code; return this }, json(value: unknown) { this.payload = value; return this } }
  await handler(req, res as unknown as NextApiResponse)
  return res
}

describe('project-authorized PocketBase migrations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.stubEnv('STUDIO_MIGRATION_POCKETBASE_TARGETS', '[]')
    vi.stubEnv('DASHBOARD_PASSWORD', 'legacy-fixture-password')
    Object.assign(state.mode, { STUDIO_AUTH_MANAGER: true, STUDIO_AUTH_GOTRUE: false })
    state.brokerEnabled = true
    state.member = { gotrue_id: 'owner', primary_email: 'owner@example.test', role_ids: [1] }
    state.members = { 'org-one': [state.member], 'org-two': [state.member] }
    state.projects = [
      { ref: 'supa-one', name: 'Supabase', organization_slug: 'org-one', public_url: 'https://supa.example.test', broker_project_id: 'broker-one', service_key: '', status: 'ACTIVE_HEALTHY' },
      { ref: 'supa-two', name: 'Other Supabase', organization_slug: 'org-two', public_url: 'https://other.example.test', broker_project_id: 'broker-two', service_key: '', status: 'ACTIVE_HEALTHY' },
      { ref: 'pb-one', name: 'PocketBase', creation_mode: 'pocketbase', organization_slug: 'org-one', public_url: 'https://pb.example.test', pocketbase_admin_email: 'pb@example.test', pocketbase_admin_password: 'saved-fixture-password', status: 'ACTIVE_HEALTHY' },
    ]
    state.authorize.mockResolvedValue(new Response('{}'))
    state.encrypt.mockReturnValue('encrypted-fixture-connection')
    state.startMigration.mockReturnValue(jobId)
    state.getJob.mockReturnValue({ id: jobId, status: 'running', supaRef: 'supa-one', pbUrl: 'https://pb.example.test', pbTargetId: 'project:pb-one', pbProjectRef: 'pb-one', pbOrganizationSlug: 'org-one', logs: [] })
  })

  it.each(['pb-to-supa', 'supa-to-pb'])('starts %s for a new broker project with no local Supabase key', async (direction) => {
    const res = await request('POST', { direction, actorEmail: 'attacker@example.test', supaServiceKey: 'attacker', supaPublicUrl: 'https://attacker.test' })
    expect(res.code).toBe(202)
    expect(res.payload).toEqual({ job_id: jobId })
    expect(state.authorize).toHaveBeenLastCalledWith('broker-one', 'owner@example.test', 'org-one')
    expect(state.startMigration).toHaveBeenCalledWith(expect.objectContaining({ direction, supaRef: 'supa-one', supaPublicUrl: 'https://supa.example.test', pbProjectRef: 'pb-one', pbTargetId: 'project:pb-one', pbAdminPassword: 'saved-fixture-password', supaRequest: expect.any(Function) }))
    expect(state.startMigration.mock.calls[0][0].supaServiceKey).toBeUndefined()
    expect(JSON.stringify(res.payload)).not.toContain('fixture')
  })

  it.each(['GET', 'POST'])('denies unauthenticated %s before project data or broker operations', async (method) => {
    expect((await request(method, {}, {}, '')).code).toBe(401)
    state.member = null
    expect((await request(method)).code).toBe(401)
    expect(state.authorize).not.toHaveBeenCalled()
    expect(state.getJob).not.toHaveBeenCalled()
    expect(state.startMigration).not.toHaveBeenCalled()
  })

  it.each(['GET', 'POST'])('honors the authoritative broker rejection on %s', async (method) => {
    state.authorize.mockResolvedValue(new Response('{}', { status: 403 }))
    expect((await request(method)).code).toBe(403)
    expect(state.getJob).not.toHaveBeenCalled()
    expect(state.startMigration).not.toHaveBeenCalled()
  })

  it('denies developers, empty project scopes and a PocketBase project outside the allowed scope', async () => {
    for (const member of [{ ...state.member, role_ids: [3] }, { ...state.member, project_refs: [] }, { ...state.member, project_refs: ['supa-one'] }]) {
      state.members['org-one'] = [member]
      expect((await request()).code).toBe(403)
    }
    expect(state.startMigration).not.toHaveBeenCalled()
    state.members['org-one'] = [{ ...state.member, project_refs: ['supa-one', 'pb-one'] }]
    expect((await request()).code).toBe(202)
  })

  it('checks both organizations and filters inaccessible destinations from options', async () => {
    state.projects[2].organization_slug = 'org-two'
    state.authorize.mockImplementation(async (_project, _email, targetOrg) => new Response('{}', { status: targetOrg === 'org-two' ? 403 : 200 }))
    expect((await request()).code).toBe(403)
    const options = await request('GET', {}, { options: '1' })
    expect(options.code).toBe(200)
    expect(options.payload.targets).toEqual([])
    state.authorize.mockResolvedValue(new Response('{}'))
    expect((await request()).code).toBe(202)
  })

  it('binds polling to the exact Supabase project and rechecks destination access', async () => {
    expect((await request('GET', {}, { ref: 'supa-two' })).code).toBe(404)
    state.authorize.mockImplementation(async (_project, _email, targetOrg) => new Response('{}', { status: targetOrg ? 403 : 200 }))
    expect((await request('GET')).code).toBe(403)
    state.authorize.mockResolvedValue(new Response('{}'))
    expect((await request('GET')).code).toBe(200)
    state.getJob.mockReturnValue({ ...state.getJob(), pbOrganizationSlug: 'changed' })
    expect((await request('GET')).code).toBe(409)
  })

  it('rejects malformed job identifiers without reading migration files', async () => {
    for (const job of ['../../members', '%2e%2e', ['aabbccddeeff0011'], 'not-a-job']) expect((await request('GET', {}, { job })).code).toBe(400)
    expect(state.getJob).not.toHaveBeenCalled()
  })

  it('rejects arbitrary URLs, endpoint substitution, unknown targets and invalid directions', async () => {
    for (const body of [{ pb_target_id: 'unknown' }, { pb_url: 'http://broker:3001' }, { pb_url: 'https://pb.example.test.attacker.test' }, { pb_url: 'https://user:pass@pb.example.test' }, { pb_url: 'https://pb.example.test?next=evil' }, { direction: 'unknown' }]) {
      expect((await request('POST', body)).code).toBe(400)
    }
    expect(state.startMigration).not.toHaveBeenCalled()
  })

  it('allows a legacy URL only when it matches a registered endpoint', async () => {
    const result = await request('POST', { pb_target_id: undefined, pb_url: 'https://pb.example.test/' })
    expect(result.code).toBe(202)
    expect(state.startMigration.mock.calls[0][0].pbUrl).toBe('https://pb.example.test')
  })

  it('does not reinterpret a shared PocketBase URL as another project or collection namespace', async () => {
    state.projects.push({ ...state.projects[2], ref: 'pb-child', pocketbase_collection_prefix: 'child_' })
    expect((await request('POST', { pb_target_id: undefined, pb_url: 'https://pb.example.test' })).code).toBe(400)
    expect((await request('POST', { pb_target_id: 'project:pb-child' })).code).toBe(202)
    expect(state.startMigration).toHaveBeenLastCalledWith(expect.objectContaining({ pbProjectRef: 'pb-child', pbCollectionPrefix: 'child_' }))
  })

  it('requires explicit, organization-bound configuration for unregistered endpoints', async () => {
    vi.stubEnv('STUDIO_MIGRATION_POCKETBASE_TARGETS', JSON.stringify([{ id: 'external', name: 'Configured PocketBase', url: 'https://external.example.test/pb', organizationSlug: 'org-two' }]))
    expect((await request('POST', { pb_target_id: 'configured:external' })).code).toBe(400)
    expect((await request('POST', { pb_target_id: 'configured:external', pb_admin_email: 'fixture@example.test', pb_admin_password: 'fixture-only' })).code).toBe(202)
    expect(state.authorize).toHaveBeenLastCalledWith('broker-one', 'owner@example.test', 'org-two')
    state.members['org-two'] = [{ ...state.member, project_refs: ['supa-two'] }]
    expect((await request('POST', { pb_target_id: 'configured:external', pb_admin_email: 'fixture@example.test', pb_admin_password: 'fixture-only' })).code).toBe(403)
    vi.stubEnv('STUDIO_MIGRATION_POCKETBASE_TARGETS', '[{"id":"invalid"}]')
    expect((await request()).code).toBe(503)
  })

  it('fails closed with a missing or older broker and with an unassociated legacy Supabase record', async () => {
    state.brokerEnabled = false
    expect((await request()).code).toBe(503)
    state.brokerEnabled = true
    state.authorize.mockResolvedValue(new Response('{}', { status: 404 }))
    expect((await request()).code).toBe(404)
    expect(state.startMigration).not.toHaveBeenCalled()
    state.projects[0].broker_project_id = undefined
    expect((await request()).code).toBe(409)
  })

  it.each(['pb-to-supa', 'supa-to-pb'])('preserves authenticated legacy %s and project-bound polling', async (direction) => {
    state.mode.STUDIO_AUTH_MANAGER = false
    state.member = null // A valid legacy dashboard cookie represents its single administrator.
    state.projects[0].broker_project_id = undefined
    state.projects[0].service_key = 'legacy-fixture-service-key'
    expect((await request('POST', { direction })).code).toBe(202)
    expect((await request('GET')).code).toBe(200)
    expect((await request('POST', {}, {}, '')).code).toBe(401)
    expect(state.authorize).not.toHaveBeenCalled()
  })

  it('routes legacy manual databases through their encrypted connection instead of the default database', async () => {
    state.mode.STUDIO_AUTH_MANAGER = false
    state.member = null
    Object.assign(state.projects[0], { broker_project_id: undefined, service_key: 'legacy-fixture-key', db_host: 'db.example.test', db_port: 5433, db_user: 'legacy-user', db_password: 'fixture:password', db_name: 'legacy-db' })
    expect((await request()).code).toBe(409)
    vi.stubEnv('PG_META_CRYPTO_KEY', 'fixture-crypto-key')
    expect((await request()).code).toBe(202)
    expect(state.encrypt).toHaveBeenCalledWith('postgresql://legacy-user:fixture%3Apassword@db.example.test:5433/legacy-db')
    const fetchRequest = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchRequest)
    const connection = state.startMigration.mock.calls.at(-1)![0]
    await connection.supaRequest('/pg/query', { method: 'POST', body: '{}' })
    expect(fetchRequest).toHaveBeenLastCalledWith('http://meta.test/pg/query', expect.objectContaining({ headers: expect.objectContaining({ 'x-connection-encrypted': 'encrypted-fixture-connection' }), redirect: 'manual' }))
    await connection.supaRequest('/rest/v1/items')
    expect(fetchRequest.mock.calls.at(-1)![1].headers['x-connection-encrypted']).toBeUndefined()
  })

  it('offers a permitted Supabase selection when opened from a PocketBase project', async () => {
    const result = await request('GET', {}, { ref: 'pb-one', options: '1' })
    expect(result.code).toBe(200)
    expect(result.payload.supabaseProjects.map((project: any) => project.ref)).toEqual(['supa-one', 'supa-two'])
    expect(result.payload.targets.map((target: any) => target.id)).toEqual(['project:pb-one'])
    expect(JSON.stringify(result.payload)).not.toContain('password')
  })
})
