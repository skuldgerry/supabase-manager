import CopyButton from '@/components/ui/CopyButton'
import { cn } from 'ui'

export type DeploymentEvent = {
  sequence: number
  stage?: string | null
  level: string
  message: string
  createdAt: string
  details?: Record<string, string | number | boolean | null>
}

export function DeploymentDiagnosticEvent({ event }: { event: DeploymentEvent }) {
  const details = event.details ?? {}
  const command = typeof details.command === 'string' ? details.command : null
  return (
    <div className={cn('grid grid-cols-[76px_minmax(0,1fr)] gap-3 py-1.5', event.level === 'error' && 'text-destructive')}>
      <span className="text-foreground-muted">{new Date(event.createdAt).toLocaleTimeString()}</span>
      <div className="min-w-0 space-y-2">
        {details.kind === 'container-diagnostics' ? (
          <details className="rounded border border-border px-3 py-2">
            <summary className="cursor-pointer break-all font-medium">{event.message} · {String(details.state ?? 'unknown')}</summary>
            <div className="mt-3 space-y-3 text-foreground-light">
              <p>Snapshot at failure; known credentials are redacted. Logs may contain application data.</p>
              <h3 className="font-medium">Docker healthcheck output</h3>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all">{String(details.healthOutput ?? 'Not available')}</pre>
              <h3 className="font-medium">Last container log lines</h3>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all">{String(details.logs ?? 'Not available')}</pre>
              {details.truncated && <p>Output was limited or incomplete. Use the command below for the full host-side logs.</p>}
            </div>
          </details>
        ) : <span className="break-words">{event.message}</span>}
        {command && <div className="space-y-1 text-foreground-light">
          <code className="block whitespace-pre-wrap break-all">{command}</code>
          <CopyButton text={command} type="default" size="tiny" copyLabel="Copy diagnostic command" />
        </div>}
      </div>
    </div>
  )
}
