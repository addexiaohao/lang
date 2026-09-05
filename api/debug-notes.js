import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { resolveSkillType } from '../lib/skillTypes.js'

// GET ?project_id=&limit=&offset= -> practice_note rows (see api/practice-note.js) with enough
// context to read them without cross-referencing anything else: the card name/kind, the resolved
// external skill_type, the raw generated question the note was taken against, and the note text
// itself. Backs the Debug mode's "Notes" panel.
//
// practice_note carries no project_id of its own (only skill_id) — ownership goes through
// skill -> knowledge_cards, same reasoning as api/skills.js's history_for: a separate step rather
// than a double-nested embedded filter.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, limit = '50', offset = '0' } = req.query
  if (!project_id) return res.status(400).json({ error: 'project_id required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  const lim = Math.min(Number(limit) || 50, 200)
  const off = Number(offset) || 0

  const { data: skillRows, error: skillErr } = await supabase
    .from('skill')
    .select('id, type, sense_type, knowledge_cards!inner(id, name, kind, project_id)')
    .eq('knowledge_cards.project_id', project_id)
  if (skillErr) return res.status(500).json({ error: skillErr.message })

  const skillById = new Map(skillRows.map(({ knowledge_cards, ...s }) => [s.id, { ...s, card: knowledge_cards }]))
  const skillIds = [...skillById.keys()]
  if (skillIds.length === 0) return res.status(200).json({ notes: [], total: 0 })

  const { data, error, count } = await supabase
    .from('practice_note')
    .select('id, skill_id, question, note, created_at', { count: 'exact' })
    .in('skill_id', skillIds)
    .order('created_at', { ascending: false })
    .range(off, off + lim - 1)
  if (error) return res.status(500).json({ error: error.message })

  const notes = (data ?? []).map(n => {
    const skill = skillById.get(n.skill_id)
    return {
      id: n.id,
      question: n.question,
      note: n.note,
      created_at: n.created_at,
      skill_type: skill ? resolveSkillType(skill) : null,
      card: skill ? { id: skill.card.id, name: skill.card.name, kind: skill.card.kind } : null,
    }
  })
  return res.status(200).json({ notes, total: count ?? notes.length })
}
