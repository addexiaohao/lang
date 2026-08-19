import { supabase } from './supabaseAdmin.js'

// Inserts one practice_attempt row. A multi-round chain (the "Easier sentence" button, see
// lib/practiceGenerate.js's `history` param) produces one row per round, all sharing one
// encounterId — api/knowledge-cards.js's practice_result branch (right/wrong/don't-know, also
// bumps skill.level) and api/practice-attempt.js (outcome: 'too_hard', no level mutation) both
// call this. `conversation` is the raw { request, response } pair actually used for that round —
// request.messages already replays prior rounds' turns when this is a continuation, so a later
// round's conversation is "the whole thing up to this point", not a diff against earlier rows.
export function logPracticeAttempt({ skillId, encounterId, outcome, model, conversation }) {
  const row = { skill_id: skillId, outcome }
  if (encounterId) row.encounter_id = encounterId
  if (model !== undefined) row.model = model
  if (conversation !== undefined) row.conversation = conversation
  return supabase.from('practice_attempt').insert(row)
}
