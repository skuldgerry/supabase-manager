import { z } from 'zod'

import { getRepository } from '@/lib/db/manager'
import type { HostId, OrganizationId } from '@/lib/domain'
import { authorizeInternalRequest, unauthorizedInternalResponse } from '@/lib/internal/auth'
import { internalProjectView } from '@/lib/internal/project-view'
import { validateExternalAdoption, verifySameHostSupabaseStack } from '@/lib/orchestrator/external-adoption'
import { encryptJson, getMasterKey } from '@/lib/security/encryption'

export const dynamic = 'force-dynamic'

const port = z.number().int().min(1).max(65535)
const bodySchema = z.object({
  name: z.string().trim().min(2).max(100),
  actorEmail: z.email(),
  organization: z.object({
    name: z.string().trim().min(2).max(100),
    slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/),
  }),
  publicUrl: z.url(),
  siteUrl: z.url().optional(),
  localApiPort: port,
  dbHost: z.string().trim().min(1).max(253),
  dbPort: port,
  dbSessionPort: port,
  dbTransactionPort: port,
  databaseUsername: z.string().trim().min(1).max(64),
  stackRelease: z.string().trim().regex(/^self-hosted\/v\d+\.\d+\.\d+$/),
  dashboardUsername: z.string().trim().min(3).max(64),
  credentials: z.object({
    postgresPassword: z.string().min(1).max(512),
    dashboardPassword: z.string().min(1).max(512),
    jwtSecret: z.string().min(32).max(512),
    anonKey: z.string().min(20).max(4096),
    serviceRoleKey: z.string().min(20).max(4096),
    publishableKey: z.string().min(1).max(4096).optional(),
    secretKey: z.string().min(1).max(4096).optional(),
  }),
})

export async function POST(request: Request) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse()
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 })
  }

  const repository = getRepository()
  const actor = repository.getUserByEmail(parsed.data.actorEmail)
  if (!actor) return Response.json({ error: 'Broker administrator not found' }, { status: 409 })
  let organization = repository
    .listOrganizations()
    .find((item) => item.slug === parsed.data.organization.slug)
  if (!organization) {
    organization = repository.createOrganization({
      name: parsed.data.organization.name,
      slug: parsed.data.organization.slug,
      createdBy: actor.id,
    }).organization
  }
  if (!repository.canManageOrganization(organization.id, actor.id)) {
    return Response.json({ error: 'Administrator cannot manage this organization' }, { status: 403 })
  }
  const host = repository.listHosts()[0]
  if (!host) return Response.json({ error: 'No Docker host is registered' }, { status: 503 })

  try {
    validateExternalAdoption({
      apiUrl: parsed.data.publicUrl,
      dbHost: parsed.data.dbHost,
      dbPort: parsed.data.dbPort,
      anonKey: parsed.data.credentials.anonKey,
      serviceRoleKey: parsed.data.credentials.serviceRoleKey,
      postgresPassword: parsed.data.credentials.postgresPassword,
      dashboardPassword: parsed.data.credentials.dashboardPassword,
      jwtSecret: parsed.data.credentials.jwtSecret,
      release: parsed.data.stackRelease,
    })
    const ownership = await verifySameHostSupabaseStack({
      apiPort: parsed.data.localApiPort,
      anonKey: parsed.data.credentials.anonKey,
      serviceRoleKey: parsed.data.credentials.serviceRoleKey,
      postgresPassword: parsed.data.credentials.postgresPassword,
    })
    const project = repository.adoptExternalProject({
      organizationId: organization.id as OrganizationId,
      hostId: host.id as HostId,
      name: parsed.data.name,
      slug: parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project',
      stackRelease: parsed.data.stackRelease,
      publicUrl: parsed.data.publicUrl,
      siteUrl: parsed.data.siteUrl ?? parsed.data.publicUrl,
      ports: {
        api: parsed.data.localApiPort,
        dbSession: parsed.data.dbSessionPort,
        dbTransaction: parsed.data.dbTransactionPort,
      },
      databaseUsername: parsed.data.databaseUsername,
      dashboardUsername: parsed.data.dashboardUsername,
      createdBy: actor.id,
      ownership: 'external',
    })
    const associatedData = `${project.id}:project-credentials`
    const values = {
      POSTGRES_PASSWORD: parsed.data.credentials.postgresPassword,
      JWT_SECRET: parsed.data.credentials.jwtSecret,
      ANON_KEY: parsed.data.credentials.anonKey,
      SERVICE_ROLE_KEY: parsed.data.credentials.serviceRoleKey,
      SUPABASE_PUBLISHABLE_KEY: parsed.data.credentials.publishableKey ?? parsed.data.credentials.anonKey,
      SUPABASE_SECRET_KEY: parsed.data.credentials.secretKey ?? parsed.data.credentials.serviceRoleKey,
      DASHBOARD_USERNAME: parsed.data.dashboardUsername,
      DASHBOARD_PASSWORD: parsed.data.credentials.dashboardPassword,
      DB_HOST: parsed.data.dbHost,
      DB_PORT: String(parsed.data.dbPort),
      DB_USER: parsed.data.databaseUsername,
      DB_SESSION_PORT: String(parsed.data.dbSessionPort),
      DB_TRANSACTION_PORT: String(parsed.data.dbTransactionPort),
      EXTERNAL_DOCKER_PROJECT: ownership.composeProject,
    }
    const encrypted = encryptJson(values, await getMasterKey(), associatedData)
    repository.upsertCredential({
      projectId: project.id,
      kind: 'other',
      name: 'project-credentials',
      ciphertextBase64: encrypted.ciphertext,
      nonceBase64: encrypted.iv,
      authTagBase64: encrypted.tag,
      associatedData,
    })
    return Response.json({
      ...(await internalProjectView(project)),
      adoption: { connectivity: 'verified-same-host', composeProject: ownership.composeProject },
    }, { status: 201 })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'External project could not be imported' },
      { status: 409 }
    )
  }
}
