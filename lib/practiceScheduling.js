// Practice scheduling. Turns a practice round's outcome into the skill's next `state`/
// `interval_days`/`due_at` — the spaced-repetition side of a practice attempt, separate from (and
// computed alongside) the existing level-bump logic in api/knowledge-cards.js.
//
// All state here is a recomputable cache over practice_attempt (schema.sql's skill table comment)
// — scripts/recompute-schedule.js re-derives it from scratch by replaying computeSchedule()/
// nextLevel() over a skill's full attempt history, so this file is the ONE place both the live
// write path (api/knowledge-cards.js) and the recompute script call into.

// retired: level 10 or hand-set to retired; never scheduled. Defined here (not in
// lib/practiceSelection.js, which imports it from here) so this file has no dependency back on the
// selection module — practiceSelection.js's bucketing/weighting logic depends on this file, not
// the other way around.
export const RETIRED_LEVEL = 10

// Intervals expand, not repeat: roughly 1 / 3 / 7 / 16 / 35 days.
export const INTERVAL_LADDER = [1, 3, 7, 16, 35]

// Within-session cooldown: minimum time before a skill can be served again, regardless of state.
export const COOLDOWN_MINUTES = 15

// No new skills are introduced while more than this many skills are in 'relearning'.
export const FAILURE_CAP = 30

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

// due_at is derived ONLY from a skill's current level (1-9; level 10 is 'retired' and never
// reaches this) — not from scheduling state or history. Buckets two levels per rung of
// INTERVAL_LADDER: level 1-2 -> 1 day, 3-4 -> 3 days, 5-6 -> 7 days, 7-8 -> 16 days, 9 -> 35 days.
export function intervalForLevel(level) {
  const rung = Math.min(Math.floor((level - 1) / 2), INTERVAL_LADDER.length - 1)
  return INTERVAL_LADDER[rung]
}

// The schedule shape every caller reads/writes — never/retired both mean "not on the ladder",
// distinguished by `state` alone (retired also implies "never scheduled again").
export const NEVER_SCHEDULE = Object.freeze({ state: 'never', interval_days: null, due_at: null })
export const RETIRED_SCHEDULE = Object.freeze({ state: 'retired', interval_days: null, due_at: null })

// State machine — five states, driven only by the CURRENT state + this round's outcome:
//
//   never       -incorrect->  learning     (never proven it once, still failing)
//   never       -correct->    stable       (nailed it cold on the first try — trusted immediately)
//   learning    -incorrect->  learning     (still not proven)
//   learning    -correct->    relearning   (proven once, not yet confirmed)
//   relearning  -incorrect->  learning     (lost the one correct — back to square one)
//   relearning  -correct->    stable       (two correct in a row — confirmed)
//   stable      -incorrect->  learning     (a lapse IS "previously incorrect" — no separate
//                                           "just lapsed" bucket, no memory of prior stability)
//   stable      -correct->    stable
//   (any)       level = 10 -> retired
//
// 'learning' is deliberately the single catch-all for "the most recent answer was wrong" — a
// skill lapsing after being stable and a skill that has never once been right both land here, and
// both have to re-earn 'stable' via the same learning -> relearning -> stable climb. There is no
// separate lapse state and no memory of how far a skill had progressed before it fell:
// interval_days is recomputed from the CURRENT level every time (intervalForLevel above), and a
// skill's own level (already tracked by nextLevel(), below) is what carries "how established this
// skill is" — the scheduling state carries none of that memory itself.
const CORRECT_TRANSITION = {
  never: 'stable',
  learning: 'relearning',
  relearning: 'stable',
  stable: 'stable',
  retired: 'stable', // defensive only — level === RETIRED_LEVEL is checked before this is reached
}

