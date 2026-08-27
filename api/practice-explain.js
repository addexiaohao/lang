import Anthropic from '@anthropic-ai/sdk'
import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { compose } from '../lib/prompts/registry.js'
import { CHAT_MODEL } from '../lib/chatLoop.js'
import { logLlmApiCall } from '../lib/llmUsageLog.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Backs the Practice mode "Ask" button. Deliberately separate from api/chat.js:
// a plain teacher-persona system prompt (practice.explain), no dedup tools, no save-block
// instructions — so the frontend never needs to parse the response for save blocks, it's
// just prose. Stateless like api/chat.js: the client (PracticeExplain.jsx) keeps the running
// conversation and resends the full `messages` array each turn, so multi-round follow-up
// questions stay in context. The practice item's sentence/options/card name rides silently in
// the first user turn's content (folded in client-side) — it's never a message of its own.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, messages } = req.body ?? {}
  if (!project_id) return res.status(400).json({ error: 'project_id required' })
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' })
  }

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  const { data: project } = await supabase.from('projects').select('tts_locale').eq('id', project_id).single()
  const systemPrompt = compose('practice.explain', { ttsLocale: project?.tts_locale })

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Transfer-Encoding', 'chunked')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')

  const startedAt = Date.now()
  const stream = anthropic.messages.stream({
    model: CHAT_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  })

  try {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(event.delta.text)
      }
    }
    const message = await stream.finalMessage()
    await logLlmApiCall({
      projectId: project_id, userId: user.id, purpose: 'practice_explain', model: CHAT_MODEL,
      usage: message.usage, stopReason: message.stop_reason, latencyMs: Date.now() - startedAt,
    })
  } catch (e) {
    await logLlmApiCall({
      projectId: project_id, userId: user.id, purpose: 'practice_explain', model: CHAT_MODEL,
      status: 'error', errorMessage: e.message, latencyMs: Date.now() - startedAt,
    })
    throw e
  }

  res.end()
}
