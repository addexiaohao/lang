// Recomputes every skill's practice-scheduling cache (state, interval_days, due_at,
// consecutive_correct, stable_interval_days — schema.sql's skill table comment, plan.md §6) from
// scratch by replaying its full practice_attempt history through the exact same
// computeSchedule()/nextLevel() functions the live PATCH path uses (lib/practiceScheduling.js) —
// so drift between the two is always fixable by just re-running this.
//
// Only writes the five scheduling-cache columns — never touches `skill.level` itself, since that's
// the authoritative field (plan.md §7: level computation is out of scope here) and can diverge from
// a pure outcome-replay whenever a manual hand_set edit happened somewhere in the middle of a
// skill's history (hand_set edits aren't logged to practice_attempt, so a replay can't see them).
// The one place this matters is retirement: after replaying, the skill's ACTUAL current level
// (fetched fresh, not the replayed one) is checked, and always wins — a hand-set level 10 always
// ends up 'retired' here regardless of what the attempt-only replay computed.
//
// Usage: node scripts/recompute-schedule.js [--dry-run]

import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { computeSchedule, nextLevel, NEVER_SCHEDULE, RETIRED_SCHEDULE, RETIRED_LEVEL } from '../lib/practiceScheduling.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../.env') })

const dryRun = process.argv.includes('--dry-run')

const { VITE_SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
if (!VITE_SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SECRET_KEY in .env')
  process.exit(1)
}

const supabase = createClient(VITE_SUPABASE_URL, SUPABASE_SECRET_KEY)

const PAGE_SIZE = 500

// Replays one skill's full attempt history (ascending) through computeSchedule/nextLevel, then
// forces retirement if the skill's real current level is 10 — see file header.
function replay(attempts, currentLevel) {
  let schedule = NEVER_SCHEDULE
  let replayedLevel = null
  for (const row of attempts) {
    replayedLevel = nextLevel(replayedLevel, row.outcome, schedule)
    const update = computeSchedule({ current: schedule, outcome: row.outcome, level: replayedLevel, now: new Date(row.created_at) })
    if (update) schedule = update
  }
  if (currentLevel === RETIRED_LEVEL) return RETIRED_SCHEDULE
  return schedule
}

function changed(current, recomputed) {
  return (
    current.state !== recomputed.state ||
    current.interval_days !== recomputed.interval_days ||
    (current.due_at ? new Date(current.due_at).toISOString() : null) !== recomputed.due_at ||
    current.consecutive_correct !== recomputed.consecutive_correct ||
    current.stable_interval_days !== recomputed.stable_interval_days
  )
}

async function main() {
  let offset = 0
  let skillsVisited = 0
  let skillsChanged = 0
  const perStateCount = {}

  while (true) {
    const { data: skills, error } = await supabase
      .from('skill')
      .select('id, level, state, interval_days, due_at, consecutive_correct, stable_interval_days')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) {
      console.error('Failed to fetch skill rows:', error.message)
      process.exit(1)
    }
    if (!skills.length) break

    const skillIds = skills.map((s) => s.id)
    const { data: attempts, error: attemptsErr } = await supabase
      .from('practice_attempt')
      .select('skill_id, outcome, created_at')
      .in('skill_id', skillIds)
      .order('created_at', { ascending: true })
    if (attemptsErr) {
      console.error('Failed to fetch practice_attempt rows:', attemptsErr.message)
      process.exit(1)
    }
    const attemptsBySkill = new Map()
    for (const row of attempts ?? []) {
      if (!attemptsBySkill.has(row.skill_id)) attemptsBySkill.set(row.skill_id, [])
      attemptsBySkill.get(row.skill_id).push(row)
    }

    for (const skill of skills) {
      skillsVisited++
      const recomputed = replay(attemptsBySkill.get(skill.id) ?? [], skill.level)
      perStateCount[recomputed.state] = (perStateCount[recomputed.state] ?? 0) + 1
      if (!changed(skill, recomputed)) continue
      skillsChanged++
      if (!dryRun) {
        const { error: updateErr } = await supabase.from('skill').update(recomputed).eq('id', skill.id)
        if (updateErr) {
          console.error(`Failed to update skill ${skill.id}:`, updateErr.message)
          process.exit(1)
        }
      }
    }

    offset += PAGE_SIZE
  }

  console.log(dryRun ? '[dry run] No writes performed.' : 'Recompute complete.')
  console.log(`Skills visited: ${skillsVisited}`)
  console.log(`Skills changed: ${skillsChanged}`)
  console.log('Final state distribution:', perStateCount)
}

main()
