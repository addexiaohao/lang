import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

// PATCH { project_id, source_id, knowledge_card_id, skill_id } — updates which skill a source link
// demonstrates (source_knowledge.skill_id, see "Word senses" in CLAUDE.md). Identified by
// (source_id, knowledge_card_id), the link's actual composite primary key — source_knowledge has no
// surrogate id column. `skill_id` may be null (unset). Used by CardDetailPanel's per-source sense
// picker, so a user can correct or fill in which sense a given encounter belongs to after the fact,
// not just at save time.
export default async function handler(req, res) {
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, source_id, knowledge_card_id, skill_id } = req.body ?? {}
  if (!project_id) return res.status(400).json({ error: 'project_id required' })
  if (!source_id || !knowledge_card_id) return res.status(400).json({ error: 'source_id and knowledge_card_id required' })
  if (skill_id !== null && typeof skill_id !== 'string') return res.status(400).json({ error: 'skill_id must be a string or null' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  const { data: card } = await supabase.from('knowledge_cards').select('id').eq('id', knowledge_card_id).eq('project_id', project_id).maybeSingle()
  if (!card) return res.status(404).json({ error: 'Card not found' })

  if (skill_id) {
    const { data: skill } = await supabase.from('skill').select('id').eq('id', skill_id).eq('card_id', knowledge_card_id).maybeSingle()
    if (!skill) return res.status(400).json({ error: 'skill_id does not belong to this card' })
  }

  const { data, error } = await supabase
    .from('source_knowledge')
    .update({ skill_id })
    .eq('source_id', source_id)
    .eq('knowledge_card_id', knowledge_card_id)
    .select('source_id, knowledge_card_id, skill_id')
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Source link not found' })
  return res.status(200).json(data)
}
