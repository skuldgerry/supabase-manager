import type { NextApiRequest, NextApiResponse } from 'next'

import { getManagerBrokerMfaStatus, updateManagerBrokerMfa } from '@/lib/api/self-hosted/managerBroker'
import { getManagerSessionMember } from '@/lib/api/self-hosted/managerSession'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const member = getManagerSessionMember(req)
  if (!member) return res.status(401).json({ error: 'Unauthorized' })
  try {
    if (req.method === 'GET') return res.status(200).json(await getManagerBrokerMfaStatus(member.primary_email))
    if (req.method === 'POST') {
      const { action, password, code } = req.body ?? {}
      if (!['enroll', 'confirm', 'disable'].includes(action)) return res.status(400).json({ error: 'Invalid MFA action' })
      return res.status(200).json(await updateManagerBrokerMfa({
        action,
        email: member.primary_email,
        password: String(password ?? ''),
        ...(code ? { code: String(code) } : {}),
      }))
    }
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` })
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'MFA operation failed' })
  }
}
