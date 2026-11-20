import type { NextApiRequest, NextApiResponse } from 'next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import handler from '../../pages/api/platform/projects/[ref]/pocketbase-migrate'

const state = vi.hoisted(() => ({
  managerMode: true,
  getProject: vi.fn(),
  getJob: vi.fn(),
  startMigration: vi.fn(),
}))

vi.mock('@/lib/constants', () => ({
  get STUDIO_AUTH_MANAGER() {
    return state.managerMode
  },
}))
vi.mock('@/lib/api/apiWrapper', () => ({
  default: (
    req: NextApiRequest,
    res: NextApiResponse,
    callback: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>
  ) => callback(req, res),
}))
vi.mock('@/lib/api/self-hosted/projectsStore', () => ({
  getStoredProjectByRef: state.getProject,
}))
vi.mock('@/lib/api/self-hosted/pocketbaseMigrationRunner', () => ({
  getPBMigrationJob: state.getJob,
  startPBMigration: state.startMigration,
}))

async function request(method: 'GET' | 'POST') {
  const req = {
    method,
    query: { ref: 'project-one', job: 'job-one' },
    body: {
      direction: 'pb-to-supa',
      pb_url: 'https://pocketbase.example.test',
      pb_admin_email: 'fixture@example.test',
      pb_admin_password: 'fixture-only',
    },
  } as NextApiRequest
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  }
  await handler(req, response as unknown as NextApiResponse)
  return response
}

describe('PocketBase migration availability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.managerMode = true
    state.getProject.mockReturnValue({
      service_key: 'fixture-service-key',
      public_url: 'https://supabase.example.test',
    })
  })

  it.each(['GET', 'POST'] as const)('does not handle %s in Manager mode', async (method) => {
    const res = await request(method)
    expect(res.status).toHaveBeenCalledWith(404)
    expect(state.getProject).not.toHaveBeenCalled()
    expect(state.getJob).not.toHaveBeenCalled()
    expect(state.startMigration).not.toHaveBeenCalled()
  })

  it('keeps migration start and polling available in legacy mode', async () => {
    state.managerMode = false
    state.startMigration.mockReturnValue('job-one')
    const started = await request('POST')
    expect(started.status).toHaveBeenCalledWith(202)
    expect(started.json).toHaveBeenCalledWith({ job_id: 'job-one' })

    const job = { id: 'job-one', status: 'running' }
    state.getJob.mockReturnValue(job)
    const polled = await request('GET')
    expect(polled.status).toHaveBeenCalledWith(200)
    expect(polled.json).toHaveBeenCalledWith(job)
  })
})
