import { supabase } from './supabaseAdmin.js'

// Inserts one mc_cloze_check_failure row when a verification attempt (lib/mcClozeCheck.js's
// verifyMcClozeItem) FAILED — a passing check writes nothing, so this table only ever holds real
// problems. api/practice.js calls this unconditionally from generatePracticeItem's `onCheck`
// callback (once per attempt) and lets this function decide whether there's anything to log.
//
// `conversation` is the ENTIRE conversation history behind the flagged item, stored verbatim so a
// failure can be replayed end to end rather than reconstructed from the item's sentence/options:
//   - generation.request  — the exact { model, system, messages } sent to the generation model for
//                           this attempt (api/practice.js's `request`, via onRequest)
//   - generation.response — that call's raw content array (extended-thinking blocks, the Step 1
//                           sentence-drafting text, and the Step 2 tool call — see
//                           lib/practiceGenerate.js), via onResponse
//   - checks[]            — one entry per option the answer-uniqueness checker judged, each its own
//                           independent conversation: { option, isAnswer, sentence, request,
//                           response, grammatical, sensible, matchesMeaning, reason } straight off
//                           verifyMcClozeItem's `checks` array
// Any branch is null if it wasn't captured (older rows predate the column; a check can in principle
// fire before onRequest/onResponse). The flat offending_sentences/reasons columns stay the
// quick-scan summary; this jsonb is the full record.
export function logMcClozeCheck({ skillId, cardId, skillType, model, item, verification, generationRequest, generationResponse }) {
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
    conversation: {
      generation: {
        request: generationRequest ?? null,
        response: generationResponse ?? null,
      },
      checks: verification.checks ?? null,
    },
  }
  return supabase.from('mc_cloze_check_failure').insert(row)
}
