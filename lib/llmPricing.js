// Resolves $/1M-token pricing for a model from llm_model_pricing (schema.sql) and turns a raw
// Anthropic `usage` object into a dollar figure. Cached in-process per model — pricing changes
// rarely enough that a fresh Supabase round trip on every single LLM call (chat's per-turn loop,
// mc_cloze's per-option checks) would be pure overhead; a redeploy (which happens often on this
// app) clears the cache anyway, so staleness is bounded by that, not by anything in this file.

import { supabase } from './supabaseAdmin.js'

const cache = new Map() // model -> pricing row | null

export async function getModelPricing(model) {
  if (cache.has(model)) return cache.get(model)
  const { data } = await supabase
    .from('llm_model_pricing')
    .select('input_cost_per_million, output_cost_per_million, cache_write_cost_per_million, cache_read_cost_per_million')
    .eq('model', model)
    .lte('effective_from', new Date().toISOString())
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle()
  cache.set(model, data ?? null)
  return data ?? null
}

// null (not 0) whenever the model has no pricing row on file — e.g. PRACTICE_MODEL/
// PRACTICE_CHECK_MODEL pointed at something unseeded — so llm_api_call.cost_usd stays an honest
// "unknown" instead of silently logging a wrong number. Token counts still log either way.
export function computeCostUsd(pricing, usage) {
  if (!pricing || !usage) return null
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cost =
    (input / 1e6) * Number(pricing.input_cost_per_million) +
    (output / 1e6) * Number(pricing.output_cost_per_million) +
    (cacheWrite / 1e6) * Number(pricing.cache_write_cost_per_million ?? 0) +
    (cacheRead / 1e6) * Number(pricing.cache_read_cost_per_million ?? 0)
  return Math.round(cost * 1e6) / 1e6 // match the column's 6dp scale
}
