/**
 * Bi-directional migration runner between PocketBase and Supabase.
 *
 * PocketBase → Supabase:
 *   1. Authenticate with PocketBase admin API
 *   2. List all non-system collections
 *   3. CREATE TABLE in Postgres (via pg-meta query endpoint)
 *   4. Bulk-insert records via PostgREST
 *
 * Supabase → PocketBase:
 *   1. List Postgres tables via pg-meta
 *   2. Map column types → PocketBase field types
 *   3. Create PocketBase collections
 *   4. Read rows via PostgREST → create PocketBase records
 *
 * Jobs are persisted to DATA_DIR/pb-migrations/{id}.json + .log
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// ── Types ─────────────────────────────────────────────────────────────────────

export type PBMigDirection = 'pb-to-supa' | 'supa-to-pb'
export type PBMigStatus = 'pending' | 'running' | 'done' | 'error'

export interface PBMigrationJob {
  id: string
  direction: PBMigDirection
  // Runtime-only secrets (never written to disk)
  pbAdminPassword?: string
  supaServiceKey?: string
  // Persisted
  pbUrl: string
  pbAdminEmail: string
  supaRef: string
  supaPublicUrl: string
  pbTargetId?: string
  pbProjectRef?: string
  pbOrganizationSlug?: string
  pbCollectionPrefix?: string
  status: PBMigStatus
  logs: string[]
  startedAt: string
  finishedAt?: string
}

type PersistedMeta = Omit<PBMigrationJob, 'logs' | 'pbAdminPassword' | 'supaServiceKey'>

export type PBMigrationJobView = Omit<PBMigrationJob, 'pbAdminPassword' | 'supaServiceKey'>

// ── Persistence ───────────────────────────────────────────────────────────────

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), '.studio-data')
const MIG_DIR = path.join(DATA_DIR, 'pb-migrations')

function migrationPath(id: string, extension: 'json' | 'log'): string {
  if (id.length !== 16 || /[^a-f0-9]/.test(id)) throw new Error('Invalid migration job ID')
  return path.join(MIG_DIR, `${path.basename(id)}.${extension}`)
}

function metaPath(id: string) { return migrationPath(id, 'json') }
function logPath(id: string)  { return migrationPath(id, 'log') }

function saveMeta(job: PBMigrationJob): void {
  try {
    fs.mkdirSync(MIG_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(metaPath(job.id), JSON.stringify(jobMetadata(job), null, 2), { encoding: 'utf-8', mode: 0o600 })
  } catch { /* non-fatal */ }
}

function appendLog(id: string, line: string): void {
  try {
    fs.mkdirSync(MIG_DIR, { recursive: true, mode: 0o700 })
    fs.appendFileSync(logPath(id), line + '\n', { encoding: 'utf-8', mode: 0o600 })
  } catch { /* non-fatal */ }
}

function readLogs(id: string): string[] {
  try {
    return fs.readFileSync(logPath(id), 'utf-8').split('\n').filter(Boolean)
  } catch { return [] }
}

// ── In-memory store ───────────────────────────────────────────────────────────

const jobs = new Map<string, PBMigrationJob>()
const runtime = new Map<string, { request?: StartPBMigrationOpts['supaRequest']; secrets: string[] }>()

function jobMetadata(job: PBMigrationJob): PersistedMeta {
  return { id: job.id, direction: job.direction, pbUrl: job.pbUrl, pbAdminEmail: job.pbAdminEmail,
    supaRef: job.supaRef, supaPublicUrl: job.supaPublicUrl, status: job.status,
    startedAt: job.startedAt, finishedAt: job.finishedAt, pbTargetId: job.pbTargetId,
    pbProjectRef: job.pbProjectRef, pbOrganizationSlug: job.pbOrganizationSlug, pbCollectionPrefix: job.pbCollectionPrefix }
}

