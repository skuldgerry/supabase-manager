import { Pause, Play, RefreshCw } from 'lucide-react'
import { useRouter } from 'next/router'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Card, CardContent } from 'ui'
import ConfirmationModal from 'ui-patterns/Dialogs/ConfirmationModal'

import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'

type LifecycleAction = 'start' | 'stop' | 'restart'

export function ManagerProjectLifecycle() {
  const router = useRouter()
  const { data: project } = useSelectedProjectQuery()
  const [pending, setPending] = useState<LifecycleAction | null>(null)
  const [confirming, setConfirming] = useState<Extract<LifecycleAction, 'stop' | 'restart'> | null>(
    null
  )

  if (!project) return null

  if ((project as typeof project & { ownership?: string }).ownership === 'external') {
    return (
      <Card>
        <CardContent>
          <p className="text-sm">Externally managed project</p>
          <p className="max-w-[520px] text-sm text-foreground-light">
            Pause, resume, and restart remain under the external stack operator's control.
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
    </>
  )
}
