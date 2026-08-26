import { useRouter } from 'next/router'
import { useState } from 'react'
import { Button, Input_Shadcn_, Label_Shadcn_ } from 'ui'

export const SelfHostedSignInForm = () => {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [mfaRequired, setMfaRequired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const res = await fetch('/api/self-hosted/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, ...(mfaRequired ? { code } : {}) }),
      })

      const body = await res.json().catch(() => ({}))
      if (res.status === 202 && body.mfaRequired) {
        setMfaRequired(true)
        setError(null)
        return
      }

      if (!res.ok) {
        setError(body.error ?? 'Invalid credentials')
        return
      }

      const requestedRedirect = router.query.returnTo ?? router.query.redirectedFrom
      const redirectTo =
        typeof requestedRedirect === 'string' &&
        requestedRedirect.startsWith('/') &&
        !requestedRedirect.startsWith('//')
          ? requestedRedirect
          : '/projects'

      // A full navigation is intentional here. Queries mounted before the
      // manager cookie exists may otherwise retain their anonymous state after
      // a client-side route change, leaving the organizations page loading
      // until the user manually refreshes it.
      window.location.assign(redirectTo)
    } catch {
      setError('Unable to reach the server. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {!mfaRequired && <div className="flex flex-col gap-1">
        <Label_Shadcn_ htmlFor="sh-email">Email</Label_Shadcn_>
        <Input_Shadcn_
          id="sh-email"
          type="text"
          autoComplete="email"
          placeholder="admin@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
        />
      </div>}

      {!mfaRequired && <div className="flex flex-col gap-1">
        <Label_Shadcn_ htmlFor="sh-password">Password</Label_Shadcn_>
        <Input_Shadcn_
          id="sh-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
        />
      </div>}

      {mfaRequired && (
        <div className="flex flex-col gap-1">
          <Label_Shadcn_ htmlFor="sh-code">Authenticator or recovery code</Label_Shadcn_>
          <Input_Shadcn_
            id="sh-code"
            type="text"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={loading}
            autoFocus
          />
          <button type="button" className="mt-1 text-left text-xs text-foreground-light hover:text-foreground" onClick={() => { setMfaRequired(false); setCode(''); setError(null) }}>
            Use a different account
          </button>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button block type="primary" htmlType="submit" loading={loading} disabled={loading}>
        {mfaRequired ? 'Verify and sign in' : 'Sign in'}
      </Button>
    </form>
  )
}
