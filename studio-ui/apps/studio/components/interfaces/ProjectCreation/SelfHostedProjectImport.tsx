import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { Button, Form_Shadcn_ } from 'ui'
import { Input } from 'ui-patterns/DataInputs/Input'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import Panel from '@/components/ui/Panel'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'

type ImportValues = {
  name: string
  publicUrl: string
  siteUrl: string
  localApiPort: string
  dbHost: string
  dbPort: string
  dbSessionPort: string
  dbTransactionPort: string
  databaseUsername: string
  stackRelease: string
  dashboardUsername: string
  postgresPassword: string
  dashboardPassword: string
  jwtSecret: string
  anonKey: string
  serviceRoleKey: string
  publishableKey: string
  secretKey: string
}

const initialValues: ImportValues = {
  name: '',
  publicUrl: '',
  siteUrl: '',
  localApiPort: '8000',
  dbHost: '',
  dbPort: '5432',
  dbSessionPort: '5432',
  dbTransactionPort: '6543',
  databaseUsername: 'postgres',
  stackRelease: 'self-hosted/v0.8.0',
  dashboardUsername: 'supabase',
  postgresPassword: '',
  dashboardPassword: '',
  jwtSecret: '',
  anonKey: '',
  serviceRoleKey: '',
  publishableKey: '',
  secretKey: '',
}

export function SelfHostedProjectImport() {
  const router = useRouter()
  const { data: organization } = useSelectedOrganizationQuery()
  const [values, setValues] = useState(initialValues)
  const [releases, setReleases] = useState<string[]>(['self-hosted/v0.8.0'])
  const [submitting, setSubmitting] = useState(false)
  const form = useForm<ImportValues>({ defaultValues: initialValues })

  useEffect(() => {
    fetch('/api/platform/projects?options=1')
      .then((response) => response.json())
      .then((options) => {
        if (Array.isArray(options.releases) && options.releases.length > 0) {
          setReleases(options.releases)
          setValues((current) => ({ ...current, stackRelease: options.latestRelease }))
        }
      })
      .catch(() => undefined)
  }, [])

  const field = (name: keyof ImportValues) => ({
    value: values[name],
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setValues((current) => ({ ...current, [name]: event.target.value })),
  })

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!organization) return toast.error('No organization selected')
    setSubmitting(true)
    try {
      const response = await fetch('/api/platform/projects/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          organization_slug: organization.slug,
          public_url: values.publicUrl,
          site_url: values.siteUrl || values.publicUrl,
          local_api_port: Number(values.localApiPort),
          db_host: values.dbHost,
          db_port: Number(values.dbPort),
          db_session_port: Number(values.dbSessionPort),
          db_transaction_port: Number(values.dbTransactionPort),
          database_username: values.databaseUsername,
          stack_release: values.stackRelease,
          dashboard_username: values.dashboardUsername,
          postgres_password: values.postgresPassword,
          dashboard_password: values.dashboardPassword,
          jwt_secret: values.jwtSecret,
          anon_key: values.anonKey,
          service_role_key: values.serviceRoleKey,
          publishable_key: values.publishableKey || undefined,
          secret_key: values.secretKey || undefined,
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error?.message ?? body?.error ?? 'Import failed')
      toast.success('Existing Supabase project imported')
      await router.push(`/project/${body.ref}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Project could not be imported')
    } finally {
      setSubmitting(false)
    }
  }

  const input = (name: keyof ImportValues, label: string, options?: { type?: string; required?: boolean; description?: string }) => (
    <FormItemLayout label={label} layout="horizontal" description={options?.description}>
      <Input type={options?.type ?? 'text'} required={options?.required ?? true} {...field(name)} />
    </FormItemLayout>
  )

  return (
    <Form_Shadcn_ {...form}>
      <form onSubmit={submit}>
        <Panel
        title={
          <div>
            <h3>Import an existing project</h3>
            <p className="text-sm text-foreground-lighter">
              Register an official Supabase Compose stack already running on this Docker host.
            </p>
          </div>
        }
        footer={
          <div className="flex items-center justify-between gap-2 p-4">
            <Button type="default" onClick={() => router.push(`/new/${organization?.slug ?? ''}`)} disabled={submitting}>
              Create a new stack instead
            </Button>
            <div className="flex gap-2">
              <Button type="default" onClick={() => router.back()} disabled={submitting}>Cancel</Button>
              <Button htmlType="submit" loading={submitting} disabled={submitting}>Import project</Button>
            </div>
          </div>
        }
      >
        <Panel.Content className="space-y-4">
          <div className="rounded-md border border-warning-400 bg-warning-200 px-4 py-3 text-sm">
            Import verifies the published API port and credentials against the local Docker Compose deployment. The broker will not recreate, modify, pause, or delete its containers and volumes.
          </div>
          {input('name', 'Project name')}
          {input('publicUrl', 'Public project URL', { description: 'The externally reachable API gateway root, for example http://10.16.15.5:8000. Do not append /auth/v1.' })}
          {input('siteUrl', 'Auth site URL', { required: false, description: 'Your application frontend origin for Auth redirects and email links—not the Auth service URL. Defaults to the project URL when no frontend exists yet.' })}
          {input('localApiPort', 'Local API / Envoy port', { type: 'number', description: 'The published API gateway port on this Docker host.' })}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {input('dbHost', 'Database host')}
            {input('dbPort', 'Direct database port', { type: 'number' })}
            {input('dbSessionPort', 'Session pooler port', { type: 'number' })}
            {input('dbTransactionPort', 'Transaction pooler port', { type: 'number' })}
          </div>
          {input('databaseUsername', 'Database username')}
          <FormItemLayout label="Official stack release" layout="horizontal">
            <select className="w-full rounded-md border bg-surface-100 px-3 py-2 text-sm" {...field('stackRelease')}>
              {releases.map((release) => <option key={release} value={release}>{release}</option>)}
            </select>
          </FormItemLayout>
          {input('dashboardUsername', 'Studio username')}
          <div className="border-t pt-4">
            <p className="mb-3 text-sm font-medium">Existing stack credentials</p>
            <div className="space-y-3">
              {input('postgresPassword', 'Postgres password', { type: 'password', description: 'POSTGRES_PASSWORD from the existing stack .env.' })}
              {input('dashboardPassword', 'Studio password', { type: 'password', description: 'DASHBOARD_PASSWORD from the existing stack .env.' })}
              {input('jwtSecret', 'JWT secret', { type: 'password', description: 'JWT_SECRET used to sign the legacy anon and service_role JWTs.' })}
              {input('anonKey', 'ANON key', { type: 'password', description: 'ANON_KEY, the legacy client-safe JWT key.' })}
              {input('serviceRoleKey', 'SERVICE_ROLE key', { type: 'password', description: 'SERVICE_ROLE_KEY. This bypasses RLS and must remain server-side.' })}
              {input('publishableKey', 'Publishable key', { type: 'password', required: false, description: 'SUPABASE_PUBLISHABLE_KEY from newer official stacks. Falls back to ANON_KEY when omitted.' })}
              {input('secretKey', 'Secret key', { type: 'password', required: false, description: 'SUPABASE_SECRET_KEY from newer official stacks. Falls back to SERVICE_ROLE_KEY when omitted.' })}
            </div>
          </div>
        </Panel.Content>
        </Panel>
      </form>
    </Form_Shadcn_>
  )
}
