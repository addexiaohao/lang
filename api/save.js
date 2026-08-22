import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { resolvePositions } from '../lib/resolvePositions.js'
import { deriveFlatSkillTypes, deriveSkillImportance, hasSenseAxis } from '../lib/skillTypes.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, table, record } = req.body

  if (!table || !record) {
    return res.status(400).json({ error: 'table and record required' })
  }

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  if (table === 'source') {
    const { context_id, ...rest } = record
    const row = { ...rest, project_id, user_id: user.id }
    if (context_id) row.context_id = context_id
    const { data, error } = await supabase
      .from('sources')
      .insert(row)
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  }

  if (table === 'source_knowledge') {
    const { source_id, knowledge_card_id, annotated_sentence, note, new_sense, existing_sense, sense_key } = record
    if (!source_id || !knowledge_card_id) {
      return res.status(400).json({ error: 'source_id and knowledge_card_id are required' })
    }
    if (!annotated_sentence) {
      return res.status(400).json({ error: 'annotated_sentence is required' })
    }
    const { data: card } = await supabase
      .from('knowledge_cards')
      .select('id, kind, details, importance')
      .eq('id', knowledge_card_id)
      .eq('project_id', project_id)
      .maybeSingle()
    if (!card) return res.status(404).json({ error: 'Knowledge card not found' })

    const positions = await resolveLink(source_id, project_id, annotated_sentence, res)
    if (!positions) return

    // Word-senses save flow (plan.md — "Word Senses" §3): `new_sense` splits/extends the card's
    // sense axis before the link is recorded, so `skillId` below always points at a skill that
    // already exists by the time the link is written. `existing_sense` is only present (and
    // required) the first time a monosemous card is split — see lib/prompts/registry.js's "Word
    // senses" section. `source_knowledge.skill_id` is a general "which skill did this encounter
    // demonstrate" reference (not sense-specific), so this is the one place it's populated today.
    let skillId = null
    if (new_sense?.key) {
      // A sense skill's DB type stays 'meaning' (see lib/skillTypes.js) — its importance is derived
      // under that same key, not the sense key itself, so it inherits whatever formula 'meaning'
      // ends up tuned to rather than silently falling back to a bare cardImportance copy forever.
      const importance = deriveSkillImportance(card.kind, 'meaning', card.importance)
      let senseErr, senseData
      if (hasSenseAxis(card)) {
        ;({ data: senseData, error: senseErr } = await supabase.rpc('append_sense_value', {
          p_card_id: card.id, p_key: new_sense.key, p_gloss: new_sense.gloss ?? null, p_example: new_sense.example ?? null, p_importance: importance,
        }))
      } else if (!existing_sense?.key || !existing_sense?.gloss) {
        return res.status(400).json({ error: 'existing_sense.key and existing_sense.gloss are required to split a card that has no sense axis yet' })
      } else {
        ;({ data: senseData, error: senseErr } = await supabase.rpc('migrate_card_to_senses', {
          p_card_id: card.id,
          p_existing_key: existing_sense.key, p_existing_gloss: existing_sense.gloss, p_existing_example: existing_sense.example ?? null,
          p_new_key: new_sense.key, p_new_gloss: new_sense.gloss ?? null, p_new_example: new_sense.example ?? null,
          p_new_importance: importance,
        }))
      }
      if (senseErr) return res.status(500).json({ error: senseErr.message })
      skillId = senseData?.skill_id ?? null
    } else if (sense_key) {
      const { data: existingSkill } = await supabase
        .from('skill')
        .select('id')
        .eq('card_id', card.id)
        .eq('type', 'meaning')
        .eq('sense_type', sense_key)
        .maybeSingle()
      skillId = existingSkill?.id ?? null
    }

    const { data, error } = await supabase
      .from('source_knowledge')
      .insert({ source_id, knowledge_card_id, positions, note, skill_id: skillId })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  }

  if (table === 'knowledge_card') {
    const { source_id, related_card_ids, ref, source_ref, existing_id, new_tags, user_id: _uid,
            annotated_sentence, ...cardFields } = record
    if (!source_id) {
      return res.status(400).json({ error: 'source_id is required to save a knowledge card' })
    }
    if (!annotated_sentence) {
      return res.status(400).json({ error: 'annotated_sentence is required' })
    }

    const positions = await resolveLink(source_id, project_id, annotated_sentence, res)
    if (!positions) return

    const card = { ...cardFields, project_id }
    const link = { source_id, positions }
    const axes = card.details?.axes
    const skill_types = Array.isArray(axes) && axes.length > 0 ? [] : deriveFlatSkillTypes(card)
    const skills = skill_types.map(type => ({
      type,
      importance: deriveSkillImportance(card.kind, type, card.importance),
    }))
    const { data, error } = await supabase.rpc('save_card_and_link', { card, link, skills })
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: `A card named "${card.name}" already exists in this project` })
      return res.status(500).json({ error: error.message })
    }
    return res.status(201).json(data)
  }

  return res.status(400).json({ error: `Unknown table: ${table}` })
}

// Fetches original_text for source_id (scoped to project_id), resolves annotated_sentence to
// positions. Returns positions array on success, or sends a 404/422 response and returns null.
async function resolveLink(source_id, project_id, annotated_sentence, res) {
  const { data: source, error: srcErr } = await supabase
    .from('sources')
    .select('original_text')
    .eq('id', source_id)
    .eq('project_id', project_id)
    .single()

  if (srcErr || !source) {
    res.status(404).json({ error: 'Source not found' })
    return null
  }

  try {
    return resolvePositions(annotated_sentence, source.original_text)
  } catch (e) {
    res.status(422).json({ error: `Position resolution failed: ${e.message}` })
    return null
  }
}
