import type { NextApiRequest } from 'next'

import { findMemberByGotrueId, getBaseRoleId, type StoredMember } from './membersStore'
import {
  COOKIE_NAME,
  decodeSessionPayload,
  verifyToken,
} from '@/pages/api/self-hosted/session'

export function getManagerSessionMember(req: NextApiRequest): StoredMember | null {
  const token = req.cookies[COOKIE_NAME]
  if (!token || !verifyToken(token)) return null
  const identity = decodeSessionPayload(token)
  if (!identity?.gotrue_id) return null
  return findMemberByGotrueId(identity.gotrue_id)?.member ?? null
}

export function getManagerSessionAdministrator(req: NextApiRequest): StoredMember | null {
  const member = getManagerSessionMember(req)
  if (!member) return null
  return member.role_ids.some((roleId) => [1, 2].includes(getBaseRoleId(roleId))) ? member : null
}
