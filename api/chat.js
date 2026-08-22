import Anthropic from '@anthropic-ai/sdk'
import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { getProjectConfig } from '../lib/projectConfig.js'
import { findDuplicateSource } from '../lib/normalizeSourceText.js'
import { compose } from '../lib/prompts/registry.js'
import { runChatLoop } from '../lib/chatLoop.js'
import { isSenseExempt, hasSenseAxis, senseValues, axisValueKey, axisValueGloss, axisValueExample } from '../lib/skillTypes.js'
import { getSenseVerdict } from '../lib/senseCheck.js'
import { languageName } from '../lib/prompts/fragments.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, messages } = req.body

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' })
  }

  const [{ data: project }, { data: tagsData }] = await Promise.all([
    supabase.from('projects').select('system_prompt, config, tts_locale, context_required').eq('id', project_id).single(),
    supabase.from('tags').select('name').eq('project_id', project_id).order('name'),
  ])
  const tags = tagsData ?? []

  const projectConfig = getProjectConfig(project ?? {})
  if (projectConfig.contextsRequired === null) {
    return res.status(500).json({ error: 'Project is missing context_required — set it before using chat.' })
  }

  const systemPrompt = compose('chat.distill', { config: projectConfig, userPrompt: project?.system_prompt, tags })

  async function executeSearchSources(originalText) {
    const { data, error } = await supabase
      .from('sources')
      .select('id, original_text')
      .eq('project_id', project_id)
    if (error) return []
    const match = findDuplicateSource(data ?? [], originalText)
    return match ? [match] : []
  }

  // For a vocabulary match, when the model gave us an excerpt (see lib/chatLoop.js's tool
  // description), runs/consults the sense checker (lib/senseCheck.js, plan.md — "Word Senses") and
  // attaches the card's existing sense(s) so the model can compare this encounter against them —
  // this is the ONE place the check runs, so it can't be skipped or duplicated by the calling model.
  // Exempt classes (prepositions, particles, etc. — lib/skillTypes.js's isSenseExempt) and cards
  // that already have a non-sense axis (declension paradigms — sense-splitting doesn't apply) never
  // hit the checker at all.
  async function attachSenseInfo(card, excerpt) {
    if (card.kind !== 'vocabulary' || !excerpt || isSenseExempt(card)) return card
    const axes = card.details?.axes
    if (Array.isArray(axes) && axes.length > 0 && !hasSenseAxis(card)) return card // non-sense paradigm card

    const senses = hasSenseAxis(card)
      ? senseValues(card).map(v => ({ key: axisValueKey(v), gloss: axisValueGloss(v), example: axisValueExample(v) }))
      : null // monosemous so far — no senses on file yet, but still eligible to become one

    const { verdict, reasoning } = await getSenseVerdict({
      anthropic, projectId: project_id, lemma: card.name, excerpt, languageName: languageName(projectConfig.ttsLocale),
    })
    return { ...card, senses, sense_check: { verdict, reasoning } }
  }

  async function executeSearchKnowledgeCards(query, excerpt) {
    const { data, error } = await supabase
      .from('knowledge_cards')
      .select('id, name, kind, tags, importance, details')
      .ilike('name', `%${query}%`)
      .eq('project_id', project_id)
      .limit(5)
    if (error || !data) return []
    return Promise.all(data.map(card => attachSenseInfo(card, excerpt)))
  }

  async function executeTool(name, input) {
    if (name === 'search_sources') return executeSearchSources(input.original_text)
    if (name === 'search_knowledge_cards') return executeSearchKnowledgeCards(input.query, input.excerpt)
    return []
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Transfer-Encoding', 'chunked')
  res.setHeader('Cache-Control', 'no-cache')
  // Suppress Vercel's default response buffering
  res.setHeader('X-Accel-Buffering', 'no')

  await runChatLoop({
    anthropic,
    systemPrompt,
    messages,
    executeTool,
    onText: text => res.write(text),
  })

  res.end()
}
