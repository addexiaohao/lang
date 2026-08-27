import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

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

  const { project_id, q, exclude } = req.query
  if (!q) return res.status(400).json({ error: 'q parameter required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  let query = supabase
    .from('knowledge_cards')
    .select('id, name, kind, tags')
    .ilike('name', `%${q}%`)
    .eq('project_id', project_id)
    .limit(5)

  // `exclude` — comma-separated card ids to leave out of the results (plan.md — "Card Groups"'
  // shared search bar excludes cards already in the group being edited, and a card excludes
  // itself when relating from its own detail view).
  const excludeIds = exclude ? String(exclude).split(',').map(id => id.trim()).filter(Boolean) : []
  if (excludeIds.length > 0) query = query.not('id', 'in', `(${excludeIds.join(',')})`)

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json(data)
}
