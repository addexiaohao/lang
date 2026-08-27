import { supabase } from './supabaseAdmin.js'
import { getModelPricing, computeCostUsd } from './llmPricing.js'

// Inserts one llm_api_call row (schema.sql) — the single insert point every call site in the app
// goes through: api/chat.js's per-turn tool loop, api/practice.js's generation/retry + mc_cloze
// checks, api/practice-explain.js, lib/senseCheck.js's checkSense()/suggestSense(). Never throws:
// a failure to log usage must never break the actual chat/practice/sense feature that triggered
// it, so insert errors are swallowed (and reported to console) here — same spirit as
// lib/mcClozeCheckLog.js's failures-only insert.
export async function logLlmApiCall({
  projectId = null, userId = null, purpose, model, status = 'success', errorMessage = null,
  usage = null, stopReason = null, latencyMs = null, requestId = null,
  cardId = null, skillId = null, metadata = null,
}) {
  const pricing = await getModelPricing(model)
  const row = {
    project_id: projectId,
    user_id: userId,
    purpose,
    model,
    status,
    error_message: errorMessage,
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? null,
    stop_reason: stopReason,
    latency_ms: latencyMs,
    cost_usd: computeCostUsd(pricing, usage),
    request_id: requestId,
    card_id: cardId,
    skill_id: skillId,
    metadata,
  }
  const { error } = await supabase.from('llm_api_call').insert(row)
  if (error) console.error('[llm_api_call] insert failed:', error.message)
}
