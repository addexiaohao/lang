import { supabase } from './supabaseAdmin.js'

// Inserts one practice_note row — a dev/self-use scratch note attached to a practice question
// (api/practice-note.js). `question` is the raw generated item shown when the note was taken.
export function logPracticeNote({ skillId, question, note }) {
  return supabase.from('practice_note').insert({ skill_id: skillId, question, note })
}
