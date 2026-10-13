import { NextApiRequest, NextApiResponse } from 'next'

import { edgeFunctionPath, edgeFunctionRequestHeaders, hasFunctionProjectAccess, isValidEdgeFunctionURL } from '@/lib/api/edgeFunctions'
import { IS_PLATFORM, STUDIO_AUTH_GOTRUE, STUDIO_AUTH_MANAGER } from '@/lib/constants'
import { getManagerSessionMember } from '@/lib/api/self-hosted/managerSession'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'
import { getOrgMembers } from '@/lib/api/self-hosted/membersStore'
import { getGoTrueAuthMember } from '@/lib/api/self-hosted/studioGoTrue'
import { MANAGER_BROKER_ENABLED, testManagerBrokerFunction } from '@/lib/api/self-hosted/managerBroker'
import { COOKIE_NAME, decodeSessionPayload, verifyToken } from '@/pages/api/self-hosted/session'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'POST':
      return handlePost(req, res)
    default:
      return new Response(
        JSON.stringify({ data: null, error: { message: `Method ${method} Not Allowed` } }),
        {
          status: 405,
          headers: { 'Content-Type': 'application/json', Allow: 'POST' },
        }
      )
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { url: requestUrl, method, body: requestBody, headers: customHeaders, projectRef } = req.body ?? {}
    if (typeof requestUrl !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
      return res.status(400).json({ status: 400, error: { message: 'Invalid function test request' } })
    }
    let url = requestUrl
    let brokerProjectId: string | undefined
    let actorEmail: string | undefined
    if (!IS_PLATFORM) {
      if (STUDIO_AUTH_MANAGER !== MANAGER_BROKER_ENABLED) {
        return res.status(503).json({ status: 503, error: { message: 'Manager function testing requires the private broker' } })
      }
      if (typeof projectRef !== 'string') {
        return res.status(400).json({ status: 400, error: { message: 'Project reference is required' } })
      }
      const project = getStoredProjectByRef(projectRef)
      if (!project) return res.status(404).json({ status: 404, error: { message: 'Project not found' } })
      const member = STUDIO_AUTH_GOTRUE ? await getGoTrueAuthMember(req) : getManagerSessionMember(req)
      if (STUDIO_AUTH_MANAGER || STUDIO_AUTH_GOTRUE || process.env.DASHBOARD_PASSWORD) {
        const token = req.cookies[COOKIE_NAME]
        if ((!STUDIO_AUTH_GOTRUE && (!token || !verifyToken(token))) ||
            ((STUDIO_AUTH_MANAGER || STUDIO_AUTH_GOTRUE || (token && decodeSessionPayload(token)?.gotrue_id)) && !member)) {
          return res.status(401).json({ status: 401, error: { message: 'Unauthorized' } })
        }
      }
      if (member && !hasFunctionProjectAccess(member.gotrue_id, projectRef, getOrgMembers(project.organization_slug))) {
        return res.status(403).json({ status: 403, error: { message: 'Project membership required' } })
      }
      const path = edgeFunctionPath(requestUrl, project.public_url)
      if (!path) return res.status(400).json({ status: 400, error: { message: 'Provided URL is not a project edge function URL' } })
      if (STUDIO_AUTH_MANAGER) {
        if (!project.broker_project_id) return res.status(409).json({ status: 409, error: { message: 'Project is not broker-managed' } })
        brokerProjectId = project.broker_project_id
        actorEmail = member!.primary_email
      } else {
        // Legacy projects use only their registered gateway; the default can map to its configured internal origin.
        const internal = new URL(projectRef === 'default' ? (process.env.SUPABASE_URL || project.public_url) : project.public_url)
        if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password) {
          return res.status(503).json({ status: 503, error: { message: 'Project gateway is not configured' } })
        }
        url = internal.origin + path
      }
    }

    const validEdgeFnUrl = IS_PLATFORM ? isValidEdgeFunctionURL(url, true) : true

    if (!validEdgeFnUrl) {
      return res.status(400).json({
        status: 400,
        error: { message: 'Provided URL is not a valid Supabase edge function URL' },
      })
    }

    const functionHeaders = edgeFunctionRequestHeaders(customHeaders)
    const requestHeaders = Object.fromEntries(functionHeaders.entries())

    // Prepare the request body based on method and Content-Type
    let finalBody = undefined
    if (method !== 'GET' && method !== 'HEAD') {
      if (functionHeaders.get('content-type') === 'application/json') {
        finalBody = typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody)
      } else {
        finalBody = requestBody
      }
    }

    const response = brokerProjectId
      ? await testManagerBrokerFunction(brokerProjectId, { actorEmail: actorEmail!, url: requestUrl, method, headers: requestHeaders, body: finalBody })
      : await fetch(url, {
      method,
      headers: requestHeaders,
      body: finalBody,
      redirect: 'manual', // don't follow the redirect and return response as is
    })

    // Handle non-JSON responses
    let responseBody = await response.text()
    const contentType = response.headers.get('content-type')
    if (responseBody && contentType?.includes('application/json')) {
      // If JSON, parse and stringify to ensure it's valid JSON
      const jsonBody = JSON.parse(responseBody)
      responseBody = JSON.stringify(jsonBody)
    }

    if (!response.ok) {
      // Try to parse error response if it's JSON
      try {
        const errorBody = JSON.parse(responseBody)

        return res.status(response.status).json({
          status: response.status,
          error: { message: errorBody?.error || 'Edge function returned an error' },
        })
      } catch (parseError) {
        // If not JSON, return the raw error
        return res.status(response.status).json({
          status: response.status,
          error: { message: responseBody || 'Edge function returned an error' },
        })
      }
    }

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    return res.status(response.status).json({
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
    })
  } catch (error: any) {
    return res.status(500).json({
      status: 500,
      error: {
        message: error.message || 'Failed to test edge function',
      },
    })
  }
}