function logJob(job: PBMigrationJob, message: string) {
  const secrets = [job.pbAdminPassword, job.supaServiceKey, ...(runtime.get(job.id)?.secrets ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .flatMap((value) => { const raw = value.replace(/^Bearer\s+/i, ''); return [value, raw, encodeURIComponent(raw), Buffer.from(raw).toString('base64')] })
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)
  let clean = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  for (const secret of secrets) clean = clean.split(secret).join('[REDACTED]')
  clean = clean.slice(0, 4000)
  job.logs.push(clean)
  if (job.logs.length > 2000) job.logs.shift()
  appendLog(job.id, clean)
}

const migrationFetch = (url: string, init?: RequestInit) => fetch(url, {
  ...init, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(30_000),
})

function supabaseRequest(job: PBMigrationJob, relative: string, init?: RequestInit): Promise<Response> {
  const request = runtime.get(job.id)?.request
  if (request) return request(relative, init)
  // Compatibility for server-side callers using the original runner contract.
  const relativePath = relative.startsWith('/pg/') ? `/pg-meta/v0/${relative.slice(4)}` : relative
  return migrationFetch(`${job.supaPublicUrl}${relativePath}`, { ...init, headers: {
    ...Object.fromEntries(new Headers(init?.headers)), apikey: job.supaServiceKey!, Authorization: `Bearer ${job.supaServiceKey}`,
  } })
}

function quoteIdentifier(name: string): string {
  if (!name || name.includes('\0')) throw new Error('Invalid database identifier')
  return `"${name.replace(/"/g, '""')}"`
}

function loadJob(id: string, expectedSupaRef?: string): PBMigrationJob | undefined {
  if (id.length !== 16 || /[^a-f0-9]/.test(id)) return undefined
  if (jobs.has(id)) {
    const job = jobs.get(id)!
    return expectedSupaRef && job.supaRef !== expectedSupaRef ? undefined : job
  }
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf-8')) as PersistedMeta
    if (meta.id !== id || (expectedSupaRef && meta.supaRef !== expectedSupaRef)) return undefined
    const job: PBMigrationJob = { ...jobMetadata(meta as PBMigrationJob), logs: readLogs(id) }
    if (job.status === 'running' || job.status === 'pending') {
      job.status = 'error'
      job.finishedAt = new Date().toISOString()
      logJob(job, '[error] Migration interrupted by a Studio restart. Review partial changes before starting another migration.')
      saveMeta(job)
    }
    jobs.set(id, job)
    return job
  } catch { return undefined }
}

export function getPBMigrationJob(id: string, expectedSupaRef?: string): PBMigrationJobView | undefined {
  const job = loadJob(id, expectedSupaRef)
  return job ? { ...jobMetadata(job), logs: [...job.logs] } : undefined
}

// ── Type mapping helpers ──────────────────────────────────────────────────────

// PocketBase field type → Postgres column type
function pbTypeToPostgres(pbType: string, options?: Record<string, unknown>): string {
  switch (pbType) {
    case 'number':  return 'NUMERIC'
    case 'bool':    return 'BOOLEAN'
    case 'date':    return 'TIMESTAMPTZ'
    case 'json':    return 'JSONB'
    case 'autodate': return 'TIMESTAMPTZ'
    case 'select': {
      const maxSelect = (options as { maxSelect?: number } | undefined)?.maxSelect
      return maxSelect && maxSelect > 1 ? 'TEXT[]' : 'TEXT'
    }
    default: return 'TEXT'  // text, url, email, editor, file, relation, password
  }
}

// Postgres data type → PocketBase field type
function postgresTypeToPB(dataType: string): string {
  const t = dataType.toLowerCase()
  if (t.includes('int') || t.includes('serial')) return 'number'
  if (t.includes('numeric') || t.includes('float') || t.includes('double') || t.includes('real')) return 'number'
  if (t.includes('bool')) return 'bool'
  if (t.includes('timestamp') || t.includes('date') || t.includes('time')) return 'date'
  if (t.includes('json')) return 'json'
  if (t.includes('[]') || t === 'array') return 'json'
  return 'text'
}

// ── PocketBase admin auth ─────────────────────────────────────────────────────

