import { supabase } from './supabaseAdmin.js'

// Inserts one mc_cloze_check_failure row when a verification attempt (lib/mcClozeCheck.js's
// verifyMcClozeItem) FAILED — a passing check writes nothing, so this table only ever holds real
// problems. api/practice.js calls this unconditionally from generatePracticeItem's `onCheck`
// callback (once per attempt) and lets this function decide whether there's anything to log.
// `conversation` is the { model, system, messages } generation request that produced this item
// (api/practice.js's `request`, captured via generatePracticeItem's onRequest) — round-tripped in so
// a failure can be traced back to the exact prompt/history that made it. Null if unavailable.
export function logMcClozeCheck({ skillId, cardId, skillType, model, item, verification, conversation }) {
  if (verification.passed) return Promise.resolve(null)
  const row = {
    skill_id: skillId ?? null,
    card_id: cardId,
    skill_type: skillType,
    model,
    sentence: item.sentence,
    options: item.options,
    answer: item.answer,
    offending_sentences: verification.offendingSentences,
    reasons: verification.reasons,
    conversation: conversation ?? null,
  }
  return supabase.from('mc_cloze_check_failure').insert(row)
}
