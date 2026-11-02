import { AlertTriangle, Check, Circle, Loader2 } from 'lucide-react'
import { useRouter } from 'next/router'
import { useEffect, useMemo, useState } from 'react'
import { Button, Card, cn } from 'ui'

import { ScaffoldContainer, ScaffoldSection } from '@/components/layouts/Scaffold'
import { TextConfirmModal } from '@/components/ui/TextConfirmModalWrapper'
import { DeploymentDiagnosticEvent, type DeploymentEvent } from './DeploymentDiagnosticEvent'

type JobView = {
  project: { name: string; status: string }
  job?: {
    id: string
    type: string
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
    stage: string | null
    errorMessage: string | null
  }
  events?: DeploymentEvent[]
  recovery?: { canRecheck: boolean; canResume: boolean; canDelete: boolean }
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

const RECOVERY_STAGES = [
  ['validating', 'Loading saved deployment'],
  ['starting-database', 'Checking the existing database'],
  ['starting-services', 'Checking required containers'],
  ['functional-checks', 'Verifying database, Auth, REST and Storage'],
  ['ready', 'Deployment recovered'],
] as const

const DELETION_STAGES = [
  ['stopping-services', 'Stopping services'],
  ['removing-containers', 'Removing containers'],
  ['removing-volumes', 'Removing networks and volumes'],
  ['removing-configuration', 'Removing credentials and configuration'],
  ['deleted', 'Project deleted'],
] as const

const UPDATE_STAGES = [
  ['validating', 'Validating release compatibility'],
  ['preparing-release', 'Preparing official release'],
  ['updating-configuration', 'Preparing release configuration'],
  ['pulling-images', 'Pulling official images'],
  ['creating-backup', 'Snapshotting database and Storage'],
  ['starting-services', 'Recreating Supabase services'],
  ['functional-checks', 'Running functional checks'],
  ['rolling-back', 'Restoring data and previous release'],
  ['ready', 'Update complete'],
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
  const [recovering, setRecovering] = useState(false)
  const [pendingAction, setPendingAction] = useState<'verify' | 'resume' | 'delete' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const recoverDeployment = async (mode: 'verify' | 'resume') => {
    setPendingAction(mode)
    setRequestError(null)
    try {
      const response = await fetch(`/api/platform/projects/${encodeURIComponent(projectRef)}/recovery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? 'Deployment recovery could not be queued')
      setView(body)
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Deployment recovery could not be queued')
    } finally { setPendingAction(null) }
  }

  const deleteDeployment = async () => {
    setPendingAction('delete')
    setRequestError(null)
    try {
      const response = await fetch(`/api/platform/projects/${encodeURIComponent(projectRef)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmName: projectName }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? 'Deletion could not be queued')
      setConfirmDelete(false)
      // The existing poll reads the new deletion job from the shared project record.
      setView((previous) => previous ? { ...previous, job: { id: body.jobId, type: 'delete-project', status: 'queued', stage: 'stopping-services', errorMessage: null } } : previous)
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Deletion could not be queued')
    } finally { setPendingAction(null) }
  }

  const retryRecovery = async () => {
    setRecovering(true)
    try {
      const response = await fetch(`/api/platform/projects/${encodeURIComponent(projectRef)}/update`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recoverJobId: view?.job?.id }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? 'Recovery could not be queued')
      router.reload()
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Recovery could not be queued')
    } finally { setRecovering(false) }
  }

  useEffect(() => {
    let cancelled = false
    setView(null)
    setRequestError(null)
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

  const stages = view?.job?.type === 'delete-project'
    ? DELETION_STAGES
    : view?.job?.type === 'update-project'
      ? UPDATE_STAGES
      : view?.job?.type === 'check-project' ? RECOVERY_STAGES : CREATION_STAGES
  const events = useMemo(() => [...(view?.events ?? [])].sort((a, b) => a.sequence - b.sequence), [view?.events])
  const progressStage = view?.job?.stage === 'rolling-back' && view.job.type !== 'update-project'
    ? [...events].reverse().find((event) => event.level === 'error' && event.stage !== 'rolling-back')?.stage
    : view?.job?.stage
  const currentIndex = Math.max(0, stages.findIndex(([id]) => id === progressStage))
  const failed = view?.job?.status === 'failed'
  const percent = failed ? Math.max(8, Math.round((currentIndex / stages.length) * 100)) : Math.round(((currentIndex + 1) / stages.length) * 100)

  return (
    <ScaffoldContainer size="large">
      <ScaffoldSection isFullWidth className="py-10">
        <div className="mx-auto w-full max-w-5xl space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-mono uppercase tracking-wider text-brand">Project lifecycle</p>
              <h1 className="mt-2 text-2xl">
                {view?.job?.type === 'delete-project'
                  ? `Deleting ${projectName}`
                  : view?.job?.type === 'update-project'
                    ? `Updating ${projectName}`
                    : view?.job?.type === 'check-project' ? `Checking ${projectName}` : `Deploying ${projectName}`}
              </h1>
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
              {requestError ?? view?.job?.errorMessage}
            </Card>
          )}

          <div className="grid gap-6 lg:grid-cols-[0.9fr_1.4fr]">
            <Card className="divide-y divide-border">
              {stages.map(([id, label], index) => {
                const complete = index < currentIndex || view?.job?.status === 'succeeded'
                const current = index === currentIndex && view?.job?.status !== 'succeeded'
                return (
                  <div key={id} className="flex items-center gap-3 px-4 py-3">
                    {complete ? <Check size={17} className="text-brand" /> : current ? (failed ? <AlertTriangle size={17} className="text-destructive" /> : <Loader2 size={17} className="animate-spin text-warning" />) : <Circle size={17} className="text-foreground-muted" />}
                    <span className={cn('text-sm', (complete || current) ? 'text-foreground' : 'text-foreground-muted')}>{label}</span>
                  </div>
                )
              })}
            </Card>

            <Card className="min-h-72 overflow-hidden">
              <div className="border-b px-4 py-3">
                <h2 className="text-sm font-medium">Live diagnostics</h2>
                <p className="text-xs text-foreground-light">Progress and bounded failure snapshots. Expand a container event to view its logs.</p>
              </div>
              <div className="max-h-[430px] overflow-y-auto bg-alternative px-4 py-3 font-mono text-xs">
                {events.length === 0 ? (
                  <div className="flex items-center gap-2 text-foreground-light"><Loader2 size={13} className="animate-spin" />Waiting for the broker…</div>
                ) : events.map((event) => (
                  <DeploymentDiagnosticEvent key={`${view?.job?.id}-${event.sequence}`} event={event} />
                ))}
              </div>
            </Card>
          </div>

          {failed && view?.job?.type === 'update-project' && view.project.status !== 'ready' && (
            <Button type="default" loading={recovering} onClick={() => void retryRecovery()}>Retry recovery</Button>
          )}
          {failed && (view?.job?.type === 'create-project' || view?.job?.type === 'check-project') && (
            <Card className="space-y-4 p-4 text-sm">
              <h2 className="font-medium">Recover this deployment</h2>
              <p className="text-foreground-light">A failed job does not necessarily mean the containers are down. Recheck runs actual container, database and API checks without changing services. Resume starts retained services using the same credentials and data.</p>
              <p className="text-foreground-light">After a failed new deployment or resume, the broker attempts to stop only this project's services. Volumes and credentials are retained. A read-only recheck never stops services. Expand the diagnostics above if automatic stopping could not be confirmed.</p>
              <div className="flex flex-wrap gap-2">
                <Button type="default" disabled={!view.recovery?.canRecheck || pendingAction !== null} loading={pendingAction === 'verify'} onClick={() => void recoverDeployment('verify')}>Recheck deployment</Button>
                <Button type="primary" disabled={!view.recovery?.canResume || pendingAction !== null} loading={pendingAction === 'resume'} onClick={() => void recoverDeployment('resume')}>Resume deployment</Button>
                {view.recovery?.canDelete && <Button type="danger" disabled={pendingAction !== null} onClick={() => setConfirmDelete(true)}>Delete failed deployment</Button>}
              </div>
              {!view.recovery?.canResume && <p className="text-foreground-light">Saved configuration may be incomplete. Inspect the failure details before explicitly deleting and recreating this project.</p>}
              <p className="text-foreground-light">Deletion permanently removes this project's containers, volumes, credentials and data. Back up anything you need first.</p>
            </Card>
          )}
          {failed && view?.job?.type === 'delete-project' && <Button type="danger" disabled={pendingAction !== null} onClick={() => setConfirmDelete(true)}>Retry project deletion</Button>}
          {failed && <Button type="default" onClick={() => router.reload()}>Reload page (does not recheck services)</Button>}
          <TextConfirmModal visible={confirmDelete} loading={pendingAction === 'delete'} size="small" title={`Delete ${projectName}?`} variant="destructive" alert={{ title: 'This permanently deletes the project and its data.', description: 'All project containers, volumes and credentials will be removed. This cannot be undone.' }} confirmString={projectName} confirmPlaceholder="Type the project name" confirmLabel="Delete project and data" onConfirm={() => void deleteDeployment()} onCancel={() => { if (pendingAction !== 'delete') setConfirmDelete(false) }} />
        </div>
      </ScaffoldSection>
    </ScaffoldContainer>
  )
}
