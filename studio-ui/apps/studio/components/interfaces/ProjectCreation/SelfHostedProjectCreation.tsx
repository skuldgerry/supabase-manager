import { zodResolver } from '@hookform/resolvers/zod'
import { Server } from 'lucide-react'
import { useRouter } from 'next/router'
import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import {
  Button,
  Form_Shadcn_,
  FormControl_Shadcn_,
  FormField_Shadcn_,
} from 'ui'
import { Input } from 'ui-patterns/DataInputs/Input'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import { z } from 'zod'

import Panel from '@/components/ui/Panel'
import { SelfHostedProjectImport } from './SelfHostedProjectImport'
import { useProjectCreateMutation } from '@/data/projects/project-create-mutation'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'

const officialTag = z.string().regex(/^self-hosted\/v\d+\.\d+\.\d+$/, 'Use an official tag such as self-hosted/v0.8.0.')
const optionalPort = z.string().regex(/^\d+$/, 'Enter a valid host port').refine((value) => Number(value) >= 1 && Number(value) <= 65535, 'Port must be between 1 and 65535')
const schema = z.object({
  projectName: z.string().trim().min(3, 'Project name must be at least 3 characters').max(64, 'Project name must be no longer than 64 characters'),
  advanced: z.boolean(), release: z.string(), customRelease: z.string(), serverAddress: z.string(), publicUrl: z.string(), siteUrl: z.string(),
  apiPort: optionalPort, dbSessionPort: optionalPort, dbTransactionPort: optionalPort,
  dashboardUsername: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, dots, underscores, or hyphens'),
  customizeCredentials: z.boolean(), postgresPassword: z.string().min(12).max(256), dashboardPassword: z.string().min(12).max(256), jwtSecret: z.string().min(32).max(512),
})

type FormValues = z.infer<typeof schema>
type BrokerOptions = { managerPublicUrl: string; releases: string[]; latestRelease: string; suggested: { api: number; dbSession: number; dbTransaction: number }; conflicts: { field: string; port: number; reason: string }[] }

const DEPLOY_MODES: {
  value: 'standalone'
  label: string
  description: string
  icon: React.ReactNode
}[] = [
  {
    value: 'standalone',
    label: 'Standalone',
    description: 'Single Supabase stack. Simple and fast.',
    icon: <Server size={16} />,
  },
]

function secret(bytes: number): string {
  const values = new Uint8Array(bytes)
  crypto.getRandomValues(values)
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('')
}

