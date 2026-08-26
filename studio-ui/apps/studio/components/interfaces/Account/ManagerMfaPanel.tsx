import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button, Card, Input_Shadcn_, Label_Shadcn_ } from 'ui'

type Enrollment = { secret: string; otpauthUri: string }

export function ManagerMfaPanel() {
  const [enabled, setEnabled] = useState(false)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    void fetch('/api/self-hosted/mfa', { cache: 'no-store' })
      .then((response) => response.json())
      .then((body) => setEnabled(Boolean(body.enabled)))
      .catch(() => undefined)
  }, [])

  const request = async (action: 'enroll' | 'confirm' | 'disable') => {
    setLoading(true)
    try {
      const response = await fetch('/api/self-hosted/mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, password, ...(code ? { code } : {}) }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'MFA operation failed')
      if (action === 'enroll') setEnrollment({ secret: body.secret, otpauthUri: body.otpauthUri })
      if (action === 'confirm') {
        setEnabled(true)
        setEnrollment(null)
        setRecoveryCodes(body.recoveryCodes ?? [])
        setPassword('')
        setCode('')
      }
      if (action === 'disable') {
        setEnabled(false)
        setRecoveryCodes([])
        setPassword('')
        setCode('')
      }
      toast.success(action === 'disable' ? 'Two-factor authentication disabled' : action === 'confirm' ? 'Two-factor authentication enabled' : 'Authenticator enrollment started')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'MFA operation failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="mt-8 p-6">
      <h2 className="text-base">Authenticator app</h2>
      <p className="mt-1 text-sm text-foreground-light">Protect manager sign-in with a TOTP authenticator. The encrypted factor belongs to the manager account, not any Supabase project.</p>
      <div className="mt-5 max-w-lg space-y-4">
        <label className="block space-y-1">
          <Label_Shadcn_ htmlFor="mfa-password">Current password</Label_Shadcn_>
          <Input_Shadcn_ id="mfa-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {!enabled && !enrollment && <Button loading={loading} disabled={!password} onClick={() => void request('enroll')}>Set up authenticator</Button>}
        {enrollment && (
          <div className="space-y-4">
            <div className="rounded-md border bg-alternative p-4">
              <p className="text-sm font-medium">Add this account manually in your authenticator</p>
              <p className="mt-2 break-all font-mono text-sm">{enrollment.secret}</p>
              <p className="mt-2 break-all text-xs text-foreground-light">{enrollment.otpauthUri}</p>
            </div>
            <label className="block space-y-1">
              <Label_Shadcn_ htmlFor="mfa-code">Six-digit verification code</Label_Shadcn_>
              <Input_Shadcn_ id="mfa-code" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
            </label>
            <Button loading={loading} disabled={!code} onClick={() => void request('confirm')}>Verify and enable</Button>
          </div>
        )}
        {enabled && (
          <>
            <p className="text-sm text-brand">Two-factor authentication is enabled.</p>
            <label className="block space-y-1">
              <Label_Shadcn_ htmlFor="mfa-disable-code">Authenticator or recovery code</Label_Shadcn_>
              <Input_Shadcn_ id="mfa-disable-code" value={code} onChange={(event) => setCode(event.target.value)} />
            </label>
            <Button type="danger" loading={loading} disabled={!password || !code} onClick={() => void request('disable')}>Disable two-factor authentication</Button>
          </>
        )}
        {recoveryCodes.length > 0 && (
          <div className="rounded-md border border-warning bg-warning-200 p-4">
            <p className="text-sm font-medium">Save these one-time recovery codes now</p>
            <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm">{recoveryCodes.map((item) => <span key={item}>{item}</span>)}</div>
          </div>
        )}
      </div>
    </Card>
  )
}
