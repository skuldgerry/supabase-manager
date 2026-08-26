import { AlertTriangle, Check, Circle, Loader2 } from 'lucide-react'
import { useRouter } from 'next/router'
import { useEffect, useMemo, useState } from 'react'
import { Button, Card, cn } from 'ui'

import { ScaffoldContainer, ScaffoldSection } from '@/components/layouts/Scaffold'

type JobView = {
  project: { name: string; status: string }
  job?: {
    id: string
    type: string
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
    stage: string | null
    errorMessage: string | null
  }
  events?: Array<{ sequence: number; stage?: string | null; level: string; message: string; createdAt: string }>
}

const CREATION_STAGES = [
  ['validating', 'Validating configuration'],
  ['preparing-release', 'Preparing official release'],
  ['generating-credentials', 'Generating credentials'],
  ['creating-volumes', 'Creating named volumes'],
  ['initializing-configuration', 'Initializing configuration'],
  ['pulling-images', 'Pulling official images'],
  ['starting-database', 'Starting Postgres'],
  ['starting-services', 'Starting Supabase services'],
  ['functional-checks', 'Running functional checks'],
  ['ready', 'Project ready'],
] as const

const DELETION_STAGES = [
  ['stopping-services', 'Stopping services'],
  ['removing-containers', 'Removing containers'],
  ['removing-volumes', 'Removing networks and volumes'],
  ['removing-configuration', 'Removing credentials and configuration'],
  ['deleted', 'Project deleted'],
] as const

export function BrokerDeploymentProgress({
  projectRef,
  projectName,
  organizationSlug,
}: {
  projectRef: string
  projectName: string
  organizationSlug: string
}) {
  const router = useRouter()
  const [view, setView] = useState<JobView | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const response = await fetch(`/api/platform/projects/${encodeURIComponent(projectRef)}/deployment`, { cache: 'no-store' })
        const body = await response.json()
        if (!response.ok) throw new Error(body?.error?.message ?? 'Deployment status is unavailable')
        if (cancelled) return
        setView(body)
        setRequestError(null)
        if (body.job?.status === 'succeeded') {
          if (body.job.type === 'delete-project') {
            await router.replace(`/org/${organizationSlug}`)
            return
          }
          router.reload()
          return
        }
      } catch (error) {
        if (!cancelled) setRequestError(error instanceof Error ? error.message : 'Deployment status is unavailable')
      }
      if (!cancelled) timer = setTimeout(load, 1800)
    }
    void load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [organizationSlug, projectRef, router])

  const stages = view?.job?.type === 'delete-project' ? DELETION_STAGES : CREATION_STAGES
  const currentIndex = Math.max(0, stages.findIndex(([id]) => id === view?.job?.stage))
  const failed = view?.job?.status === 'failed'
  const percent = failed ? Math.max(8, Math.round((currentIndex / stages.length) * 100)) : Math.round(((currentIndex + 1) / stages.length) * 100)
  const events = useMemo(() => [...(view?.events ?? [])].sort((a, b) => a.sequence - b.sequence), [view?.events])

  return (
    <ScaffoldContainer size="large">
      <ScaffoldSection isFullWidth className="py-10">
        <div className="mx-auto w-full max-w-5xl space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-mono uppercase tracking-wider text-brand">Project lifecycle</p>
              <h1 className="mt-2 text-2xl">{view?.job?.type === 'delete-project' ? `Deleting ${projectName}` : `Deploying ${projectName}`}</h1>
              <p className="mt-1 text-sm text-foreground-light">This job runs in the broker and survives page reloads and manager restarts.</p>
            </div>
            <div className={cn('flex items-center gap-2 text-sm', failed ? 'text-destructive' : 'text-warning')}>
              {failed ? <AlertTriangle size={15} /> : <Loader2 size={15} className="animate-spin" />}
              {failed ? 'Failed' : view?.job?.status ?? 'Loading'}
            </div>
          </div>

          <div className="h-1.5 overflow-hidden rounded-full bg-surface-300">
            <div className={cn('h-full transition-all duration-500', failed ? 'bg-destructive' : 'bg-brand')} style={{ width: `${percent}%` }} />
          </div>

          {(requestError || view?.job?.errorMessage) && (
            <Card className="border-destructive-500 bg-destructive-200 p-4 text-sm text-destructive">
              {view?.job?.errorMessage ?? requestError}
            </Card>
          )}

          <div className="grid gap-6 lg:grid-cols-[0.9fr_1.4fr]">
            <Card className="divide-y divide-border">
              {stages.map(([id, label], index) => {
                const complete = index < currentIndex || view?.job?.status === 'succeeded'
                const current = index === currentIndex && view?.job?.status !== 'succeeded'
                return (
                  <div key={id} className="flex items-center gap-3 px-4 py-3">
                    {complete ? <Check size={17} className="text-brand" /> : current ? <Loader2 size={17} className={cn('animate-spin', failed ? 'text-destructive' : 'text-warning')} /> : <Circle size={17} className="text-foreground-muted" />}
                    <span className={cn('text-sm', (complete || current) ? 'text-foreground' : 'text-foreground-muted')}>{label}</span>
                  </div>
                )
              })}
            </Card>

            <Card className="min-h-72 overflow-hidden">
              <div className="border-b px-4 py-3">
                <h2 className="text-sm font-medium">Live diagnostics</h2>
                <p className="text-xs text-foreground-light">Sanitized broker events. Secrets are never written here.</p>
              </div>
              <div className="max-h-[430px] overflow-y-auto bg-alternative px-4 py-3 font-mono text-xs">
                {events.length === 0 ? (
                  <div className="flex items-center gap-2 text-foreground-light"><Loader2 size={13} className="animate-spin" />Waiting for the broker…</div>
                ) : events.map((event) => (
                  <div key={event.sequence} className={cn('grid grid-cols-[76px_1fr] gap-3 py-1.5', event.level === 'error' && 'text-destructive')}>
                    <span className="text-foreground-muted">{new Date(event.createdAt).toLocaleTimeString()}</span>
                    <span>{event.message}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {failed && <Button type="default" onClick={() => router.reload()}>Retry status check</Button>}
        </div>
      </ScaffoldSection>
    </ScaffoldContainer>
  )
}
