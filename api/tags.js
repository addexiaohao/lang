import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

export default async function handler(req, res) {
  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  if (req.method === 'GET') {
    const { project_id } = req.query
    try {
      await requireProjectAccess(user.id, project_id)
    } catch (e) {
      if (e instanceof AuthError) return res.status(403).json({ error: e.message })
      throw e
    }

    const [{ data, error }, { data: cards, error: cardsError }] = await Promise.all([
      supabase
        .from('tags')
        .select('id, name, display_name, description')
        .eq('project_id', project_id)
        .order('name', { ascending: true }),
      supabase
        .from('knowledge_cards')
        .select('tags')
        .eq('project_id', project_id),
    ])

    if (error) return res.status(500).json({ error: error.message })
    if (cardsError) return res.status(500).json({ error: cardsError.message })

    const counts = {}
    for (const card of cards) {
      for (const tag of card.tags ?? []) {
        counts[tag] = (counts[tag] ?? 0) + 1
      }
    }

    return res.status(200).json(data.map(t => ({ ...t, card_count: counts[t.name] ?? 0 })))
  }

  if (req.method === 'POST') {
    const { project_id, name, display_name, description } = req.body ?? {}
    if (!name) return res.status(400).json({ error: 'name is required' })

    try {
      await requireProjectAccess(user.id, project_id)
    } catch (e) {
      if (e instanceof AuthError) return res.status(403).json({ error: e.message })
      throw e
    }

    const { data, error } = await supabase
      .from('tags')
      .insert({ project_id, name, display_name: display_name || null, description: description || null })
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  }

  if (req.method === 'PATCH') {
    const { id } = req.query
    const { name, display_name, description } = req.body ?? {}
    if (!id) return res.status(400).json({ error: 'id is required' })
    if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'name cannot be empty' })

    const { data: existing, error: fetchError } = await supabase
      .from('tags')
      .select('id, project_id, name')
      .eq('id', id)
      .single()

    if (fetchError) return res.status(404).json({ error: 'Tag not found' })

    try {
      await requireProjectAccess(user.id, existing.project_id)
    } catch (e) {
      if (e instanceof AuthError) return res.status(403).json({ error: e.message })
      throw e
    }

    const updates = {}
    if (name !== undefined) updates.name = name.trim()
    if (display_name !== undefined) updates.display_name = display_name.trim() || null
    if (description !== undefined) updates.description = description.trim() || null

    const { data, error } = await supabase
      .from('tags')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A tag with that name already exists' })
      return res.status(500).json({ error: error.message })
    }

    // knowledge_cards.tags is denormalized (stores the tag's `name` directly) — keep it in sync on rename
    if (updates.name && updates.name !== existing.name) {
      const { data: affectedCards, error: cardsError } = await supabase
        .from('knowledge_cards')
        .select('id, tags')
        .eq('project_id', existing.project_id)
        .contains('tags', [existing.name])

      if (cardsError) return res.status(500).json({ error: cardsError.message })

      for (const card of affectedCards) {
        const newTags = card.tags.map(t => (t === existing.name ? updates.name : t))
        const { error: updateCardError } = await supabase
          .from('knowledge_cards')
          .update({ tags: newTags })
          .eq('id', card.id)
        if (updateCardError) return res.status(500).json({ error: updateCardError.message })
      }
    }

    return res.status(200).json(data)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
