import { NextApiRequest, NextApiResponse } from 'next'

import { storageApiWrapper as apiWrapper, getProjectStorageClient, projectStorageUrl } from '@/lib/api/self-hosted/storageClient'

const wrappedHandler = (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

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
  const { path, expiresIn = 60 * 60 * 24 } = req.body

  const { data, error } = await supabase.storage
    .from(id as string)
    .createSignedUrls(path, expiresIn)

  if (error) {
    return res.status(400).json({ error: { message: error.message } })
  }

  const remapped = (data ?? []).map((item) => {
    if (!item.signedUrl) return item
    return { ...item, signedUrl: projectStorageUrl(req, item.signedUrl) }
  })

  return res.status(201).json(remapped)
}

export default wrappedHandler
