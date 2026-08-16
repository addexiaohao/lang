import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { validateSkillType } from '../lib/skillTypes.js'

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

    const { importance, skill_type, level, practice_result } = req.body ?? {}

    if (skill_type !== undefined) {
      const isPracticeResult = practice_result !== undefined
      if (!isPracticeResult && level === undefined && importance === undefined) {
        return res.status(400).json({ error: 'level, importance, or practice_result required' })
      }
      if (isPracticeResult && practice_result !== 'correct' && practice_result !== 'incorrect') {
        return res.status(400).json({ error: 'practice_result must be "correct" or "incorrect"' })
      }
      if (level !== undefined && level !== null && (!Number.isInteger(level) || level < 1 || level > 10)) {
        return res.status(400).json({ error: 'level must be an integer between 1 and 10, or null' })
      }
      if (importance !== undefined && importance !== null && (!Number.isInteger(importance) || importance < 1 || importance > 10)) {
        return res.status(400).json({ error: 'importance must be an integer between 1 and 10, or null' })
      }
      const { data: card, error: cardErr } = await supabase
        .from('knowledge_cards')
        .select('id, kind, details')
        .eq('project_id', project_id)
        .eq('id', id)
        .single()
      if (cardErr || !card) return res.status(404).json({ error: 'Card not found' })
      if (!validateSkillType(card, skill_type)) {
        return res.status(400).json({ error: `"${skill_type}" is not a valid skill type for this card` })
      }

      // Practice attempt (right/wrong/don't know from PracticePanel): bump level by one step
      // (floor 1, ceiling 10), instead of setting an explicit level like the manual editor does.
      // last_correct only stamps on a correct attempt — it's not "last attempted", it's "last
      // gotten right".
      if (isPracticeResult) {
        const { data: existing } = await supabase
          .from('skill')
          .select('level')
          .eq('card_id', id)
          .eq('type', skill_type)
          .maybeSingle()
        const currentLevel = existing?.level ?? 1
        const nextLevel = practice_result === 'correct'
          ? Math.min(currentLevel + 1, 10)
          : Math.max(currentLevel - 1, 1)

        const row = { card_id: id, type: skill_type, level: nextLevel }
        if (practice_result === 'correct') row.last_correct = new Date().toISOString()

        const { data, error } = await supabase
          .from('skill')
          .upsert(row, { onConflict: 'card_id,type' })
          .select('id, type, level, importance, last_correct')
          .single()

        if (error) return res.status(500).json({ error: error.message })
        return res.status(200).json(data)
      }

      const row = { card_id: id, type: skill_type }
      if (level !== undefined) row.level = level
      if (importance !== undefined) row.importance = importance

      const { data, error } = await supabase
        .from('skill')
        .upsert(row, { onConflict: 'card_id,type' })
        .select('id, type, level, importance, last_correct')
        .single()

      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json(data)
    }

    if (importance === undefined) return res.status(400).json({ error: 'importance or skill_type required' })
    if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
      return res.status(400).json({ error: 'importance must be an integer between 1 and 10' })
    }

    const { data, error } = await supabase
      .from('knowledge_cards')
      .update({ importance })
      .eq('project_id', project_id)
      .eq('id', id)
      .select('id, name, kind, tags, importance, details, created_at')
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  if (id) {
    const { data, error } = await supabase
      .from('knowledge_cards')
      .select(`
        id, name, kind, tags, importance, details, created_at,
        skill(id, type, level, importance, last_correct),
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
    .select('id, name, kind, tags, importance, created_at, source_knowledge(count)', { count: 'exact' })
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
