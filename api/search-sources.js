import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { findDuplicateSource } from '../lib/normalizeSourceText.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, q } = req.query
  if (!q) return res.status(400).json({ error: 'q parameter required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  const { data, error } = await supabase
    .from('sources')
    .select('id, original_text')
    .eq('project_id', project_id)

  if (error) return res.status(500).json({ error: error.message })
  const match = findDuplicateSource(data ?? [], q)
  return res.status(200).json(match ? [match] : [])
}
