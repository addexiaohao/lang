import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

// POST { project_id, card_ids: uuid[] (>= 2) } -> merged knowledge_card row. Merges the given
// cards — true duplicates of each other — into one surviving card via schema.sql's merge_cards
// RPC, which picks the oldest card as the survivor, unions tags, carries over source_knowledge
// links, and collapses skills by type (highest level wins). See merge_cards' own comment for the
// exact rules. Used by CardsPanel.jsx's "Merge" button over its existing skill-selection Map.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, card_ids } = req.body ?? {}
  if (!project_id) return res.status(400).json({ error: 'project_id required' })
  if (!Array.isArray(card_ids) || card_ids.length < 2) {
    return res.status(400).json({ error: 'card_ids must be an array of at least 2 ids' })
  }

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  const { data, error } = await supabase.rpc('merge_cards', { p_project_id: project_id, p_card_ids: card_ids })
  if (error) return res.status(400).json({ error: error.message })
  return res.status(200).json(data)
}
