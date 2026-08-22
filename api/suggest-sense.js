import Anthropic from '@anthropic-ai/sdk'
import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { suggestSense } from '../lib/senseCheck.js'
import { languageName } from '../lib/prompts/fragments.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Backs AddSenseForm.jsx's auto-pre-filled "name this card's sense" fields (see "Word senses" in
// CLAUDE.md) — POST { project_id, card_id } -> { key, gloss }, grounded in the card's own name/tags
// and up to 3 of its already-linked source sentences (the real evidence of how the word's been
// used), not invented from nothing.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, card_id } = req.body ?? {}
  if (!project_id) return res.status(400).json({ error: 'project_id required' })
  if (!card_id) return res.status(400).json({ error: 'card_id required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  const [{ data: card, error: cardErr }, { data: project }] = await Promise.all([
    supabase.from('knowledge_cards').select('id, name, kind, tags').eq('project_id', project_id).eq('id', card_id).single(),
    supabase.from('projects').select('tts_locale').eq('id', project_id).single(),
  ])
  if (cardErr || !card) return res.status(404).json({ error: 'Card not found' })
  if (card.kind !== 'vocabulary') return res.status(400).json({ error: 'Only vocabulary cards have senses' })

  const { data: links } = await supabase
    .from('source_knowledge')
    .select('sources(original_text)')
    .eq('knowledge_card_id', card_id)
    .limit(3)
  const excerpts = (links ?? []).map(l => l.sources?.original_text).filter(Boolean)

  try {
    const suggestion = await suggestSense({ anthropic, card, excerpts, languageName: languageName(project?.tts_locale) })
    return res.status(200).json(suggestion)
  } catch (e) {
    return res.status(502).json({ error: e.message })
  }
}
