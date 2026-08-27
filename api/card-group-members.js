import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

const GROUP_SELECT = 'id, project_id, name, note, created_at, card_group_member(card_id, note, knowledge_cards(id, name, kind))'

function shapeGroup(row) {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    created_at: row.created_at,
    members: (row.card_group_member ?? [])
      .filter(m => m.knowledge_cards)
      .map(m => ({ card_id: m.card_id, note: m.note, name: m.knowledge_cards.name, kind: m.knowledge_cards.kind })),
  }
}

// Membership edits on an EXISTING group — adding one member (CardDetailPanel's "Relate this card…"
// when the source card already has exactly one group, or the group tab's own "add member" search
// bar), editing one member's note, or removing one. Creating a brand-new group (with its initial
// members) is /api/card-groups.js's POST instead — see plan.md §2's resolution rules.
export default async function handler(req, res) {
  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const project_id = req.method === 'DELETE' ? req.query.project_id : req.body?.project_id
  const group_id = req.method === 'DELETE' ? req.query.group_id : req.body?.group_id
  const card_id = req.method === 'DELETE' ? req.query.card_id : req.body?.card_id
  if (!project_id) return res.status(400).json({ error: 'project_id required' })
  if (!group_id) return res.status(400).json({ error: 'group_id required' })
  if (!card_id) return res.status(400).json({ error: 'card_id required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  const { data: group, error: groupErr } = await supabase.from('card_group').select('id, project_id').eq('id', group_id).maybeSingle()
  if (groupErr) return res.status(500).json({ error: groupErr.message })
  if (!group || group.project_id !== project_id) return res.status(404).json({ error: 'Group not found' })

  if (req.method === 'POST') {
    // Groups don't span projects (plan.md §5) — same check as /api/card-groups.js's create path.
    const { data: ownedCard, error: ownedErr } = await supabase
      .from('knowledge_cards')
      .select('id')
      .eq('id', card_id)
      .eq('project_id', project_id)
      .maybeSingle()
    if (ownedErr) return res.status(500).json({ error: ownedErr.message })
    if (!ownedCard) return res.status(400).json({ error: 'Card does not belong to this project' })

    const { note } = req.body ?? {}
    const { error } = await supabase.from('card_group_member').insert({ group_id, card_id, note: note?.trim() || null })
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'This card is already in that group' })
      return res.status(400).json({ error: error.message })
    }
  } else if (req.method === 'PATCH') {
    const { note } = req.body ?? {}
    if (note === undefined) return res.status(400).json({ error: 'note required' })
    const { error, count } = await supabase
      .from('card_group_member')
      .update({ note: note?.trim() || null }, { count: 'exact' })
      .eq('group_id', group_id)
      .eq('card_id', card_id)
    if (error) return res.status(500).json({ error: error.message })
    if (!count) return res.status(404).json({ error: 'Membership not found' })
  } else if (req.method === 'DELETE') {
    const { error } = await supabase.from('card_group_member').delete().eq('group_id', group_id).eq('card_id', card_id)
    if (error) return res.status(500).json({ error: error.message })
  } else {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { data, error } = await supabase.from('card_group').select(GROUP_SELECT).eq('id', group_id).maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  // The group itself may be gone if this DELETE removed its last membership row and something else
  // (a concurrent request) already deleted the empty group — not expected in normal use, but handled
  // rather than crashing on a null `data`.
  return res.status(200).json(data ? shapeGroup(data) : null)
}
