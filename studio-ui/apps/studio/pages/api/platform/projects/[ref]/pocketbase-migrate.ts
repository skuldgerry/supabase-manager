import type { NextApiRequest, NextApiResponse } from 'next'
import apiWrapper from '@/lib/api/apiWrapper'
import { getStoredProjectByRef, getStoredProjects } from '@/lib/api/self-hosted/projectsStore'
import { getPBMigrationJob, startPBMigration } from '@/lib/api/self-hosted/pocketbaseMigrationRunner'
import {
  authorizeMigration, isPocketBaseProject, MigrationAccessError, migrationIdentity, migrationTargets,
  requireStudioMigrationAccess, selectMigrationTarget, supabaseMigrationConnection,
} from '@/lib/api/self-hosted/pocketbaseMigrationAccess'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store, private')
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).json({ error: { message: 'Method Not Allowed' } })
  }
  try {
    const member = await migrationIdentity(req)
    const ref = req.query.ref
    const project = typeof ref === 'string' ? getStoredProjectByRef(ref) : undefined
    if (!project) throw new MigrationAccessError(404, 'Project not found')

    if (req.method === 'GET' && req.query.options === '1') {
      requireStudioMigrationAccess(project, member)
      const targets = migrationTargets()
      const supabaseProjects: { ref: string; name: string }[] = []
      const permittedTargets = [] as typeof targets
      if (isPocketBaseProject(project)) {
        const pocketbase = targets.find((target) => target.projectRef === ref)
        if (!pocketbase) throw new MigrationAccessError(404, 'PocketBase target not found')
        for (const candidate of getStoredProjects().filter((entry) => !isPocketBaseProject(entry))) {
          try { await authorizeMigration(candidate, member, pocketbase); supabaseProjects.push({ ref: candidate.ref, name: candidate.name }) }
          catch (error) { if (!(error instanceof MigrationAccessError) || ![403, 404, 409].includes(error.status)) throw error }
        }
        if (!supabaseProjects.length) throw new MigrationAccessError(403, 'No authorized, ready Supabase migration project is available')
        permittedTargets.push(pocketbase)
      } else {
        await authorizeMigration(project, member)
        supabaseProjects.push({ ref: project.ref, name: project.name })
        for (const target of targets) {
          try { await authorizeMigration(project, member, target); permittedTargets.push(target) }
          catch (error) { if (!(error instanceof MigrationAccessError) || ![403, 409].includes(error.status)) throw error }
        }
      }
      return res.status(200).json({ supabaseProjects, targets: permittedTargets.map(({ id, name, url, projectRef }) => ({ id, name, url, projectRef })) })
    }

    // Reauthorize against the broker before looking up a job or starting any I/O.
    await authorizeMigration(project, member)
    if (req.method === 'GET') {
      const jobId = req.query.job
      if (typeof jobId !== 'string' || jobId.length !== 16 || /[^a-f0-9]/.test(jobId)) throw new MigrationAccessError(400, 'A valid migration job ID is required')
      const job = getPBMigrationJob(jobId, project.ref)
      if (!job || job.supaRef !== ref) throw new MigrationAccessError(404, 'Migration job not found for this project')
      // Older metadata is supported only while its exact endpoint remains trusted.
      const target = selectMigrationTarget(job.pbTargetId ? { pb_target_id: job.pbTargetId } : { pb_url: job.pbUrl })
      if (target.url !== job.pbUrl || (job.pbProjectRef && target.projectRef !== job.pbProjectRef)
        || (job.pbOrganizationSlug && target.organizationSlug !== job.pbOrganizationSlug)
        || (job.pbCollectionPrefix ?? '') !== (target.collectionPrefix ?? '')) {
        throw new MigrationAccessError(409, 'Migration target registration has changed')
      }
      await authorizeMigration(project, member, target)
      return res.status(200).json(job)
    }

    const body = req.body ?? {}
    if (body.direction !== 'pb-to-supa' && body.direction !== 'supa-to-pb') throw new MigrationAccessError(400, 'Choose pb-to-supa or supa-to-pb')
    const target = selectMigrationTarget(body)
    await authorizeMigration(project, member, target)
    const registered = target.projectRef ? getStoredProjectByRef(target.projectRef) : undefined
    const email = body.pb_admin_email || registered?.pocketbase_admin_email
    const password = body.pb_admin_password || registered?.pocketbase_admin_password
    if (typeof email !== 'string' || !email.trim() || email.length > 254 || typeof password !== 'string' || !password || password.length > 1024) {
      throw new MigrationAccessError(400, 'PocketBase administrator email and password are required')
    }
    const connection = supabaseMigrationConnection(project)
    const jobId = startPBMigration({
      direction: body.direction, pbUrl: target.url, pbAdminEmail: email.trim(), pbAdminPassword: password,
      supaRef: project.ref, supaPublicUrl: project.public_url, supaRequest: connection.request,
      redactionSecrets: connection.secrets, pbTargetId: target.id, pbProjectRef: target.projectRef,
      pbOrganizationSlug: target.organizationSlug, pbCollectionPrefix: target.collectionPrefix,
    })
    return res.status(202).json({ job_id: jobId })
  } catch (error) {
    return res.status(error instanceof MigrationAccessError ? error.status : 500).json({
      error: { message: error instanceof MigrationAccessError ? error.message : 'Migration request could not be completed' },
    })
  }
}