async function pbAuthToken(pbUrl: string, email: string, password: string): Promise<string> {
  const res = await migrationFetch(`${pbUrl}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: email, password }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string }
    throw new Error(`PocketBase auth failed: ${body.message ?? res.status}`)
  }
  const data = await res.json() as { token: string }
  if (typeof data.token !== 'string' || !data.token) throw new Error('PocketBase authentication did not return a token')
  return data.token
}

// ── PocketBase → Supabase ─────────────────────────────────────────────────────

interface PBCollection {
  id: string
  name: string
  type: string
  fields: Array<{ name: string; type: string; options?: Record<string, unknown> }>
}

interface PBRecord {
  id: string
  created: string
  updated: string
  [key: string]: unknown
}

async function listPBCollections(pbUrl: string, token: string): Promise<PBCollection[]> {
  const res = await migrationFetch(`${pbUrl}/api/collections?perPage=500`, {
    headers: { Authorization: token },
  })
  if (!res.ok) throw new Error(`Failed to list PocketBase collections: ${res.status}`)
  const body = await res.json() as { items: PBCollection[] }
  // Skip system collections (start with _) and auth/view types that don't have direct records
  return (body.items ?? []).filter(
    (c) => !c.name.startsWith('_') && c.type === 'base'
  )
}

async function fetchAllPBRecords(
  pbUrl: string,
  token: string,
  collection: string
): Promise<PBRecord[]> {
  const all: PBRecord[] = []
  let page = 1
  const perPage = 500
  while (true) {
    const res = await migrationFetch(
      `${pbUrl}/api/collections/${encodeURIComponent(collection)}/records?page=${page}&perPage=${perPage}&skipTotal=1`,
      { headers: { Authorization: token } }
    )
    if (!res.ok) throw new Error(`PocketBase record read failed: ${res.status}`)
    const body = await res.json() as { items: PBRecord[] }
    const items = body.items ?? []
    all.push(...items)
    if (items.length < perPage) break
    page++
  }
  return all
}

async function runPBToSupa(job: PBMigrationJob): Promise<void> {
  const log = (msg: string) => logJob(job, msg)

  log(`[pb→supa] Authenticating with PocketBase at ${job.pbUrl}`)
  const token = await pbAuthToken(job.pbUrl, job.pbAdminEmail, job.pbAdminPassword!)
  runtime.get(job.id)?.secrets.push(token)

  log('[pb→supa] Listing collections…')
  const collections = (await listPBCollections(job.pbUrl, token)).filter((collection) =>
    !job.pbCollectionPrefix || collection.name.startsWith(job.pbCollectionPrefix))
  log(`[pb→supa] Found ${collections.length} user collection(s): ${collections.map((c) => c.name).join(', ')}`)

  const supaHeaders = {
    'Content-Type': 'application/json',
  }

  for (const col of collections) {
    const tableName = job.pbCollectionPrefix ? col.name.slice(job.pbCollectionPrefix.length) : col.name
    log(`\n[pb→supa] Processing collection: ${col.name}`)

    // Build CREATE TABLE SQL
    const colDefs = [
      'id TEXT PRIMARY KEY',
      'created TIMESTAMPTZ',
      'updated TIMESTAMPTZ',
    ]
    for (const field of col.fields) {
      // Skip system fields already defined above
      if (['id', 'created', 'updated'].includes(field.name)) continue
      const pgType = pbTypeToPostgres(field.type, field.options)
      colDefs.push(`${quoteIdentifier(field.name)} ${pgType}`)
    }
    const createSql = `CREATE TABLE IF NOT EXISTS public.${quoteIdentifier(tableName)} (${colDefs.join(', ')});`

    log(`[pb→supa]   Creating table: ${col.name}`)
    const createRes = await supabaseRequest(job, '/pg/query', {
      method: 'POST',
      headers: supaHeaders,
      body: JSON.stringify({ query: createSql }),
    })
    if (!createRes.ok) {
      throw new Error(`Table creation failed: ${createRes.status}`)
    }

    // Fetch records
    log(`[pb→supa]   Fetching records from PocketBase…`)
    const records = await fetchAllPBRecords(job.pbUrl, token, col.name)
    log(`[pb→supa]   ${records.length} record(s) to insert`)

    if (records.length === 0) continue

    // Batch insert via PostgREST (max 1000 per request)
    const batchSize = 500
    let inserted = 0
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize)
      const insertRes = await supabaseRequest(job,
        `/rest/v1/${encodeURIComponent(tableName)}`,
        {
          method: 'POST',
          headers: {
            ...supaHeaders,
            Prefer: 'return=minimal,resolution=merge-duplicates',
          },
          body: JSON.stringify(batch),
        }
      )
      if (!insertRes.ok) {
        throw new Error(`Record insert failed: ${insertRes.status}`)
      } else {
        inserted += batch.length
      }
    }
    log(`[pb→supa]   Inserted ${inserted}/${records.length} record(s) into ${col.name}`)
  }
}

// ── Supabase → PocketBase ─────────────────────────────────────────────────────

interface PGTable {
  id: number
  name: string
  schema: string
}

interface PGColumn {
  name: string
  data_type: string
  is_nullable: string
}

async function listSchemaTables(
  job: PBMigrationJob,
  schema = 'public'
): Promise<PGTable[]> {
  const res = await supabaseRequest(job, `/pg/tables?included_schemas=${encodeURIComponent(schema)}`)
  if (!res.ok) throw new Error(`Failed to list Postgres tables: ${res.status}`)
  return res.json() as Promise<PGTable[]>
}

async function listTableColumns(
  job: PBMigrationJob,
  tableId: number
): Promise<PGColumn[]> {
  const res = await supabaseRequest(job, `/pg/columns?table_id=${encodeURIComponent(String(tableId))}`)
  if (!res.ok) throw new Error(`Failed to list columns for table ${tableId}: ${res.status}`)
  return res.json() as Promise<PGColumn[]>
}

async function fetchAllSupaRows(
  job: PBMigrationJob,
  tableName: string
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = []
  const pageSize = 1000
  let offset = 0
  while (true) {
    const res = await supabaseRequest(job,
      `/rest/v1/${encodeURIComponent(tableName)}?select=*&limit=${pageSize}&offset=${offset}`,
      {
        headers: {
          Prefer: 'count=none',
        },
      }
    )
    if (!res.ok) throw new Error(`Supabase record read failed: ${res.status}`)
    const rows = await res.json() as Record<string, unknown>[]
    all.push(...rows)
    if (rows.length < pageSize) break
    offset += pageSize
  }
  return all
}

async function createPBCollection(
  pbUrl: string,
  token: string,
  name: string,
  fields: Array<{ name: string; type: string }>
): Promise<void> {
  const res = await migrationFetch(`${pbUrl}/api/collections`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, type: 'base', fields }),
  })
  if (!res.ok) {
    // Existing collections are a supported destination; other failures must stop.
    const existing = await migrationFetch(`${pbUrl}/api/collections/${encodeURIComponent(name)}`, { headers: { Authorization: token } })
    if (!existing.ok) throw new Error(`Failed to create collection ${name}: ${res.status}`)
  }
}

async function runSupaToPB(job: PBMigrationJob): Promise<void> {
  const log = (msg: string) => logJob(job, msg)

  log(`[supa→pb] Listing tables in Supabase project ${job.supaRef}…`)
  const tables = await listSchemaTables(job)
  log(`[supa→pb] Found ${tables.length} table(s): ${tables.map((t) => t.name).join(', ')}`)

  log(`[supa→pb] Authenticating with PocketBase at ${job.pbUrl}`)
  const token = await pbAuthToken(job.pbUrl, job.pbAdminEmail, job.pbAdminPassword!)
  runtime.get(job.id)?.secrets.push(token)

  for (const table of tables) {
    log(`\n[supa→pb] Processing table: ${table.name}`)

    const columns = await listTableColumns(job, table.id)
    log(`[supa→pb]   ${columns.length} column(s)`)

    // Build PocketBase fields (skip system/Supabase columns)
    const SKIP_COLS = new Set(['id', 'created_at', 'updated_at'])
    const pbFields = columns
      .filter((c) => !SKIP_COLS.has(c.name))
      .map((c) => ({ name: c.name, type: postgresTypeToPB(c.data_type) }))

    log(`[supa→pb]   Creating PocketBase collection: ${table.name}`)
    const collectionName = `${job.pbCollectionPrefix ?? ''}${table.name}`
    await createPBCollection(job.pbUrl, token, collectionName, pbFields)

    log(`[supa→pb]   Fetching rows from Supabase…`)
    const rows = await fetchAllSupaRows(job, table.name)
    log(`[supa→pb]   ${rows.length} row(s) to migrate`)

    if (rows.length === 0) continue

    let created = 0
    const batchSize = 100  // PocketBase doesn't have a bulk create endpoint; use sequential batches
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize)
      for (const row of batch) {
        // Map Postgres row to PocketBase record shape
        const pbRecord: Record<string, unknown> = {}
        for (const field of pbFields) {
          if (row[field.name] !== undefined) pbRecord[field.name] = row[field.name]
        }
        const createRes = await migrationFetch(
          `${job.pbUrl}/api/collections/${encodeURIComponent(collectionName)}/records`,
          {
            method: 'POST',
            headers: { Authorization: token, 'Content-Type': 'application/json' },
            body: JSON.stringify(pbRecord),
          }
        )
        if (!createRes.ok) throw new Error(`PocketBase record creation failed: ${createRes.status}`)
        created++
      }
      log(`[supa→pb]   Inserted ${Math.min(i + batchSize, rows.length)}/${rows.length}…`)
    }
    log(`[supa→pb]   Done: ${created}/${rows.length} record(s) created in ${table.name}`)

  }
}

// ── Public runner ─────────────────────────────────────────────────────────────

export interface StartPBMigrationOpts {
  direction: PBMigDirection
  pbUrl: string
  pbAdminEmail: string
  pbAdminPassword: string
  supaRef: string
  supaPublicUrl: string
  supaServiceKey?: string
  supaRequest?: (path: string, init?: RequestInit) => Promise<Response>
  redactionSecrets?: string[]
  pbTargetId?: string
  pbProjectRef?: string
  pbOrganizationSlug?: string
  pbCollectionPrefix?: string
}

export function startPBMigration(opts: StartPBMigrationOpts): string {
  if (!opts.supaRequest && !opts.supaServiceKey) throw new Error('Supabase migration access is not configured')
  const id = crypto.randomBytes(8).toString('hex')
  const job: PBMigrationJob = {
    id,
    direction: opts.direction,
    pbUrl: opts.pbUrl,
    pbAdminEmail: opts.pbAdminEmail,
    pbAdminPassword: opts.pbAdminPassword,
    supaRef: opts.supaRef,
    supaPublicUrl: opts.supaPublicUrl,
    supaServiceKey: opts.supaServiceKey,
    pbTargetId: opts.pbTargetId,
    pbProjectRef: opts.pbProjectRef,
    pbOrganizationSlug: opts.pbOrganizationSlug,
    pbCollectionPrefix: opts.pbCollectionPrefix,
    status: 'pending',
    logs: [],
    startedAt: new Date().toISOString(),
  }

  runtime.set(id, { request: opts.supaRequest, secrets: [...(opts.redactionSecrets ?? [])] })
  jobs.set(id, job)
  saveMeta(job)

  const run = opts.direction === 'pb-to-supa' ? runPBToSupa : runSupaToPB

  job.status = 'running'
  saveMeta(job)

  run(job)
    .then(() => {
      job.status = 'done'
      job.finishedAt = new Date().toISOString()
      logJob(job, `[done] Migration finished at ${job.finishedAt}`)
      saveMeta(job)
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      job.status = 'error'
      job.finishedAt = new Date().toISOString()
      logJob(job, `[error] ${msg}`)
      saveMeta(job)
    })
    .finally(() => { runtime.delete(id); delete job.pbAdminPassword; delete job.supaServiceKey })

  return id
}
