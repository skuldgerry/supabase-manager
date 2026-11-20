'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Loader2, Terminal } from 'lucide-react'
import {
  Alert_Shadcn_,
  AlertDescription_Shadcn_,
  AlertTitle_Shadcn_,
  Badge,
  Button,
  Input_Shadcn_,
  Label_Shadcn_,
} from 'ui'

type Direction = 'pb-to-supa' | 'supa-to-pb'
type JobStatus = 'pending' | 'running' | 'done' | 'error'

interface MigJob {
  id: string
  direction: Direction
  status: JobStatus
  logs: string[]
  startedAt: string
  finishedAt?: string
}

interface MigrationOptions {
  supabaseProjects: { ref: string; name: string }[]
  targets: { id: string; name: string; url: string; projectRef?: string }[]
}

function statusVariant(s: JobStatus): 'default' | 'success' | 'destructive' {
  if (s === 'done') return 'success'
  if (s === 'error') return 'destructive'
  return 'default'
}

function statusLabel(s: JobStatus): string {
  if (s === 'done') return 'complete'
  if (s === 'error') return 'failed'
  if (s === 'running') return 'running'
  return s
}

export function PocketBaseMigratePanel({ supaRef }: { supaRef: string }) {
  const [direction, setDirection] = useState<Direction>('pb-to-supa')
  const [targetId, setTargetId] = useState('')
  const [supabaseRef, setSupabaseRef] = useState('')
  const [pbEmail, setPbEmail] = useState('')
  const [pbPassword, setPbPassword] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobProjectRef, setJobProjectRef] = useState('')
  const [step, setStep] = useState<'configure' | 'progress'>('configure')
  const logsRef = useRef<HTMLPreElement>(null)

  const { data: options, error: optionsError, isPending: loadingOptions } = useQuery<MigrationOptions>({
    queryKey: ['pb-migration-options', supaRef],
    queryFn: async () => {
      const response = await fetch(`/api/platform/projects/${encodeURIComponent(supaRef)}/pocketbase-migrate?options=1`)
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? 'Migration options are unavailable')
      return body
    },
    retry: false,
  })
  const selectedSupabase = supabaseRef || options?.supabaseProjects[0]?.ref || ''
  const selectedTarget = options?.targets.find((target) => target.id === targetId) ?? options?.targets[0]

  const { data: job, error: pollError } = useQuery<MigJob>({
    queryKey: ['pb-migrate-job', jobProjectRef, jobId],
    queryFn: async () => {
      const res = await fetch(`/api/platform/projects/${encodeURIComponent(jobProjectRef)}/pocketbase-migrate?job=${encodeURIComponent(jobId!)}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error?.message ?? 'Migration progress is unavailable')
      return body
    },
    enabled: !!jobId && step === 'progress',
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === 'pending' || s === 'running' ? 2000 : false
    },
  })

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight
  }, [job?.logs.length])

  const { mutate: start, isPending: isStarting, error: startError } = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/platform/projects/${encodeURIComponent(selectedSupabase)}/pocketbase-migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction,
          pb_target_id: selectedTarget?.id,
          pb_admin_email: pbEmail.trim() || undefined,
          pb_admin_password: pbPassword || undefined,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
      return body as { job_id: string }
    },
    onSuccess: (data) => {
      setJobId(data.job_id)
      setJobProjectRef(selectedSupabase)
      setPbPassword('')
      setStep('progress')
    },
  })

  const reset = () => {
    setStep('configure')
    setJobId(null)
  }

  const canStart = !!selectedSupabase && !!selectedTarget && (!!selectedTarget.projectRef || (!!pbEmail.trim() && !!pbPassword)) && !optionsError

  if (step === 'configure') {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <Alert_Shadcn_>
          <ArrowLeftRight className="h-4 w-4" />
          <AlertTitle_Shadcn_>PocketBase ↔ Supabase Migration</AlertTitle_Shadcn_>
          <AlertDescription_Shadcn_ className="flex flex-col gap-1">
            <p>
              Migrate collections and records between a PocketBase instance and this Supabase project.
              Choose the direction and an authorized PocketBase endpoint, then start.
            </p>
            <p className="text-foreground-muted">Authentication accounts, file contents, indexes and access policies require a separate migration. Failed migrations may leave partial changes.</p>
            <p className="text-foreground-muted">
              <strong>PocketBase → Supabase</strong>: creates tables in Postgres and bulk-inserts records.
              <br />
              <strong>Supabase → PocketBase</strong>: creates PocketBase collections from Postgres tables and writes records.
            </p>
          </AlertDescription_Shadcn_>
        </Alert_Shadcn_>

        {/* Direction toggle */}
        <div className="flex flex-col gap-1.5">
          <Label_Shadcn_>Migration direction</Label_Shadcn_>
          <div className="flex gap-2">
            {(['pb-to-supa', 'supa-to-pb'] as Direction[]).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDirection(d)}
                className={[
                  'flex-1 rounded-md border px-3 py-2.5 text-sm text-left transition-colors',
                  direction === d
                    ? 'border-brand bg-brand-200 text-foreground'
                    : 'border-border-strong bg-surface-100 text-foreground-light hover:border-foreground-muted',
                ].join(' ')}
              >
                <span className="font-medium block">
                  {d === 'pb-to-supa' ? 'PocketBase → Supabase' : 'Supabase → PocketBase'}
                </span>
                <span className="block text-xs text-foreground-light mt-0.5">
                  {d === 'pb-to-supa'
                    ? 'Import PocketBase collections into this Supabase project'
                    : 'Export Supabase tables into PocketBase collections'}
                </span>
              </button>
            ))}
          </div>
        </div>

        {loadingOptions && <p className="text-sm text-foreground-light">Loading authorized migration endpoints…</p>}
        {optionsError && <p role="alert" className="text-sm text-destructive">{optionsError.message}</p>}
        <div className="flex flex-col gap-1.5">
          <Label_Shadcn_ htmlFor="migration-supabase">Supabase project</Label_Shadcn_>
          <select id="migration-supabase" className="rounded-md border bg-surface-100 p-2 text-sm" value={selectedSupabase} onChange={(event) => setSupabaseRef(event.target.value)}>
            {options?.supabaseProjects.map((project) => <option key={project.ref} value={project.ref}>{project.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label_Shadcn_ htmlFor="pb-target">PocketBase endpoint</Label_Shadcn_>
          <select id="pb-target" className="rounded-md border bg-surface-100 p-2 text-sm" value={selectedTarget?.id ?? ''} onChange={(event) => setTargetId(event.target.value)}>
            <option value="" disabled>Choose an endpoint</option>
            {options?.targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
          </select>
          {selectedTarget && <p className="break-all font-mono text-xs text-foreground-light">{selectedTarget.url}</p>}
          {options && options.targets.length === 0 && <p className="text-sm text-foreground-light">No authorized PocketBase endpoint is available. Register a project or ask the administrator to configure a migration endpoint.</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label_Shadcn_ htmlFor="pb-email">Admin email{selectedTarget?.projectRef ? ' (optional when saved)' : ''}</Label_Shadcn_>
          <Input_Shadcn_
            id="pb-email"
            type="email"
            placeholder="admin@example.com"
            value={pbEmail}
            onChange={(e) => setPbEmail(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label_Shadcn_ htmlFor="pb-password">Admin password{selectedTarget?.projectRef ? ' (optional when saved)' : ''}</Label_Shadcn_>
          <Input_Shadcn_
            id="pb-password"
            type="password"
            placeholder="••••••••"
            value={pbPassword}
            onChange={(e) => setPbPassword(e.target.value)}
          />
        </div>

        {startError && (
          <Alert_Shadcn_ className="border-destructive">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <AlertTitle_Shadcn_>Failed to start</AlertTitle_Shadcn_>
            <AlertDescription_Shadcn_>
              {startError instanceof Error ? startError.message : String(startError)}
            </AlertDescription_Shadcn_>
          </Alert_Shadcn_>
        )}

        <div className="flex justify-end">
          <Button
            type="primary"
            disabled={!canStart}
            loading={isStarting}
            onClick={() => start()}
          >
            {direction === 'pb-to-supa' ? 'Import from PocketBase' : 'Export to PocketBase'}
          </Button>
        </div>
      </div>
    )
  }

  // Progress view
  const isRunning = !job || job.status === 'pending' || job.status === 'running'

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-center gap-3">
        {isRunning ? (
          <Loader2 size={16} className="animate-spin text-foreground-muted shrink-0" />
        ) : job?.status === 'done' ? (
          <CheckCircle2 size={16} className="text-brand shrink-0" />
        ) : (
          <AlertTriangle size={16} className="text-destructive shrink-0" />
        )}
        <span className="font-medium">
          {!job
            ? 'Starting…'
            : job.status === 'done'
              ? 'Migration complete'
              : job.status === 'error'
                ? 'Migration failed'
                : direction === 'pb-to-supa'
                  ? 'Importing from PocketBase…'
                  : 'Exporting to PocketBase…'}
        </span>
        {job && (
          <Badge variant={statusVariant(job.status)} className="ml-auto">
            {statusLabel(job.status)}
          </Badge>
        )}
      </div>
      {pollError && <p role="alert" className="text-sm text-destructive">{pollError.message}</p>}

      <div className="rounded-md border border-strong bg-surface-100 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-strong bg-surface-200">
          <Terminal size={12} className="text-foreground-muted" />
          <span className="text-foreground-muted text-xs">Migration log</span>
        </div>
        <pre
          ref={logsRef}
          className="text-xs font-mono p-3 overflow-auto max-h-80 text-foreground-light whitespace-pre-wrap break-words"
        >
          {job?.logs.join('\n') || 'Waiting for output…'}
        </pre>
      </div>

      {job?.status === 'done' && (
        <Alert_Shadcn_>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle_Shadcn_>Migration complete</AlertTitle_Shadcn_>
          <AlertDescription_Shadcn_>
            {direction === 'pb-to-supa'
              ? 'PocketBase collections have been imported into this Supabase project.'
              : 'Supabase tables have been exported to PocketBase.'}
          </AlertDescription_Shadcn_>
        </Alert_Shadcn_>
      )}

      {job?.status === 'error' && (
        <Alert_Shadcn_ className="border-destructive">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <AlertTitle_Shadcn_>Migration failed</AlertTitle_Shadcn_>
          <AlertDescription_Shadcn_>
            Check the log above for details. Common causes: unreachable PocketBase URL, wrong
            admin credentials, or the Supabase project is not running.
          </AlertDescription_Shadcn_>
        </Alert_Shadcn_>
      )}

      <div className="flex justify-end">
        <Button type="default" disabled={isRunning} onClick={reset}>
          {isRunning ? 'Please wait…' : 'Run another migration'}
        </Button>
      </div>
    </div>
  )
}
