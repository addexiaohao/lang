import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

// GET ?project_id=&limit=&offset= -> mc_cloze_check_failure rows (see lib/mcClozeCheckLog.js) with
// the card name/kind attached, newest first. Backs the Debug mode's "MC-cloze failures" panel —
// each row is a generated item whose answer-uniqueness check failed, including the full generation
// `conversation` so a failure can be traced back to the exact prompt that produced it.
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

  const { data, error, count } = await supabase
    .from('mc_cloze_check_failure')
    .select(
      'id, skill_type, model, sentence, options, answer, offending_sentences, reasons, conversation, created_at, knowledge_cards!inner(id, name, kind, project_id)',
      { count: 'exact' }
    )
    .eq('knowledge_cards.project_id', project_id)
    .order('created_at', { ascending: false })
    .range(off, off + lim - 1)
  if (error) return res.status(500).json({ error: error.message })

  const failures = (data ?? []).map(({ knowledge_cards, ...f }) => ({
    ...f,
    card: knowledge_cards ? { id: knowledge_cards.id, name: knowledge_cards.name, kind: knowledge_cards.kind } : null,
  }))
  return res.status(200).json({ failures, total: count ?? failures.length })
}