export function SelfHostedProjectCreation() {
  const router = useRouter()
  const { data: currentOrg } = useSelectedOrganizationQuery()
  const [options, setOptions] = useState<BrokerOptions | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const generated = useRef({ postgresPassword: secret(18), dashboardPassword: secret(18), jwtSecret: secret(32) })
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onChange',
    defaultValues: { projectName: '', advanced: false, release: '', customRelease: '', serverAddress: '', publicUrl: '', siteUrl: '', apiPort: '8100', dbSessionPort: '54100', dbTransactionPort: '55100', dashboardUsername: 'supabase', customizeCredentials: false, ...generated.current },
  })

  const { mutateAsync: createProjectAsync, isPending: isCreating } = useProjectCreateMutation()
  const isPending = isCreating
  const advanced = form.watch('advanced')

  useEffect(() => {
    if (!advanced || options) return
    let cancelled = false
    fetch('/api/platform/projects?options=1')
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error ?? 'Project options are unavailable'); return body as BrokerOptions })
      .then((value) => {
        if (cancelled) return
        setOptions(value); form.setValue('release', value.latestRelease); form.setValue('serverAddress', new URL(value.managerPublicUrl).hostname); form.setValue('publicUrl', value.managerPublicUrl); form.setValue('siteUrl', value.managerPublicUrl)
        form.setValue('apiPort', String(value.suggested.api)); form.setValue('dbSessionPort', String(value.suggested.dbSession)); form.setValue('dbTransactionPort', String(value.suggested.dbTransaction))
      })
      .catch((error) => { if (!cancelled) setOptionsError(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [advanced, options, form])

  if (router.query.mode === 'import') return <SelfHostedProjectImport />

  const onSubmit = async (values: FormValues) => {
    if (!currentOrg) return toast.error('No organization selected')
    const release = values.release === 'custom' ? values.customRelease.trim() : values.release
    if (values.advanced && !officialTag.safeParse(release).success) return toast.error('Choose a valid official Supabase release tag')
    const ports = values.advanced ? { api: Number(values.apiPort), dbSession: Number(values.dbSessionPort), dbTransaction: Number(values.dbTransactionPort) } : undefined
    if (ports && new Set(Object.values(ports)).size !== 3) return toast.error('Each project endpoint needs a different host port')
    let project: { ref: string } | undefined
    try {
      project = await createProjectAsync({
        name: values.projectName,
        organizationSlug: currentOrg.slug,
        dbPass: '',
        selfHosted: { creation_mode: 'stack', ...(values.advanced && { stack_release: release, public_url: values.publicUrl.trim(), site_url: values.siteUrl.trim(), ports, dashboard_username: values.dashboardUsername.trim(), ...(values.customizeCredentials && { custom_credentials: { postgresPassword: values.postgresPassword, dashboardPassword: values.dashboardPassword, jwtSecret: values.jwtSecret } }) }) },
      })
    } catch (err) {
      toast.error(`Failed to create project: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    if (project) router.push(`/project/${project.ref}`)
  }

  const updateApiUrl = (value: string) => {
    form.setValue('apiPort', value, { shouldValidate: true })
    const current = form.getValues('publicUrl')
    try { const url = new URL(current); url.port = value; form.setValue('publicUrl', url.origin); if (form.getValues('siteUrl') === current) form.setValue('siteUrl', url.origin) } catch { /* options have not loaded yet */ }
  }

  const submitLabel = () => {
    if (isCreating) {
      return 'Launching stack...'
    }
    return 'Create project'
  }

  return (
    <Form_Shadcn_ {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <Panel
          title={
            <div>
              <h3>Create a new project</h3>
              <p className="text-sm text-foreground-lighter">
                A new isolated Supabase stack will be launched automatically. Ports and credentials
                are generated for you.
              </p>
            </div>
          }
          footer={
            <div className="flex items-center justify-between gap-2 p-4">
              <Button type="default" onClick={() => router.push({ pathname: router.pathname, query: { ...router.query, mode: 'import' } })} disabled={isPending}>
                Import existing project
              </Button>
              <div className="flex gap-2">
                <Button type="default" onClick={() => router.back()} disabled={isPending}>
                  Cancel
                </Button>
                <Button htmlType="submit" loading={isPending} disabled={isPending}>
                  {submitLabel()}
                </Button>
              </div>
            </div>
          }
        >
          <Panel.Content className="space-y-4">
            <FormField_Shadcn_
              control={form.control}
              name="projectName"
              render={({ field }) => (
                <FormItemLayout
                  label="Project name"
                  layout="horizontal"
                  description="A short, memorable name for this Supabase project."
                >
                  <FormControl_Shadcn_>
                    <Input placeholder="My Project" {...field} />
                  </FormControl_Shadcn_>
                </FormItemLayout>
              )}
            />

            <FormItemLayout
              label="Deployment mode"
              layout="horizontal"
              description="Choose how this project is deployed."
            >
              <div className="flex flex-col gap-2 w-full">
                {DEPLOY_MODES.map((mode) => (
                  <div key={mode.value} className="flex items-start gap-3 rounded-md border border-brand bg-brand-200 px-3 py-2.5 text-left text-foreground">
                    <span className="mt-0.5 shrink-0">{mode.icon}</span>
                    <span className="flex-1">
                      <span className="block text-sm font-medium">{mode.label}</span>
                      <span className="block text-xs text-foreground-light">{mode.description}</span>
                    </span>
                  </div>
                ))}
              </div>
            </FormItemLayout>
            <details className="rounded-md border border-strong px-4 py-3" open={advanced} onToggle={(event) => form.setValue('advanced', (event.currentTarget as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer text-sm font-medium">Advanced options</summary>
              {advanced && <div className="mt-4 space-y-4">
                {optionsError && <p className="text-sm text-destructive">{optionsError}</p>}
                <FormField_Shadcn_ control={form.control} name="release" render={({ field }) => <FormItemLayout label="Supabase release" layout="horizontal" description="Latest official releases are fetched from the manager."><select className="w-full rounded-md border bg-surface-100 px-3 py-2 text-sm" {...field}><option value="">Loading releases...</option>{(options?.releases ?? []).map((release) => <option key={release} value={release}>{release}{release === options?.latestRelease ? ' (latest)' : ''}</option>)}<option value="custom">Custom official tag</option></select></FormItemLayout>} />
                {form.watch('release') === 'custom' && <FormField_Shadcn_ control={form.control} name="customRelease" render={({ field }) => <FormItemLayout label="Official tag" layout="horizontal"><FormControl_Shadcn_><Input placeholder="self-hosted/v0.8.0" {...field} /></FormControl_Shadcn_></FormItemLayout>} />}
                <FormField_Shadcn_ control={form.control} name="serverAddress" render={({ field }) => <FormItemLayout label="Server address / FQDN" layout="horizontal"><FormControl_Shadcn_><Input readOnly {...field} /></FormControl_Shadcn_></FormItemLayout>} />
                <FormField_Shadcn_ control={form.control} name="publicUrl" render={({ field }) => <FormItemLayout label="Public API URL" layout="horizontal" description="The gateway URL users and clients will call."><FormControl_Shadcn_><Input {...field} /></FormControl_Shadcn_></FormItemLayout>} />
                <FormField_Shadcn_ control={form.control} name="siteUrl" render={({ field }) => <FormItemLayout label="Auth site URL" layout="horizontal" description="Used for redirects and Auth email links."><FormControl_Shadcn_><Input {...field} /></FormControl_Shadcn_></FormItemLayout>} />
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3"><FormField_Shadcn_ control={form.control} name="apiPort" render={({ field }) => <FormItemLayout label="API port"><FormControl_Shadcn_><Input type="number" {...field} onChange={(event) => updateApiUrl(event.target.value)} /></FormControl_Shadcn_></FormItemLayout>} /><FormField_Shadcn_ control={form.control} name="dbSessionPort" render={({ field }) => <FormItemLayout label="Session pooler"><FormControl_Shadcn_><Input type="number" {...field} /></FormControl_Shadcn_></FormItemLayout>} /><FormField_Shadcn_ control={form.control} name="dbTransactionPort" render={({ field }) => <FormItemLayout label="Transaction pooler"><FormControl_Shadcn_><Input type="number" {...field} /></FormControl_Shadcn_></FormItemLayout>} /></div>
                <FormField_Shadcn_ control={form.control} name="dashboardUsername" render={({ field }) => <FormItemLayout label="Studio username" layout="horizontal"><FormControl_Shadcn_><Input {...field} /></FormControl_Shadcn_></FormItemLayout>} />
                <FormField_Shadcn_ control={form.control} name="customizeCredentials" render={({ field }) => <FormItemLayout label="Credentials" layout="horizontal" description="Generated secrets are used by default. Enable this to customize them."><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={field.value} onChange={field.onChange} /> Customize generated secrets</label></FormItemLayout>} />
                {form.watch('customizeCredentials') && <div className="space-y-3 rounded-md bg-surface-75 p-3"><FormField_Shadcn_ control={form.control} name="postgresPassword" render={({ field }) => <FormItemLayout label="Database password"><FormControl_Shadcn_><Input type="password" {...field} /></FormControl_Shadcn_></FormItemLayout>} /><FormField_Shadcn_ control={form.control} name="dashboardPassword" render={({ field }) => <FormItemLayout label="Studio password"><FormControl_Shadcn_><Input type="password" {...field} /></FormControl_Shadcn_></FormItemLayout>} /><FormField_Shadcn_ control={form.control} name="jwtSecret" render={({ field }) => <FormItemLayout label="JWT secret"><FormControl_Shadcn_><Input type="password" {...field} /></FormControl_Shadcn_></FormItemLayout>} /></div>}
              </div>}
            </details>
          </Panel.Content>
        </Panel>
      </form>
    </Form_Shadcn_>
  )
}
