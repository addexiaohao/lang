import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { validateSkillType, skillDbColumns, resolveSkillType, hasSenseAxis, deriveSkillImportance } from '../lib/skillTypes.js'
import { logPracticeAttempt } from '../lib/practiceAttempts.js'
import { computeSchedule, scheduleForManualLevel, nextLevel as nextLevelFor, NEVER_SCHEDULE } from '../lib/practiceScheduling.js'

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

    const { importance, name, tags, skill_type, level, practice_result, model, encounter_id, conversation, sense_key, sense_gloss, new_sense, existing_sense, link_existing_sources } = req.body ?? {}

    // "Refine existing sense" (plan.md — "Word Senses" §3): correct a sense's gloss in place,
    // without forking a new sense — distinct from the skill_type branch below, since a gloss lives
    // in knowledge_cards.details.axes, not on the skill row. Distinct from the new_sense branch
    // below too, since here sense_gloss REPLACES an existing sense's gloss rather than adding one.
    if (sense_key !== undefined && new_sense === undefined) {
      if (typeof sense_key !== 'string' || !sense_key.trim() || typeof sense_gloss !== 'string' || !sense_gloss.trim()) {
        return res.status(400).json({ error: 'sense_key and sense_gloss must be non-empty strings' })
      }
      const { data: owned } = await supabase.from('knowledge_cards').select('id').eq('id', id).eq('project_id', project_id).maybeSingle()
      if (!owned) return res.status(404).json({ error: 'Card not found' })
      const { data, error } = await supabase.rpc('update_sense_gloss', { p_card_id: id, p_key: sense_key, p_gloss: sense_gloss })
      if (error) return res.status(400).json({ error: error.message })
      return res.status(200).json(data)
    }

    // Manually add/name a sense straight from CardDetailPanel — the same migrate_card_to_senses/
    // append_sense_value RPCs the chat save flow uses (api/save.js), just with no source link
    // involved. Two distinct shapes, matched by which field(s) are present:
    //   { existing_sense }              -> a monosemous card, naming the ONE sense already there —
    //                                       AddSenseForm.jsx's primary action, no second sense implied
    //   { existing_sense, new_sense }   -> same, but the user also already knows a second sense
    //   { new_sense }                   -> card already sense-split, appending another value
    // Clicking "add sense" on a monosemous card is usually just the first case (see AddSenseForm.jsx)
    // — new_sense being optional there is the point, not an oversight.
    if (new_sense !== undefined || existing_sense !== undefined) {
      const { data: card, error: cardErr } = await supabase
        .from('knowledge_cards')
        .select('id, kind, details, importance')
        .eq('project_id', project_id)
        .eq('id', id)
        .single()
      if (cardErr || !card) return res.status(404).json({ error: 'Card not found' })
      if (card.kind !== 'vocabulary') return res.status(400).json({ error: 'Only vocabulary cards can have senses' })

      const skillImportance = deriveSkillImportance(card.kind, 'meaning', card.importance)
      const validSense = (s) => typeof s?.key === 'string' && s.key.trim() && typeof s?.gloss === 'string' && s.gloss.trim()
      let senseErr, senseData

      if (hasSenseAxis(card)) {
        if (!validSense(new_sense)) {
          return res.status(400).json({ error: 'new_sense.key and new_sense.gloss are required to add another sense' })
        }
        ;({ data: senseData, error: senseErr } = await supabase.rpc('append_sense_value', {
          p_card_id: card.id, p_key: new_sense.key.trim(), p_gloss: new_sense.gloss.trim(), p_example: new_sense.example || null, p_importance: skillImportance,
        }))
      } else {
        if (!validSense(existing_sense)) {
          return res.status(400).json({ error: 'existing_sense.key and existing_sense.gloss are required' })
        }
        const hasNewSense = new_sense !== undefined
        if (hasNewSense && !validSense(new_sense)) {
          return res.status(400).json({ error: 'new_sense.key and new_sense.gloss must be non-empty strings when provided' })
        }
        ;({ data: senseData, error: senseErr } = await supabase.rpc('migrate_card_to_senses', {
          p_card_id: card.id,
          p_existing_key: existing_sense.key.trim(), p_existing_gloss: existing_sense.gloss.trim(), p_existing_example: existing_sense.example || null,
          p_new_key: hasNewSense ? new_sense.key.trim() : null,
          p_new_gloss: hasNewSense ? new_sense.gloss.trim() : null,
          p_new_example: hasNewSense ? (new_sense.example || null) : null,
          p_new_importance: skillImportance,
        }))
        // The card's OTHER, already-linked sources predate any sense distinction — they almost
        // certainly belong to the sense that was "the meaning all along" (existing_sense), not a
        // sense that's only being introduced right now. Opt-in, checked from the client only after
        // the user has seen and approved it (AddSenseForm.jsx) — never inferred silently.
        if (!senseErr && link_existing_sources) {
          await supabase
            .from('source_knowledge')
            .update({ skill_id: senseData.existing_skill_id })
            .eq('knowledge_card_id', card.id)
            .is('skill_id', null)
        }
      }
      if (senseErr) return res.status(400).json({ error: senseErr.message })
      return res.status(200).json(senseData.card)
    }

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
      // A sense skill's DB row keeps type='meaning' and carries the sense in a separate `sense_type`
      // column (see lib/skillTypes.js) — every request/response here still addresses a skill by the
      // ONE external string (skill_type) callers have always used; dbType/dbSenseType are only ever
      // used for the actual DB query/write below.
      const { type: dbType, sense_type: dbSenseType } = skillDbColumns(card, skill_type)

      // Practice attempt (right/wrong/don't know from PracticePanel): bump level by one step
      // (floor 1, ceiling 10), instead of setting an explicit level like the manual editor does.
      // last_correct only stamps on a correct attempt — it's not "last attempted", it's "last
      // gotten right". hand_set is cleared — an earned level, not a self-assessment (plan.md §5).
      if (isPracticeResult) {
        const { data: existing } = await supabase
          .from('skill')
          .select('level, state, interval_days, consecutive_correct, stable_interval_days')
          .eq('card_id', id)
          .eq('type', dbType)
          .eq('sense_type', dbSenseType)
          .maybeSingle()
        const currentLevel = existing?.level ?? 1
        const newLevel = nextLevelFor(currentLevel, practice_result, existing ?? NEVER_SCHEDULE)

        const row = { card_id: id, type: dbType, sense_type: dbSenseType, level: newLevel, hand_set: false }
        if (practice_result === 'correct') row.last_correct = new Date().toISOString()

        // Practice scheduling (plan.md — "Practice Scheduling" §2): the spaced-repetition side of
        // this same attempt, computed alongside (not instead of) the level bump above.
        const scheduleUpdate = computeSchedule({ current: existing ?? NEVER_SCHEDULE, outcome: practice_result, level: newLevel })
        if (scheduleUpdate) Object.assign(row, scheduleUpdate)

        const { data, error } = await supabase
          .from('skill')
          .upsert(row, { onConflict: 'card_id,type,sense_type' })
          .select('id, type, sense_type, level, importance, hand_set, last_correct, state, interval_days, due_at, consecutive_correct')
          .single()

        if (error) return res.status(500).json({ error: error.message })

        const { error: attemptErr } = await logPracticeAttempt({ skillId: data.id, encounterId: encounter_id, outcome: practice_result, model, conversation })
        if (attemptErr) console.error('[practice_attempt] failed to log attempt', attemptErr)

        const { sense_type: _st, ...responseRow } = data
        return res.status(200).json({ ...responseRow, type: resolveSkillType(data) })
      }

      // Manual editor (CardDetailPanel, Skills page): an explicit `level` here is a
      // self-assessment, not an earned result, so it's marked hand_set — plan.md §5's "hand-set
      // levels must be visually distinct from earned ones". Only touched when `level` is actually
      // part of this PATCH (an importance-only PATCH must not flip hand_set on a level it isn't
      // changing).
      const row = { card_id: id, type: dbType, sense_type: dbSenseType }
      if (level !== undefined) {
        row.level = level
        row.hand_set = level !== null
        // A bare level number, not an outcome — scheduleForManualLevel only reacts to the two
        // edge transitions it forces regardless of history (retiring at level 10, clearing back to
        // "never" at level null); any other hand-set level leaves the ladder untouched (see that
        // function's comment in lib/practiceScheduling.js).
        const { data: existingSchedule } = await supabase
          .from('skill')
          .select('state')
          .eq('card_id', id)
          .eq('type', dbType)
          .eq('sense_type', dbSenseType)
          .maybeSingle()
        const scheduleUpdate = scheduleForManualLevel(existingSchedule ?? NEVER_SCHEDULE, level)
        if (scheduleUpdate) Object.assign(row, scheduleUpdate)
      }
      if (importance !== undefined) row.importance = importance

      const { data, error } = await supabase
        .from('skill')
        .upsert(row, { onConflict: 'card_id,type,sense_type' })
        .select('id, type, sense_type, level, importance, hand_set, last_correct, state, interval_days, due_at, consecutive_correct')
        .single()

      if (error) return res.status(500).json({ error: error.message })
      const { sense_type: _st2, ...responseRow } = data
      return res.status(200).json({ ...responseRow, type: resolveSkillType(data) })
    }

    if (importance === undefined && name === undefined && tags === undefined) return res.status(400).json({ error: 'importance, name, tags, or skill_type required' })
    if (importance !== undefined && (!Number.isInteger(importance) || importance < 0 || importance > 10)) {
      return res.status(400).json({ error: 'importance must be an integer between 0 and 10' })
    }
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      return res.status(400).json({ error: 'name must be a non-empty string' })
    }
    if (tags !== undefined && (!Array.isArray(tags) || tags.some(t => typeof t !== 'string' || !t.trim()))) {
      return res.status(400).json({ error: 'tags must be an array of non-empty strings' })
    }

    const update = {}
    if (importance !== undefined) update.importance = importance
    if (name !== undefined) update.name = name.trim()
    if (tags !== undefined) update.tags = [...new Set(tags.map(t => t.trim()))]

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
        skill(id, type, sense_type, level, importance, hand_set, last_correct, state, interval_days, due_at, consecutive_correct),
        source_knowledge(
          source_id,
          positions,
          skill_id,
          sources(id, original_text, created_at, contexts(id, name))
        )
      `)
      .eq('project_id', project_id)
      .eq('id', id)
      .single()
    if (error) return res.status(500).json({ error: error.message })
    // See lib/skillTypes.js's resolveSkillType() — a sense skill's DB type is always literally
    // 'meaning'; every consumer expects the resolved external type (e.g. "financial") instead.
    if (data?.skill) data.skill = data.skill.map(({ sense_type, ...s }) => ({ ...s, type: sense_type || s.type }))
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
