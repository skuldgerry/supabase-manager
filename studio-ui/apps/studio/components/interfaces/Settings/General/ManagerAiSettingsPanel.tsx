import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button, Input } from 'ui'
import {
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'

type Settings = {
  publicUrl: string
  siteUrl: string
  ai: { provider: 'openai' | 'compatible'; baseUrl: string | null; model: string | null; apiKeyConfigured: boolean }
}

export function ManagerAiSettingsPanel() {
  const { data: project } = useSelectedProjectQuery()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!project?.ref) return
    void fetch(`/api/platform/projects/${encodeURIComponent(project.ref)}/manager-settings`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body?.error?.message ?? 'Settings are unavailable')
        setSettings(body)
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Settings are unavailable'))
  }, [project?.ref])

  if (process.env.NEXT_PUBLIC_STUDIO_AUTH !== 'manager' || !project) return null

  const update = async (clearApiKey = false) => {
    if (!settings) return
    setSaving(true)
    try {
      const response = await fetch(`/api/platform/projects/${encodeURIComponent(project.ref)}/manager-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: settings.ai.provider,
          baseUrl: settings.ai.provider === 'compatible' ? settings.ai.baseUrl : null,
          model: settings.ai.model,
          ...(apiKey ? { apiKey } : {}),
          clearApiKey,
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? 'Settings could not be saved')
      setSettings(body)
      setApiKey('')
      toast.success(clearApiKey ? 'AI API key removed' : 'AI settings saved')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Settings could not be saved')
    } finally {
      setSaving(false)
    }
  }

  return (
    <PageSection>
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle>Studio AI provider</PageSectionTitle>
          <PageSectionDescription>Configure the AI provider for this project. The key is encrypted in the manager and is not injected into the Supabase stack.</PageSectionDescription>
        </PageSectionSummary>
      </PageSectionMeta>
      <PageSectionContent className="space-y-4">
        {!settings ? <p className="text-sm text-foreground-light">Loading settings…</p> : (
          <>
            <label className="block space-y-1">
              <span className="text-sm">Provider</span>
              <select
                className="w-full rounded-md border bg-surface-100 px-3 py-2 text-sm"
                value={settings.ai.provider}
                onChange={(event) => setSettings({ ...settings, ai: { ...settings.ai, provider: event.target.value as Settings['ai']['provider'] } })}
              >
                <option value="openai">OpenAI</option>
                <option value="compatible">OpenAI-compatible endpoint</option>
              </select>
            </label>
            {settings.ai.provider === 'compatible' && (
              <label className="block space-y-1">
                <span className="text-sm">Base URL</span>
                <Input value={settings.ai.baseUrl ?? ''} placeholder="https://api.example.com/v1" onChange={(event) => setSettings({ ...settings, ai: { ...settings.ai, baseUrl: event.target.value || null } })} />
              </label>
            )}
            <label className="block space-y-1">
              <span className="text-sm">Model override</span>
              <Input value={settings.ai.model ?? ''} placeholder="Optional" onChange={(event) => setSettings({ ...settings, ai: { ...settings.ai, model: event.target.value || null } })} />
            </label>
            <label className="block space-y-1">
              <span className="text-sm">API key</span>
              <Input type="password" value={apiKey} placeholder={settings.ai.apiKeyConfigured ? 'Configured — enter a new value to replace it' : 'Enter provider API key'} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" />
            </label>
            <div className="flex gap-2">
              <Button loading={saving} onClick={() => void update(false)}>Save settings</Button>
              {settings.ai.apiKeyConfigured && <Button type="default" disabled={saving} onClick={() => void update(true)}>Remove key</Button>}
            </div>
          </>
        )}
      </PageSectionContent>
    </PageSection>
  )
}
