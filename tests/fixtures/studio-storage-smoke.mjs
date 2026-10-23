// Run inside the built Studio candidate with a tmpfs /data and --network none.
// Only loopback is used. No real project, credentials, Docker socket or ports.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const secret = 'disposable-studio-session-fixture-only-20261022'
const brokerToken = 'disposable-broker-fixture-only-20261022'
const user = { id: 1, gotrue_id: 'fixture-user', username: 'fixture', primary_email: 'fixture@example.invalid', role_ids: [1], project_refs: null, mfa_enabled: false, metadata: {} }
const projects = [
  { ref: 'managed-a', broker_project_id: '11111111-1111-4111-8111-111111111111', organization_slug: 'org-a', public_url: 'https://a.example.invalid', ownership: 'manager-owned' },
  { ref: 'imported-b', broker_project_id: '22222222-2222-4222-8222-222222222222', organization_slug: 'org-b', public_url: 'http://10.0.0.5:8000', ownership: 'external' },
]
await mkdir('/data', { recursive: true })
await writeFile('/data/projects.json', JSON.stringify(projects))
// Existing Manager organizations may have only the original/default local member.
const saveMembers = (orgB = []) => writeFile('/data/members.json', JSON.stringify({ 'org-a': { members: [user] }, 'org-b': { members: orgB } }))
await saveMembers()
const requests = []
let orgBManager = true
const broker = createServer((request, response) => {
  requests.push({ path: request.url, authorization: request.headers.authorization })
  response.setHeader('Content-Type', 'application/json')
  if (request.url.includes('/settings?')) {
    const url = new URL(request.url, 'http://127.0.0.1')
    const permitted = orgBManager && url.pathname.includes(projects[1].broker_project_id) && url.searchParams.get('actorEmail') === user.primary_email && request.headers.authorization === `Bearer ${brokerToken}`
    response.statusCode = permitted ? 200 : 403
    response.end(JSON.stringify(permitted ? { ai: { apiKeyConfigured: false } } : { error: 'Organization manager permission required' }))
    return
  }
  if (request.url.includes('/object/sign/')) {
    response.end(JSON.stringify({ signedURL: '/object/sign/proof/test.txt?token=fixture-token' }))
  } else {
    response.end(JSON.stringify([{ id: 'proof', name: 'proof' }]))
  }
})
await new Promise((resolve) => broker.listen(39001, '127.0.0.1', resolve))
let logs = ''
const studio = spawn(process.execPath, ['apps/studio/server.js'], {
  cwd: '/app',
  env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: '3000', STUDIO_DATA_DIR: '/data', STUDIO_SESSION_SECRET: secret, MANAGER_INTERNAL_TOKEN: brokerToken, MANAGER_BROKER_URL: 'http://127.0.0.1:39001' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
studio.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-4000) })
studio.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-4000) })
const payload = Buffer.from(JSON.stringify({ ts: Date.now(), gotrue_id: user.gotrue_id })).toString('base64url')
const cookie = `studio_session=${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`
const request = (ref, suffix = '', options = {}) => fetch(`http://127.0.0.1:3000/api/platform/storage/${ref}/buckets${suffix}`, { redirect: 'manual', ...options, headers: { Cookie: cookie, ...options.headers } })
try {
  let available = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await fetch('http://127.0.0.1:3000/sign-in'); available = true; break } catch { /* startup retry */ }
    if (studio.exitCode !== null) throw new Error(`Studio exited during startup: ${logs}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.ok(available, `Studio did not start: ${logs}`)
  for (const project of projects) {
    const response = await request(project.ref)
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body[0].name, 'proof')
    assert.ok(requests.at(-1).path.startsWith(`/api/internal/v1/projects/${project.broker_project_id}/proxy/storage/v1/bucket`))
    assert.equal(requests.at(-1).authorization, `Bearer ${brokerToken}`)
    const signed = await request(project.ref, '/proof/objects/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'test.txt' }) })
    assert.equal(signed.status, 200)
    assert.equal((await signed.json()).signedUrl, `${project.public_url}/storage/v1/object/sign/proof/test.txt?token=fixture-token`)
  }
  const calls = requests.filter(request => request.path.includes('/proxy/storage/')).length
  const anonymous = await request('managed-a', '', { headers: { Cookie: '' } })
  // Existing Studio middleware denies missing sessions before the API handler.
  // Do not automatically follow that redirect and mistake the login page for 200 success.
  assert.equal(anonymous.status, 307)
  assert.equal(new URL(anonymous.headers.get('location'), 'http://127.0.0.1:3000').pathname, '/sign-in')
  await saveMembers([])
  orgBManager = false
  assert.equal((await request('imported-b')).status, 403)
  user.role_ids = [4]
  await saveMembers([])
  assert.equal((await request('managed-a', '', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'forbidden' }) })).status, 403)
  assert.equal(requests.filter(request => request.path.includes('/proxy/storage/')).length, calls)
  console.log('PASS: built Studio lists selected managed/imported buckets, remaps signed URLs, and denies unauthenticated, cross-organization and read-only writes without global Supabase credentials')
} finally {
  studio.kill('SIGTERM')
  await new Promise((resolve) => {
    if (studio.exitCode !== null) return resolve()
    const timer = setTimeout(() => { studio.kill('SIGKILL'); resolve() }, 5000)
    studio.once('exit', () => { clearTimeout(timer); resolve() })
  })
  await new Promise((resolve) => broker.close(resolve))
}
