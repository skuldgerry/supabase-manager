import { NextApiRequest, NextApiResponse } from 'next'

import { storageApiWrapper as apiWrapper, getProjectStorageClient, projectStorageUrl } from '@/lib/api/self-hosted/storageClient'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'POST':
      return handlePost(req, res)
    default:
      res.setHeader('Allow', ['POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handlePost = async (req: NextApiRequest, res: NextApiResponse) => {
  const supabase = await getProjectStorageClient(req)
  const { id } = req.query
  const { path } = req.body

  const { data } = supabase.storage.from(id as string).getPublicUrl(path)

  data.publicUrl = projectStorageUrl(req, data.publicUrl)

  return res.status(200).json(data)
}
