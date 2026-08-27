import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

// A "group" (plan.md — "Card Groups"): a set of cards that only make sense against each other
// (wissen/kennen, legen/stellen/setzen). Members are fetched inline on every group row — group
// counts are small (personal-scale app), so there's no separate paginated members endpoint, same
// spirit as /api/tags's card_count.
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

export default async function handler(req, res) {
  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  if (req.method === 'GET') {
    const { project_id, card_id } = req.query
    if (!project_id) return res.status(400).json({ error: 'project_id required' })
    try {
      await requireProjectAccess(user.id, project_id)
    } catch (e) {
      if (e instanceof AuthError) return res.status(403).json({ error: e.message })
      throw e
    }

    if (card_id) {
      // Groups containing this specific card (CardDetailPanel's "Groups" section, and the
      // "Relate this card…" resolution logic — plan.md §2) — filter membership first, then hydrate
      // each matched group with ALL its members (including the queried card itself, so the caller
      // can render "other members" by filtering it out).
      const { data: memberships, error: memErr } = await supabase
        .from('card_group_member')
        .select('group_id, card_group!inner(id, project_id)')
        .eq('card_id', card_id)
        .eq('card_group.project_id', project_id)
      if (memErr) return res.status(500).json({ error: memErr.message })
      const groupIds = memberships.map(m => m.group_id)
      if (groupIds.length === 0) return res.status(200).json({ groups: [] })
      const { data, error } = await supabase.from('card_group').select(GROUP_SELECT).in('id', groupIds)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ groups: data.map(shapeGroup) })
    }

    const { data, error } = await supabase
      .from('card_group')
      .select(GROUP_SELECT)
      .eq('project_id', project_id)
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ groups: data.map(shapeGroup) })
  }

  if (req.method === 'POST') {
    const { project_id, name, note, member_card_ids } = req.body ?? {}
    if (!project_id) return res.status(400).json({ error: 'project_id required' })
    if (!Array.isArray(member_card_ids) || member_card_ids.length === 0) {
      return res.status(400).json({ error: 'member_card_ids must be a non-empty array' })
    }
    try {
      await requireProjectAccess(user.id, project_id)
    } catch (e) {
      if (e instanceof AuthError) return res.status(403).json({ error: e.message })
      throw e
    }

    // Groups don't span projects (plan.md §5, explicitly out of scope) — verify every member
    // actually belongs to this project before creating anything, rather than trusting the client.
    const uniqueIds = [...new Set(member_card_ids)]
    const { data: ownedCards, error: ownedErr } = await supabase
      .from('knowledge_cards')
      .select('id')
      .eq('project_id', project_id)
      .in('id', uniqueIds)
    if (ownedErr) return res.status(500).json({ error: ownedErr.message })
    if (ownedCards.length !== uniqueIds.length) {
      return res.status(400).json({ error: 'One or more cards do not belong to this project' })
    }

    const { data: group, error: groupErr } = await supabase
      .from('card_group')
      .insert({ project_id, name: name?.trim() || null, note: note?.trim() || null })
      .select('id')
      .single()
    if (groupErr) return res.status(500).json({ error: groupErr.message })

    const { error: memberErr } = await supabase
      .from('card_group_member')
      .insert(uniqueIds.map(card_id => ({ group_id: group.id, card_id })))
    if (memberErr) {
      // Best-effort cleanup — leave no orphaned empty group behind a failed member insert (e.g. a
      // bad card_id foreign key).
      await supabase.from('card_group').delete().eq('id', group.id)
      return res.status(400).json({ error: memberErr.message })
    }

    const { data, error } = await supabase.from('card_group').select(GROUP_SELECT).eq('id', group.id).single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(shapeGroup(data))
  }

  if (req.method === 'PATCH' || req.method === 'DELETE') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id required' })

    const { data: existing, error: fetchErr } = await supabase.from('card_group').select('id, project_id').eq('id', id).maybeSingle()
    if (fetchErr) return res.status(500).json({ error: fetchErr.message })
    if (!existing) return res.status(404).json({ error: 'Group not found' })
    try {
      await requireProjectAccess(user.id, existing.project_id)
    } catch (e) {
      if (e instanceof AuthError) return res.status(403).json({ error: e.message })
      throw e
    }

    if (req.method === 'DELETE') {
      const { error } = await supabase.from('card_group').delete().eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(204).end()
    }

    const { name, note } = req.body ?? {}
    if (name === undefined && note === undefined) return res.status(400).json({ error: 'name or note required' })
    const update = {}
    if (name !== undefined) update.name = name?.trim() || null
    if (note !== undefined) update.note = note?.trim() || null

    const { error } = await supabase.from('card_group').update(update).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    const { data, error: refetchErr } = await supabase.from('card_group').select(GROUP_SELECT).eq('id', id).single()
    if (refetchErr) return res.status(500).json({ error: refetchErr.message })
    return res.status(200).json(shapeGroup(data))
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
