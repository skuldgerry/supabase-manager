export function edgeFunctionPath(url: string, expectedOrigin?: string): string | undefined {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || /[\\\s]/.test(url)) return
    const parsed = new URL(url)
    if (parsed.username || parsed.password || parsed.hash) return
    if (expectedOrigin !== undefined) {
      const expected = new URL(expectedOrigin)
      if (!['http:', 'https:'].includes(expected.protocol) || expected.username || expected.password) return
      if (parsed.origin !== expected.origin) return
    }
    // Inspect raw segments before URL parsing can normalize traversal away.
    const rawPath = url.match(/^https?:\/\/[^/?#]*(\/[^?#]*)?/)?.[1] ?? ''
    for (const segment of rawPath.split('/')) {
      const decoded = decodeURIComponent(segment)
      if (decoded === '.' || decoded === '..' || /[/\\%]/.test(decoded)) return
    }
    if (!/^\/functions\/v[0-9]\/[^/]+(?:\/.*)?$/.test(parsed.pathname)) return
    return parsed.pathname + parsed.search
  } catch {
    return
  }
}

export function edgeFunctionRequestHeaders(input: unknown): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (input == null) return headers
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid function request headers')
  const routing = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-connection', 'forwarded'])
  let testAuthorization: string | undefined
  for (const [name, value] of Object.entries(input)) {
    if (value == null || value === '') continue
    if (typeof value !== 'string') throw new Error('Invalid function request headers')
    const key = name.toLowerCase()
    if (key === 'x-test-authorization') { testAuthorization = value; continue }
    if (!routing.has(key) && !key.startsWith('x-forwarded-')) headers.set(name, value)
  }
  if (testAuthorization) headers.set('authorization', testAuthorization)
  return headers
}

export function hasFunctionProjectAccess(identity: string, projectRef: string, members: readonly {
  gotrue_id: string
  project_refs?: string[] | null
}[]): boolean {
  const member = members.find((candidate) => candidate.gotrue_id === identity)
  return Boolean(member && (member.project_refs == null || member.project_refs.includes(projectRef)))
}

export const isValidEdgeFunctionURL = (url: string, isPlatform: boolean, expectedOrigin?: string) => {
  if (!edgeFunctionPath(url, expectedOrigin)) return false
  if (!isPlatform) return expectedOrigin !== undefined
  const parsed = new URL(url)
  const nimbus = process.env.NIMBUS_PROD_PROJECTS_URL
  if (nimbus !== undefined) {
    try {
      const apex = new URL(nimbus.replace('https://*.', 'https://')).hostname
      return parsed.protocol === 'https:' && parsed.port === '' && /^[a-z]+$/.test(parsed.hostname.slice(0, -(apex.length + 1))) && parsed.hostname.endsWith('.' + apex)
    } catch { return false }
  }
  return parsed.protocol === 'https:' && parsed.port === '' && /^[a-z]{20}\.supabase\.(red|co)$/.test(parsed.hostname)
}
