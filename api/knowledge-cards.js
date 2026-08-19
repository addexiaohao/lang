import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { validateSkillType } from '../lib/skillTypes.js'
import { logPracticeAttempt } from '../lib/practiceAttempts.js'

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PATCH' && req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const {
    project_id, id, q, tag, tags, kind, sort, sort_dir, limit = '20', offset = '0',
    below_level, practice_state,
  } = req.query
  if (!project_id) return res.status(400).json({ error: 'project_id required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  if (req.method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'id required' })

    // skill(card_id) and practice_attempt(skill_id) cascade off knowledge_cards/skill respectively,
    // and source_knowledge(knowledge_card_id) now does too (see schema.sql) — deleting the card row
    // is enough to take its skills, practice history, and source links with it.
    const { data, error } = await supabase
      .from('knowledge_cards')
      .delete()
      .eq('project_id', project_id)
      .eq('id', id)
      .select('id')
      .maybeSingle()

    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Card not found' })
    return res.status(204).end()
  }

  if (req.method === 'PATCH') {
    if (!id) return res.status(400).json({ error: 'id required' })

    const { importance, name, skill_type, level, practice_result, model, encounter_id, conversation } = req.body ?? {}

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
      if (importance !== undefined && importance !== null && (!Number.isInteger(importance) || importance < 0 || importance > 10)) {
        return res.status(400).json({ error: 'importance must be an integer between 0 and 10, or null' })
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
      // gotten right". hand_set is cleared — an earned level, not a self-assessment (plan.md §5).
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

        const row = { card_id: id, type: skill_type, level: nextLevel, hand_set: false }
        if (practice_result === 'correct') row.last_correct = new Date().toISOString()

        const { data, error } = await supabase
          .from('skill')
          .upsert(row, { onConflict: 'card_id,type' })
          .select('id, type, level, importance, hand_set, last_correct')
          .single()

        if (error) return res.status(500).json({ error: error.message })

        const { error: attemptErr } = await logPracticeAttempt({ skillId: data.id, encounterId: encounter_id, outcome: practice_result, model, conversation })
        if (attemptErr) console.error('[practice_attempt] failed to log attempt', attemptErr)

        return res.status(200).json(data)
      }

      // Manual editor (CardDetailPanel, Skills page): an explicit `level` here is a
      // self-assessment, not an earned result, so it's marked hand_set — plan.md §5's "hand-set
      // levels must be visually distinct from earned ones". Only touched when `level` is actually
      // part of this PATCH (an importance-only PATCH must not flip hand_set on a level it isn't
      // changing).
      const row = { card_id: id, type: skill_type }
      if (level !== undefined) {
        row.level = level
        row.hand_set = level !== null
      }
      if (importance !== undefined) row.importance = importance

      const { data, error } = await supabase
        .from('skill')
        .upsert(row, { onConflict: 'card_id,type' })
        .select('id, type, level, importance, hand_set, last_correct')
        .single()

      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json(data)
    }

    if (importance === undefined && name === undefined) return res.status(400).json({ error: 'importance, name, or skill_type required' })
    if (importance !== undefined && (!Number.isInteger(importance) || importance < 0 || importance > 10)) {
      return res.status(400).json({ error: 'importance must be an integer between 0 and 10' })
    }
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      return res.status(400).json({ error: 'name must be a non-empty string' })
    }

    const update = {}
    if (importance !== undefined) update.importance = importance
    if (name !== undefined) update.name = name.trim()

    const { data, error } = await supabase
      .from('knowledge_cards')
      .update(update)
      .eq('project_id', project_id)
      .eq('id', id)
      .select('id, name, kind, tags, importance, details, created_at')
      .single()

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: `A card named "${update.name}" already exists in this project` })
      return res.status(500).json({ error: error.message })
    }
    return res.status(200).json(data)
  }

  if (id) {
    const { data, error } = await supabase
      .from('knowledge_cards')
      .select(`
        id, name, kind, tags, importance, details, created_at,
        skill(id, type, level, importance, hand_set, last_correct),
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

  // `tag` (legacy, single — TagsPanel) and `tags` (new, CSV — CardsPanel's multi-select, plan.md
  // §7) both feed browse_cards' single p_tags array (AND semantics: card must carry every tag
  // given). browse_cards is a superset of the old plain query — see schema.sql — so the list
  // branch always goes through it now, even when none of the §7 filters are in play.
  const tagList = [
    ...(tag ? [tag] : []),
    ...(tags ? String(tags).split(',').map(t => t.trim()).filter(Boolean) : []),
  ]
  if (below_level !== undefined && (!Number.isInteger(Number(below_level)) || Number(below_level) < 1 || Number(below_level) > 10)) {
    return res.status(400).json({ error: 'below_level must be an integer between 1 and 10' })
  }
  if (practice_state !== undefined && practice_state !== 'never_practiced' && practice_state !== 'has_failures') {
    return res.status(400).json({ error: 'practice_state must be "never_practiced" or "has_failures"' })
  }

  const { data, error } = await supabase.rpc('browse_cards', {
    p_project_id: project_id,
    p_search: q || null,
    p_kind: kind || null,
    p_tags: tagList.length > 0 ? tagList : null,
    p_below_level: below_level !== undefined ? Number(below_level) : null,
    p_practice_state: practice_state || null,
    p_sort: sort === 'recent' ? 'created' : (sort || 'name'),
    p_sort_dir: sort_dir || (sort === 'recent' ? 'desc' : 'asc'),
    p_limit: Number(limit),
    p_offset: Number(offset),
  })
  if (error) return res.status(500).json({ error: error.message })

  const total = data[0]?.total_count ?? 0
  const cards = data.map(({ total_count, card_id, mean_level, ...row }) => ({
    ...row,
    id: card_id,
    mean_level: mean_level != null ? Number(mean_level) : null,
  }))
  return res.status(200).json({ cards, total: Number(total) })
}
