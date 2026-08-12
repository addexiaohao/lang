import Anthropic from '@anthropic-ai/sdk'
import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { generatePracticeItem, PracticeGenerationFailedError, DEFAULT_PRACTICE_MODEL } from '../lib/practiceGenerate.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = process.env.PRACTICE_MODEL || DEFAULT_PRACTICE_MODEL

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, card_id, mode, avoid } = req.body ?? {}
  if (!project_id) return res.status(400).json({ error: 'project_id required' })
  if (!card_id) return res.status(400).json({ error: 'card_id required' })
  if (mode !== 'mc_cloze' && mode !== 'exemplar') {
    return res.status(400).json({ error: 'mode must be "mc_cloze" or "exemplar"' })
  }
  const avoidList = Array.isArray(avoid) ? avoid.filter(a => typeof a === 'string') : []

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  const [{ data: project }, { data: card, error: cardError }] = await Promise.all([
    supabase.from('projects').select('tts_locale').eq('id', project_id).single(),
    supabase.from('knowledge_cards').select('id, name, kind, tags, details').eq('project_id', project_id).eq('id', card_id).single(),
  ])
  if (cardError || !card) return res.status(404).json({ error: 'Card not found' })

  const { data: seedCards } = await supabase.from('knowledge_cards').select('name').eq('project_id', project_id).neq('id', card_id).order('importance', { ascending: false }).limit(15)
  const seedCardNames = (seedCards ?? []).map(c => c.name)

  const promptContext = { ttsLocale: project?.tts_locale, card, avoid: avoidList, seedCardNames }

  let request = null
  try {
    const item = await generatePracticeItem({
      anthropic, model: MODEL, mode, promptContext,
      onRequest: r => { request = r },
    })
    return res.status(200).json({ item, request })
  } catch (e) {
    if (e instanceof PracticeGenerationFailedError) {
      return res.status(422).json({ error: e.message, detail: e.detail })
    }
    throw e
  }
}
