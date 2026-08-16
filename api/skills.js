import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { selectQuickPracticeSkills } from '../lib/practiceSelection.js'

// Lists `skill` rows project-wide, each with its owning card embedded — skills are the practice
// unit now (see lib/practiceRules.js), so the practice pickers need them as first-class rows
// rather than deriving them from a card client-side:
//   ?card_ids=a,b,c        -> every skill row for those cards, unordered (CardsPanel's "select a
//                              card, practice all its skills")
//   ?sort=recent&limit=N   -> the N most-recently-created skill rows project-wide
//   ?sort=weighted&limit=N -> quick-start: every card in the project is loaded ONCE, each with its
//                              full skill set, then N skills are selected via
//                              lib/practiceSelection.js's two-stage weighted sample (card by
//                              importance, then skill on that card by
//                              lib/practiceSelection.js's SKILL_SELECTION_WEIGHTS) — skills whose
//                              `last_correct` falls in the past EXCLUDE_RECENT_DAYS days are
//                              ineligible to be picked, though still count toward sibling-skill
//                              gating (e.g. "gender" behind "meaning") — see that file
//   ?limit=1&offset=N      -> single row at offset N, for uniform random sampling (random-start),
//                              same pattern api/knowledge-cards.js uses for cards
const EXCLUDE_RECENT_DAYS = 5

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, card_ids, sort, limit = '20', offset = '0' } = req.query
  if (!project_id) return res.status(400).json({ error: 'project_id required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  if (sort === 'weighted') {
    // One round trip for the whole candidate pool — cards with their full skill sets attached —
    // so lib/practiceSelection.js can re-select as many times as it needs (a card with nothing
    // practiceable right now just gets dropped in memory) without going back to the DB.
    const { data, error, count } = await supabase
      .from('knowledge_cards')
      .select('id, name, kind, tags, details, importance, skill(id, type, level, importance, last_correct)', { count: 'exact' })
      .eq('project_id', project_id)
    if (error) return res.status(500).json({ error: error.message })

    const cards = data.map(({ skill, ...card }) => ({ ...card, skills: skill }))
    const cutoff = new Date(Date.now() - EXCLUDE_RECENT_DAYS * 24 * 60 * 60 * 1000)
    const eligible = (s) => !s.last_correct || new Date(s.last_correct) < cutoff

    const picks = selectQuickPracticeSkills(cards, Number(limit), eligible)
    const skills = picks.map(({ card: { skills: _skills, ...card }, skill }) => ({ ...skill, card }))
    return res.status(200).json({ skills, total: count })
  }

  let query = supabase
    .from('skill')
    .select('id, type, level, importance, last_correct, knowledge_cards!inner(id, name, kind, tags, details, project_id)', { count: 'exact' })
    .eq('knowledge_cards.project_id', project_id)

  if (card_ids) {
    const ids = String(card_ids).split(',').map(s => s.trim()).filter(Boolean)
    if (ids.length === 0) return res.status(200).json({ skills: [], total: 0 })
    query = query.in('card_id', ids)
  } else {
    query = query.order('created_at', { ascending: false }).range(Number(offset), Number(offset) + Number(limit) - 1)
  }

  const { data, error, count } = await query
  if (error) return res.status(500).json({ error: error.message })
  const skills = data.map(({ knowledge_cards, ...s }) => ({ ...s, card: knowledge_cards }))
  return res.status(200).json({ skills, total: count })
}
