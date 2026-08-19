import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { validateSkillType } from '../lib/skillTypes.js'
import { logPracticeAttempt } from '../lib/practiceAttempts.js'

// Logs a practice_attempt row that does NOT touch skill.level/last_correct — currently only the
// "Easier sentence" button's outcome ('too_hard': the learner bailed on this round for being too
// hard, not a right/wrong/don't-know answer). A right/wrong/don't-know attempt still goes through
// PATCH /api/knowledge-cards (practice_result), which bumps level in the same request as logging.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, card_id, skill_type, encounter_id, outcome, model, conversation } = req.body ?? {}
  if (!project_id) return res.status(400).json({ error: 'project_id required' })
  if (!card_id) return res.status(400).json({ error: 'card_id required' })
  if (typeof skill_type !== 'string' || !skill_type.trim()) return res.status(400).json({ error: 'skill_type required' })
  if (outcome !== 'too_hard') return res.status(400).json({ error: 'outcome must be "too_hard"' })
  if (!encounter_id) return res.status(400).json({ error: 'encounter_id required' })

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
  if (!validateSkillType(card, skill_type)) {
    return res.status(400).json({ error: `"${skill_type}" is not a valid skill type for this card` })
  }

  const { data: skillRow, error: skillErr } = await supabase
    .from('skill')
    .select('id')
    .eq('card_id', card_id)
    .eq('type', skill_type)
    .maybeSingle()
  if (skillErr) return res.status(500).json({ error: skillErr.message })
  if (!skillRow) return res.status(404).json({ error: 'Skill not found' })

  const { error } = await logPracticeAttempt({ skillId: skillRow.id, encounterId: encounter_id, outcome, model, conversation })
  if (error) return res.status(500).json({ error: error.message })
  return res.status(204).end()
}
