import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { skillDbColumns } from '../lib/skillTypes.js'
import { resolveLanguagePack } from '../lib/resolveLanguagePack.js'
import { logPracticeNote } from '../lib/practiceNotes.js'

// Logs a practice_note row — a free-text scratch note the user (dev, self-use) can attach to
// whatever practice question is currently on screen. Not part of scheduling/level/skill state at
// all, just a durable place to park an observation for later review.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, card_id, skill_type, question, note } = req.body ?? {}
  if (!project_id) return res.status(400).json({ error: 'project_id required' })
  if (!card_id) return res.status(400).json({ error: 'card_id required' })
  if (typeof skill_type !== 'string' || !skill_type.trim()) return res.status(400).json({ error: 'skill_type required' })
  if (typeof note !== 'string' || !note.trim()) return res.status(400).json({ error: 'note required' })
  if (question === undefined) return res.status(400).json({ error: 'question required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  const { data: card, error: cardErr } = await supabase
    .from('knowledge_cards')
    .select('id, kind, details')
    .eq('project_id', project_id)
    .eq('id', card_id)
    .single()
  if (cardErr || !card) return res.status(404).json({ error: 'Card not found' })
  const pack = await resolveLanguagePack(project_id)
  if (!pack.validateSkillType(card, skill_type)) {
    return res.status(400).json({ error: `"${skill_type}" is not a valid skill type for this card` })
  }

  const { type: dbType, sense_type: dbSenseType } = skillDbColumns(card, skill_type)
  const { data: skillRow, error: skillErr } = await supabase
    .from('skill')
    .select('id')
    .eq('card_id', card_id)
    .eq('type', dbType)
    .eq('sense_type', dbSenseType)
    .maybeSingle()
  if (skillErr) return res.status(500).json({ error: skillErr.message })
  if (!skillRow) return res.status(404).json({ error: 'Skill not found' })

  const { error } = await logPracticeNote({ skillId: skillRow.id, question, note: note.trim() })
  if (error) return res.status(500).json({ error: error.message })
  return res.status(204).end()
}
