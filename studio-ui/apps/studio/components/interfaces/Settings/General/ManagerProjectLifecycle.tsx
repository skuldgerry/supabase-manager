import { Download, Pause, Play, RefreshCw } from 'lucide-react'
import { useRouter } from 'next/router'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button, Card, CardContent } from 'ui'
import ConfirmationModal from 'ui-patterns/Dialogs/ConfirmationModal'

import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'

type LifecycleAction = 'start' | 'stop' | 'restart'

type UpdateOptions = {
  currentRelease: string
  ownership?: string
  releases: string[]
  latestRelease: string
}

function releaseVersion(value: string): number[] {
  return value.match(/v(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number) ?? [0, 0, 0]
}

function isNewerRelease(candidate: string, current: string): boolean {
  const left = releaseVersion(candidate)
  const right = releaseVersion(current)
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0)
  }
  return false
}

export function ManagerProjectLifecycle() {
  const router = useRouter()
  const { data: project } = useSelectedProjectQuery()
  const [pending, setPending] = useState<LifecycleAction | null>(null)
  const [confirming, setConfirming] = useState<Extract<LifecycleAction, 'stop' | 'restart'> | null>(
    null
  )
  const [updateOptions, setUpdateOptions] = useState<UpdateOptions | null>(null)
  const [targetRelease, setTargetRelease] = useState('')
  const [confirmingUpdate, setConfirmingUpdate] = useState(false)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    setUpdateOptions(null)
    setTargetRelease('')
    if (!project?.ref || (project as typeof project & { ownership?: string }).ownership === 'external') return
    void fetch(`/api/platform/projects/${encodeURIComponent(project.ref)}/update`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body?.error?.message ?? 'Release catalog is unavailable')
        setUpdateOptions(body)
        const first = body.releases.find((release: string) => isNewerRelease(release, body.currentRelease)) ?? ''
        setTargetRelease(first)
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Release catalog is unavailable'))
  }, [project?.ref])

  const newerReleases = useMemo(
    () => updateOptions?.releases.filter((release) => isNewerRelease(release, updateOptions.currentRelease)) ?? [],
    [updateOptions]
  )

  if (!project) return null

  if ((project as typeof project & { ownership?: string }).ownership === 'external') {
    return (
      <Card>
        <CardContent>
          <p className="text-sm">Externally managed project</p>
          <p className="max-w-[520px] text-sm text-foreground-light">
            Pause, resume, restart, and updates remain under the external stack operator's control.
          </p>
        </CardContent>
      </Card>
    )
  }

  const isStopped = project.status === 'INACTIVE'

  const execute = async (action: LifecycleAction) => {
    setPending(action)
    try {
      const response = await fetch(
        `/api/platform/projects/${encodeURIComponent(project.ref)}/lifecycle`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        }
      )
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(body?.error?.message ?? body?.error ?? `Project ${action} failed`)
      }

      toast.success(
        action === 'start'
          ? 'Starting project…'
          : action === 'stop'
            ? 'Pausing project…'
            : 'Restarting project…'
      )
      setConfirming(null)
      await router.push(`/project/${project.ref}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Project ${action} failed`)
    } finally {
      setPending(null)
    }
  }

  const updateProject = async () => {
    if (!targetRelease) return
    setUpdating(true)
    try {
      const response = await fetch(`/api/platform/projects/${encodeURIComponent(project.ref)}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetRelease }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error?.message ?? 'Project update could not be queued')
      toast.success(`Updating project to ${targetRelease}…`)
      setConfirmingUpdate(false)
      await router.push(`/project/${project.ref}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Project update could not be queued')
    } finally {
      setUpdating(false)
    }
  }

  return (
    <>
      <Card>
        <CardContent>
          <div className="flex flex-col gap-4 @lg:flex-row @lg:items-center @lg:justify-between">
            <div>
              <p className="text-sm">Restart project</p>
              <p className="max-w-[520px] text-sm text-foreground-light">
                Restart the official project services without changing ports, credentials, or
                volumes.
              </p>
            </div>
            <Button
              type="default"
              icon={<RefreshCw />}
              disabled={isStopped || pending !== null}
              loading={pending === 'restart'}
              onClick={() => setConfirming('restart')}
            >
              Restart project
            </Button>
          </div>
        </CardContent>
        <CardContent>
          <div className="flex flex-col gap-4 @lg:flex-row @lg:items-center @lg:justify-between">
            <div>
              <p className="text-sm">{isStopped ? 'Resume project' : 'Pause project'}</p>
              <p className="max-w-[520px] text-sm text-foreground-light">
                {isStopped
                  ? 'Start the existing containers again using the same official stack configuration.'
                  : 'Stop project services while retaining all containers, volumes, and configuration.'}
              </p>
            </div>
            {isStopped ? (
              <Button
                type="default"
                icon={<Play />}
                disabled={pending !== null}
                loading={pending === 'start'}
                onClick={() => void execute('start')}
              >
                Resume project
              </Button>
            ) : (
              <Button
                type="default"
                icon={<Pause />}
                disabled={pending !== null}
                loading={pending === 'stop'}
                onClick={() => setConfirming('stop')}
              >
                Pause project
              </Button>
            )}
          </div>
        </CardContent>
        <CardContent>
          <div className="flex flex-col gap-4 @lg:flex-row @lg:items-center @lg:justify-between">
            <div>
              <p className="text-sm">Official stack release</p>
              <p className="max-w-[520px] text-sm text-foreground-light">
                {updateOptions
                  ? `Current release: ${updateOptions.currentRelease}. Updates create a database backup, retain project volumes and credentials, and run functional checks.`
                  : 'Loading the official self-hosted release catalog…'}
              </p>
            </div>
            <div className="flex min-w-64 items-center gap-2">
              <select
                className="h-9 min-w-44 rounded-md border bg-surface-100 px-3 text-sm"
                value={targetRelease}
                disabled={isStopped || updating || newerReleases.length === 0}
                onChange={(event) => setTargetRelease(event.target.value)}
              >
                {newerReleases.length === 0 ? (
                  <option value="">Up to date</option>
                ) : (
                  newerReleases.map((release) => <option key={release} value={release}>{release}</option>)
                )}
              </select>
              <Button
                type="default"
                icon={<Download />}
                disabled={isStopped || updating || !targetRelease}
                loading={updating}
                onClick={() => setConfirmingUpdate(true)}
              >
                Update
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <ConfirmationModal
        visible={confirming !== null}
        variant="destructive"
        title={confirming === 'stop' ? 'Pause this project?' : 'Restart this project?'}
        confirmLabel={confirming === 'stop' ? 'Pause project' : 'Restart project'}
        confirmLabelLoading={confirming === 'stop' ? 'Pausing project' : 'Restarting project'}
        loading={pending !== null}
        onCancel={() => setConfirming(null)}
        onConfirm={() => confirming && void execute(confirming)}
      >
        <p className="text-sm text-foreground-light">
          {confirming === 'stop'
            ? 'The API, database, Auth, Storage, and Realtime services will be unavailable until the project is resumed.'
            : 'Project services will be briefly unavailable while their containers restart.'}
        </p>
      </ConfirmationModal>

      <ConfirmationModal
        visible={confirmingUpdate}
        variant="warning"
        title={`Update to ${targetRelease}?`}
        confirmLabel="Update project"
        confirmLabelLoading="Starting update"
        loading={updating}
        onCancel={() => setConfirmingUpdate(false)}
        onConfirm={() => void updateProject()}
      >
        <p className="text-sm text-foreground-light">
          The manager will create a PostgreSQL logical backup, pull the images pinned by the selected official release, recreate the services, and run database, Auth, REST, and Storage checks. The previous Compose configuration is restored automatically if the checks fail. A PostgreSQL major-version change is refused and requires a dedicated migration.
        </p>
      </ConfirmationModal>
    </>
  )
}
