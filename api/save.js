import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { resolvePositions } from '../lib/resolvePositions.js'
import { deriveFlatSkillTypes, deriveSkillImportance } from '../lib/skillTypes.js'

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
    const { source_id, knowledge_card_id, annotated_sentence, note } = record
    if (!source_id || !knowledge_card_id) {
      return res.status(400).json({ error: 'source_id and knowledge_card_id are required' })
    }
    if (!annotated_sentence) {
      return res.status(400).json({ error: 'annotated_sentence is required' })
    }
    if (!(await belongsToProject('knowledge_cards', knowledge_card_id, project_id))) {
      return res.status(404).json({ error: 'Knowledge card not found' })
    }

    const positions = await resolveLink(source_id, project_id, annotated_sentence, res)
    if (!positions) return

    const { data, error } = await supabase
      .from('source_knowledge')
      .insert({ source_id, knowledge_card_id, positions, note })
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

// Checks that a row with the given id exists in `tableName` scoped to project_id.
async function belongsToProject(tableName, id, project_id) {
  const { data, error } = await supabase
    .from(tableName)
    .select('id')
    .eq('id', id)
    .eq('project_id', project_id)
    .single()
  return !error && !!data
}
