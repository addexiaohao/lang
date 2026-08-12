import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, id, q, tag, kind, sort, limit = '20', offset = '0' } = req.query
  if (!project_id) return res.status(400).json({ error: 'project_id required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  if (req.method === 'PATCH') {
    if (!id) return res.status(400).json({ error: 'id required' })

    const { importance } = req.body ?? {}
    if (importance === undefined) return res.status(400).json({ error: 'importance required' })
    if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
      return res.status(400).json({ error: 'importance must be an integer between 1 and 10' })
    }

    const { data, error } = await supabase
      .from('knowledge_cards')
      .update({ importance })
      .eq('project_id', project_id)
      .eq('id', id)
      .select('id, name, kind, tags, skill, importance, details, created_at')
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  if (id) {
    const { data, error } = await supabase
      .from('knowledge_cards')
      .select(`
        id, name, kind, tags, skill, importance, details, created_at,
        source_knowledge(
          source_id,
          positions,
          sources(id, original_text, created_at, contexts(id, name))
        )
      `)
      .eq('project_id', project_id)
      .eq('id', id)
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  let query = supabase
    .from('knowledge_cards')
    .select('id, name, kind, tags, skill, importance, created_at, source_knowledge(count)', { count: 'exact' })
    .eq('project_id', project_id)
    .order(sort === 'recent' ? 'created_at' : 'name', { ascending: sort !== 'recent' })
    .range(Number(offset), Number(offset) + Number(limit) - 1)

  if (q) query = query.ilike('name', `%${q}%`)
  if (tag) query = query.contains('tags', [tag])
  if (kind) query = query.eq('kind', kind)

  const { data, error, count } = await query
  if (error) return res.status(500).json({ error: error.message })
  const cards = data.map(({ source_knowledge, ...card }) => ({
    ...card,
    link_count: source_knowledge?.[0]?.count ?? 0,
  }))
  return res.status(200).json({ cards, total: count })
}
