import { beforeEach, describe, expect, it, vi } from 'vitest'
import handler from '../../pages/api/edge-functions/test'

const state = vi.hoisted(() => ({
  mode: { IS_PLATFORM: false, STUDIO_AUTH_MANAGER: true, STUDIO_AUTH_GOTRUE: false },
  brokerEnabled: true,
  member: { gotrue_id: 'user-1', primary_email: 'member@example.com' } as { gotrue_id: string; primary_email: string } | null,
  members: [{ gotrue_id: 'user-1' }] as { gotrue_id: string; project_refs?: string[] }[],
  project: { public_url: 'https://project.example', organization_slug: 'org-one', broker_project_id: 'broker-project-1' },
  invoke: vi.fn(),
}))
vi.mock('@/lib/constants', () => state.mode)
vi.mock('@/lib/api/self-hosted/managerSession', () => ({ getManagerSessionMember: () => state.member }))
vi.mock('@/lib/api/self-hosted/projectsStore', () => ({ getStoredProjectByRef: (ref: string) => ref === 'project-one' ? state.project : undefined }))
vi.mock('@/lib/api/self-hosted/membersStore', () => ({ getOrgMembers: () => state.members }))
vi.mock('@/lib/api/self-hosted/studioGoTrue', () => ({ getGoTrueAuthMember: async () => state.member }))
vi.mock('@/lib/api/self-hosted/managerBroker', () => ({
  get MANAGER_BROKER_ENABLED() { return state.brokerEnabled },
  testManagerBrokerFunction: (...args: unknown[]) => state.invoke(...args),
}))
vi.mock('@/pages/api/self-hosted/session', () => ({
  COOKIE_NAME: 'studio_session', verifyToken: (token: string) => token === 'valid-session',
  decodeSessionPayload: () => ({ gotrue_id: 'user-1' }),
}))

async function request(body: Record<string, unknown> = {}, cookie = 'valid-session') {
  const req = {
    method: 'POST', cookies: cookie ? { studio_session: cookie } : {}, headers: {},
    body: { projectRef: 'project-one', url: 'https://project.example/functions/v1/hello?q=a%20b', method: 'POST', body: '{"hello":true}', headers: {}, ...body },
  }
  const res = {
    code: 0, payload: undefined as unknown,
    status(code: number) { this.code = code; return this },
    json(payload: unknown) { this.payload = payload; return this },
  }
  await handler(req as any, res as any)
  return res
}
describe('manager function test boundary', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    Object.assign(state.mode, { IS_PLATFORM: false, STUDIO_AUTH_MANAGER: true, STUDIO_AUTH_GOTRUE: false })
    state.member = { gotrue_id: 'user-1', primary_email: 'member@example.com' }
    state.members = [{ gotrue_id: 'user-1' }]
    state.brokerEnabled = true
    state.invoke.mockReset().mockResolvedValue(new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }))
  })
  it('denies unauthenticated users, foreign organizations and revoked/scoped memberships without invoking the broker', async () => {
    state.member = null
    expect((await request()).code).toBe(401)
    state.member = { gotrue_id: 'user-1', primary_email: 'member@example.com' }
    expect((await request({}, '')).code).toBe(401)
    for (const members of [[{ gotrue_id: 'other-user' }], [{ gotrue_id: 'user-1', project_refs: ['other-project'] }], [{ gotrue_id: 'user-1', project_refs: [] }]]) {
      state.members = members
      expect((await request()).code).toBe(403)
    }
    expect(state.invoke).not.toHaveBeenCalled()
  })
  it('denies arbitrary hosts, project IDs and normalized traversal before any broker invocation', async () => {
    for (const url of ['http://broker:3001/functions/v1/hello', 'https://project.example/functions/v1/../../api/internal', 'https://project.example/functions/v1/%252e%252e/api', 'https://project.example.attacker.test/functions/v1/hello']) {
      expect((await request({ url })).code).toBe(400)
    }
    expect((await request({ projectRef: 'other-project' })).code).toBe(404)
    expect((await request({ projectRef: undefined })).code).toBe(400)
    expect(state.invoke).not.toHaveBeenCalled()
  })
  it('fails closed when manager mode has no broker', async () => {
    state.brokerEnabled = false
    expect((await request()).code).toBe(503)
    expect(state.invoke).not.toHaveBeenCalled()
  })
  it('uses session identity and stored broker project while preserving function role, query, body and custom headers', async () => {
    const res = await request({ actorEmail: 'attacker@example.com', headers: { 'X-Test-Authorization': 'Bearer selected-role', HOST: 'broker:3001', 'X-Custom': 'ok' } })
    expect(res.code).toBe(200)
    expect(state.invoke).toHaveBeenCalledWith('broker-project-1', expect.objectContaining({
      actorEmail: 'member@example.com',
      url: 'https://project.example/functions/v1/hello?q=a%20b',
      body: '{"hello":true}',
      headers: { authorization: 'Bearer selected-role', 'content-type': 'application/json', 'x-custom': 'ok' },
    }))
    expect(res.payload).toEqual({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' })
  })
  it('preserves empty HEAD responses and OPTIONS requests', async () => {
    state.invoke.mockResolvedValueOnce(new Response(null, { headers: { 'content-type': 'application/json' } }))
    expect((await request({ method: 'HEAD' })).payload).toEqual({ status: 200, headers: { 'content-type': 'application/json' }, body: '' })
    expect(state.invoke).toHaveBeenLastCalledWith('broker-project-1', expect.objectContaining({ method: 'HEAD', body: undefined }))
    expect((await request({ method: 'OPTIONS' })).code).toBe(200)
  })
  it('constructs legacy requests on the stored gateway while preserving the path and query', async () => {
    state.mode.STUDIO_AUTH_MANAGER = false
    state.brokerEnabled = false
    const fetchFunction = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchFunction)
    expect((await request()).code).toBe(200)
    expect(fetchFunction.mock.calls[0][0]).toBeInstanceOf(URL)
    expect(fetchFunction.mock.calls[0][0].href).toBe('https://project.example/functions/v1/hello?q=a%20b')
    for (const url of ['https://attacker.example/functions/v1/hello', 'https://project.example/functions/v1/%2e%2e/admin']) {
      expect((await request({ url })).code).toBe(400)
    }
    expect(fetchFunction).toHaveBeenCalledTimes(1)
  })
  it('reconstructs platform requests only on an allowed Supabase hostname', async () => {
    state.mode.IS_PLATFORM = true
    const fetchFunction = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchFunction)
    const url = 'https://uniquetwentychararef.supabase.co/functions/v1/hello?q=a%20b'
    expect((await request({ url })).code).toBe(200)
    expect(fetchFunction.mock.calls[0][0]).toBeInstanceOf(URL)
    expect(fetchFunction.mock.calls[0][0].href).toBe(url)
    for (const invalid of ['https://uniquetwentychararef.supabase.co.attacker.test/functions/v1/hello', 'https://uniquetwentychararef.supabase.co/functions/v1/../admin', 'https://uniquetwentychararef.supabase.co:8443/functions/v1/hello']) {
      expect((await request({ url: invalid })).code).toBe(400)
    }
    expect(fetchFunction).toHaveBeenCalledTimes(1)
  })
})
