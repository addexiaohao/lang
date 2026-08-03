import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { resolvePositions } from '../lib/resolvePositions.js'

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

    const positions = await resolveLink(source_id, annotated_sentence, res)
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

    const positions = await resolveLink(source_id, annotated_sentence, res)
    if (!positions) return

    const card = { ...cardFields, project_id }
    const link = { source_id, positions }
    const { data, error } = await supabase.rpc('save_card_and_link', { card, link })
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: `A card named "${card.name}" already exists in this project` })
      return res.status(500).json({ error: error.message })
    }
    return res.status(201).json(data)
  }

  if (table === 'table') {
    const { ref: _ref, existing_id: _eid, ...tableFields } = record
    const row = { ...tableFields, project_id }
    const { data, error } = await supabase
      .from('tables')
      .insert(row)
      .select()
      .single()
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: `A table named "${row.name}" already exists in this project` })
      return res.status(500).json({ error: error.message })
    }
    return res.status(201).json(data)
  }

  if (table === 'table_cell') {
    const { table_id, axis_values, skill } = record
    if (!table_id) return res.status(400).json({ error: 'table_id is required' })
    if (!axis_values || typeof axis_values !== 'object') return res.status(400).json({ error: 'axis_values is required' })
    const cell_key = deriveCellKey(axis_values)
    const row = { table_id, cell_key, axis_values, ...(skill != null ? { skill } : {}) }
    const { data, error } = await supabase
      .from('table_cells')
      .upsert(row, { onConflict: 'table_id,cell_key' })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  }

  if (table === 'link_table_cell') {
    const { source_id, table_cell_id, excerpt, note } = record
    if (!source_id || !table_cell_id) return res.status(400).json({ error: 'source_id and table_cell_id are required' })
    const { data, error } = await supabase
      .from('source_table_cells')
      .insert({ source_id, table_cell_id, excerpt: excerpt || null, note: note || null })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  }

  return res.status(400).json({ error: `Unknown table: ${table}` })
}

// Derives the canonical cell key from an axis_values object.
// Axis names are sorted alphabetically; values are lowercased and slugified.
function deriveCellKey(axisValues) {
  return Object.keys(axisValues)
    .sort()
    .map(k => String(axisValues[k]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .join('-')
}

// Fetches original_text for source_id, resolves annotated_sentence to positions.
// Returns positions array on success, or sends a 422 response and returns null.
async function resolveLink(source_id, annotated_sentence, res) {
  const { data: source, error: srcErr } = await supabase
    .from('sources')
    .select('original_text')
    .eq('id', source_id)
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
