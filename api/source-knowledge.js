import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

// positions must be a non-empty array of {start, end} integer ranges within [0, textLength],
// start < end — same shape lib/resolvePositions.js produces at creation time.
function validatePositions(positions, textLength) {
  if (!Array.isArray(positions) || positions.length === 0) return false
  return positions.every(p =>
    p && Number.isInteger(p.start) && Number.isInteger(p.end) &&
    p.start >= 0 && p.end <= textLength && p.start < p.end
  )
}

// PATCH ?project_id=&source_id=&knowledge_card_id= { positions } -> updates a source_knowledge
// link's positions in place — the same [{start,end}] absolute-offset shape produced at creation
// time by lib/resolvePositions.js, but here supplied directly (no annotated_sentence/marker
// round-trip needed, since the editor works straight off the source's already-known
// original_text). Used by SourceDetailPanel.jsx's per-card "Edit span" control.
export default async function handler(req, res) {
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, source_id, knowledge_card_id } = req.query
  if (!project_id) return res.status(400).json({ error: 'project_id required' })
  if (!source_id || !knowledge_card_id) return res.status(400).json({ error: 'source_id and knowledge_card_id required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  const { positions } = req.body ?? {}

  const { data: source, error: srcErr } = await supabase
    .from('sources')
    .select('id, original_text')
    .eq('id', source_id)
    .eq('project_id', project_id)
    .single()
  if (srcErr || !source) return res.status(404).json({ error: 'Source not found' })

  if (!validatePositions(positions, source.original_text.length)) {
    return res.status(400).json({ error: 'positions must be a non-empty array of {start, end} ranges within the source text' })
  }

  const { data, error } = await supabase
    .from('source_knowledge')
    .update({ positions })
    .eq('source_id', source_id)
    .eq('knowledge_card_id', knowledge_card_id)
    .select('source_id, knowledge_card_id, positions')
    .maybeSingle()

  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Link not found' })
  return res.status(200).json(data)
}