// current: the skill's schedule fields BEFORE this attempt — { state } (use NEVER_SCHEDULE for a
// skill practiced for the first time). outcome: 'correct' | 'incorrect' | 'too_hard'. level: the
// skill's level AFTER this round's level-bump has already been applied by the caller — used to
// check retirement and to compute the new interval (interval_days depends on level alone, not on
// which state transition produced it). now: injectable for tests/recompute replay.
//
// Returns the new schedule fields to write, or null when nothing should change — 'too_hard' is the
// only outcome that returns null: a generator failure, not a knowledge signal.
export function computeSchedule({ current, outcome, level, now = new Date() }) {
  if (outcome === 'too_hard') return null
  if (level === RETIRED_LEVEL) return { ...RETIRED_SCHEDULE }

  const state = outcome === 'incorrect' ? 'learning' : (CORRECT_TRANSITION[current.state] ?? 'stable')
  const interval = intervalForLevel(level)
  return { state, interval_days: interval, due_at: addDays(now, interval).toISOString() }
}

// The manual editor (CardDetailPanel/SkillsPanel's PATCH .../knowledge-cards { level }) isn't a
// practice outcome, so it doesn't run the correct/incorrect transition table above — but it DOES
// move the scheduling state, based on the direction of the change relative to the skill's previous
// level (`current.level`):
//   - new level > previous  -> 'stable'   (the edit asserts stronger recall than what was recorded)
//   - new level < previous  -> 'learning' (the edit asserts weaker recall — back on the climb)
//   - new level = previous  -> state unchanged (recall strength didn't change)
// due_at / interval_days are ALWAYS recomputed from the new level (they're a pure function of it),
// every case included. Edge transitions a bare number still forces regardless of direction: level
// 10 retires the schedule, level null resets it to 'never'. A skill with no previous level at all
// (never assessed, or currently retired/'never') is treated as previous 0, so any real level is an
// increase -> 'stable'.
export function scheduleForManualLevel(current, level) {
  if (level === RETIRED_LEVEL) return { ...RETIRED_SCHEDULE }
  if (level === null) return { ...NEVER_SCHEDULE }
  const prevLevel = current.level ?? 0
  let state
  if (level > prevLevel) state = 'stable'
  else if (level < prevLevel) state = 'learning'
  else state = current.state === 'retired' || current.state === 'never' ? 'learning' : current.state
  const interval = intervalForLevel(level)
  return { state, interval_days: interval, due_at: addDays(new Date(), interval).toISOString() }
}

// Level-bump formula shared by the live PATCH path (api/knowledge-cards.js) and
// scripts/recompute-schedule.js's replay — factored out purely so the recompute script can derive
// the same trajectory without duplicating the arithmetic. `current` is the skill's schedule fields
// BEFORE this attempt (same shape/value as computeSchedule's `current` param — use NEVER_SCHEDULE
// for a skill practiced for the first time): the level does not increase on a 'learning' skill's
// correct answer, since that's exactly the "proven once, not yet confirmed" transition to
// 'relearning' above — a single retrieval right after being unconfirmed measures whether it can be
// done at all, not durable recall. The SECOND consecutive correct (the one that confirms
// 'relearning' -> 'stable') bumps normally, same as any other correct answer. 'too_hard' never
// reaches this path in the live app (api/practice-attempt.js's outcome doesn't bump level) but is
// handled here too so replay stays a straight fold over every attempt row regardless of outcome.
export function nextLevel(currentLevel, outcome, current = NEVER_SCHEDULE) {
  const level = currentLevel ?? 1
  if (outcome === 'correct') {
    if (current.state === 'learning') return level
    return Math.min(level + 1, 10)
  }
  if (outcome === 'incorrect') return Math.max(level - 1, 1)
  return currentLevel
}

export function isInCooldown(lastAttemptAt, now = new Date()) {
  if (!lastAttemptAt) return false
  return now.getTime() - new Date(lastAttemptAt).getTime() < COOLDOWN_MINUTES * 60 * 1000
}

// due_at = null means "never scheduled yet" (state 'never') — always due, same as before any
// interval exists.
export function isDue(dueAt, now = new Date()) {
  if (!dueAt) return true
  return new Date(dueAt) <= now
}
