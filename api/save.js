import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

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
    const { source_id, knowledge_card_id } = record
    if (!source_id || !knowledge_card_id) {
      return res.status(400).json({ error: 'source_id and knowledge_card_id are required' })
    }
    const { data, error } = await supabase
      .from('source_knowledge')
      .insert({ source_id, knowledge_card_id })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  }

  if (table === 'knowledge_card') {
    const { source_id, related_card_ids, ref, source_ref, existing_id, new_tags, ...cardFields } = record
    if (!source_id) {
      return res.status(400).json({ error: 'source_id is required to save a knowledge card' })
    }
    const card = { ...cardFields, project_id }
    const link = { source_id }
    const { data, error } = await supabase.rpc('save_card_and_link', { card, link })
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: `A card named "${card.name}" already exists in this project` })
      return res.status(500).json({ error: error.message })
    }
    return res.status(201).json(data)
  }

  return res.status(400).json({ error: `Unknown table: ${table}` })
}
