import { createClient } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import { getManagerBrokerProxyConfig, getManagerBrokerSettings, MANAGER_BROKER_ENABLED } from './managerBroker'
import { getManagerSessionMember } from './managerSession'
import { getBaseRoleId, getOrgMembers } from './membersStore'
import { getStoredProjectByRef } from './projectsStore'
import { getGoTrueAuthMember } from './studioGoTrue'
import { STUDIO_AUTH_GOTRUE, STUDIO_AUTH_MANAGER } from '@/lib/constants'

export async function storageApiWrapper(req: NextApiRequest, res: NextApiResponse, handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>) {
  try { return await handler(req, res) }
  catch (error) {
    const message = error instanceof Error ? error.message : ''
    const status = message === 'Authentication required' ? 401
      : ['Project membership required', 'Insufficient project permissions'].includes(message) ? 403
        : message === 'Project not found' ? 404
          : message === 'Project reference is required' ? 400 : 502
    return res.status(status).json({ error: { message: status === 502 ? 'Project Storage is unavailable' : message } })
  }
}

/** Resolve on each request: a process-wide client would send one project's keys to another. */
export async function getProjectStorageClient(req: NextApiRequest, write = false) {
  const ref = req.query.ref
  if (typeof ref !== 'string') throw new Error('Project reference is required')
  const project = getStoredProjectByRef(ref)
  if (!project) throw new Error('Project not found')
  if (STUDIO_AUTH_MANAGER || STUDIO_AUTH_GOTRUE) {
    const identity = STUDIO_AUTH_GOTRUE ? await getGoTrueAuthMember(req) : getManagerSessionMember(req)
    if (!identity) throw new Error('Authentication required')
    let member = getOrgMembers(project.organization_slug).find((candidate) => candidate.gotrue_id === identity.gotrue_id)
    // Older Manager organizations have no local member mirror. The broker owns
    // their authoritative memberships; its settings endpoint verifies that this
    // signed-in account is an owner/admin of this exact project's organization.
    // Never infer cross-organization access from a global/local Owner role.
    if (!member && STUDIO_AUTH_MANAGER && MANAGER_BROKER_ENABLED && project.broker_project_id) {
      try {
        await getManagerBrokerSettings(project.broker_project_id, identity.primary_email)
        member = identity
      } catch (error) {
        if (error instanceof Error && ['Organization manager permission required', 'Project not found'].includes(error.message)) {
          throw new Error('Project membership required')
        }
        throw error
      }
    }
    if (!member || (member.project_refs != null && !member.project_refs.includes(ref))) {
      throw new Error('Project membership required')
    }
    if (!member.role_ids.some((role) => (write ? [1, 2, 3] : [1, 2, 3, 4]).includes(getBaseRoleId(role)))) {
      throw new Error('Insufficient project permissions')
    }
  }
  if (MANAGER_BROKER_ENABLED) {
    if (!project.broker_project_id) throw new Error('Project is not registered with the broker')
    const proxy = getManagerBrokerProxyConfig(project.broker_project_id)
    return createClient(proxy.baseUrl, proxy.headers.Authorization.slice('Bearer '.length), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: proxy.headers },
    })
  }
  const url = ref === 'default' ? process.env.SUPABASE_URL : project.public_url
  const key = ref === 'default' ? process.env.SUPABASE_SERVICE_KEY : project.service_key
  if (!url || !key) throw new Error('Project Storage connection is unavailable')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

/** SDK URLs use the private broker prefix; only the selected project's public origin leaves Studio. */
export function projectStorageUrl(req: NextApiRequest, source: string): string {
  const ref = req.query.ref
  const project = typeof ref === 'string' ? getStoredProjectByRef(ref) : undefined
  if (!project) throw new Error('Project not found')
  return remapStorageUrl(source, project.public_url)
}

export function remapStorageUrl(source: string, publicUrl: string): string {
  const parsed = new URL(source)
  const target = new URL(publicUrl)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('Project public URL is invalid')
  }
  const marker = parsed.pathname.indexOf('/storage/v1/')
  if (marker < 0) throw new Error('Invalid Storage object URL')
  target.pathname = target.pathname.replace(/\/+$/, '') + parsed.pathname.slice(marker)
  target.search = parsed.search
  target.hash = ''
  return target.href
}
