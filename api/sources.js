import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

const PAGE_SIZE = 25

export default async function handler(req, res) {
  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { project_id, id, q, context_ids, limit: limitParam, offset: offsetParam } = req.query
  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  // Single-source detail fetch
  if (id) {
    const { data, error } = await supabase
      .from('sources')
      .select(`
        id, original_text, created_at,
        contexts(id, name),
        source_knowledge(
          positions,
          knowledge_cards(id, name, kind, tags, importance)
        )
      `)
      .eq('project_id', project_id)
      .eq('id', id)
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  const limit = Math.min(parseInt(limitParam) || PAGE_SIZE, 100)
  const offset = Math.max(parseInt(offsetParam) || 0, 0)

  let query = supabase
    .from('sources')
    .select(`
      id, original_text, created_at,
      contexts(id, name),
      source_knowledge(
        knowledge_cards(id, name, kind, tags, importance)
      )
    `, { count: 'exact' })
    .eq('project_id', project_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (q) query = query.ilike('original_text', `%${q}%`)
  if (context_ids) query = query.in('context_id', context_ids.split(','))

  const { data, error, count } = await query

  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ sources: data, total: count })
}
