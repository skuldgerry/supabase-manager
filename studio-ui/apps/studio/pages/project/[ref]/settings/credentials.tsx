import { Copy, Eye, EyeOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button, Card, CardContent, Input, copyToClipboard } from 'ui'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import { PageContainer } from 'ui-patterns/PageContainer'

import DefaultLayout from '@/components/layouts/DefaultLayout'
import SettingsLayout from '@/components/layouts/ProjectSettingsLayout/SettingsLayout'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import type { NextPageWithLayout } from '@/types'

type Credentials = {
  publicUrl: string
  publishableKey: string
  secretKey: string
  anonKey: string
  serviceRoleKey: string
  jwtSecret: string
  dashboard: { username: string; password: string }
  storage: { accessKeyId: string | null; secretAccessKey: string | null }
  database: {
    host: string
    username: string
    password: string
    sessionPort: number
    transactionPort: number
    sessionConnectionString: string
    transactionConnectionString: string
  }
}

function SecretField({ label, value, secret = true }: { label: string; value: string | null; secret?: boolean }) {
  const [revealed, setRevealed] = useState(false)
  const available = Boolean(value)

  return (
    <label className="block space-y-1.5">
      <span className="text-sm">{label}</span>
      <div className="flex gap-2">
        <Input
          className="font-mono"
          readOnly
          type={secret && !revealed ? 'password' : 'text'}
          value={value ?? 'Not stored for this project'}
        />
        {secret && available && (
          <Button
            type="default"
            aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
            icon={revealed ? <EyeOff /> : <Eye />}
            onClick={() => setRevealed((current) => !current)}
          />
        )}
        <Button
          type="default"
          aria-label={`Copy ${label}`}
          icon={<Copy />}
          disabled={!available}
          onClick={() => value && copyToClipboard(value, () => toast.success(`${label} copied`))}
        />
      </div>
    </label>
  )
}

const CredentialsPage: NextPageWithLayout = () => {
  const { data: project } = useSelectedProjectQuery()
  const [credentials, setCredentials] = useState<Credentials | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!project?.ref) return
    setCredentials(null)
    setError(null)
    void fetch(`/api/platform/projects/${encodeURIComponent(project.ref)}/credentials`, {
      cache: 'no-store',
    })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body?.error?.message ?? 'Credentials are unavailable')
        setCredentials(body)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Credentials are unavailable'))
  }, [project?.ref])

  return (
    <>
      <PageHeader size="small">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>Credentials</PageHeaderTitle>
            <PageHeaderDescription>
              Reveal and copy the encrypted credentials stored by Supabase Manager.
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="small" className="space-y-6">
        {error && <Card className="border-destructive-500 p-4 text-sm text-destructive">{error}</Card>}
        {!credentials && !error && <p className="text-sm text-foreground-light">Loading credentials…</p>}
        {credentials && (
          <>
            <Card>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm font-medium">Project API</p>
                  <p className="text-sm text-foreground-light">Client and server keys for the project gateway.</p>
                </div>
                <SecretField label="Project URL" value={credentials.publicUrl} secret={false} />
                <SecretField label="Publishable key" value={credentials.publishableKey} />
                <SecretField label="Secret key" value={credentials.secretKey} />
                <SecretField label="Legacy anon key" value={credentials.anonKey} />
                <SecretField label="Legacy service_role key" value={credentials.serviceRoleKey} />
                <SecretField label="JWT secret" value={credentials.jwtSecret} />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm font-medium">Database</p>
                  <p className="text-sm text-foreground-light">Direct credentials and manager-assigned pooler endpoints.</p>
                </div>
                <SecretField label="Database username" value={credentials.database.username} secret={false} />
                <SecretField label="Database password" value={credentials.database.password} />
                <SecretField label="Session connection string" value={credentials.database.sessionConnectionString} />
                <SecretField label="Transaction connection string" value={credentials.database.transactionConnectionString} />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm font-medium">Studio and S3 protocol</p>
                  <p className="text-sm text-foreground-light">S3 values are available for manager-created projects generated from the official stack.</p>
                </div>
                <SecretField label="Studio username" value={credentials.dashboard.username} secret={false} />
                <SecretField label="Studio password" value={credentials.dashboard.password} />
                <SecretField label="S3 access key ID" value={credentials.storage.accessKeyId} />
                <SecretField label="S3 secret access key" value={credentials.storage.secretAccessKey} />
              </CardContent>
            </Card>
          </>
        )}
      </PageContainer>
    </>
  )
}

CredentialsPage.getLayout = (page) => (
  <DefaultLayout>
    <SettingsLayout title="Credentials">{page}</SettingsLayout>
  </DefaultLayout>
)

export default CredentialsPage
