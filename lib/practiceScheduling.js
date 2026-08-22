// Practice scheduling (plan.md — "Practice Scheduling — Build Plan"). Turns a practice round's
// outcome into the skill's next `state`/`interval_days`/`due_at`/`consecutive_correct` — the
// spaced-repetition side of a practice attempt, separate from (and computed alongside) the
// existing level-bump logic in api/knowledge-cards.js, which plan.md §7 explicitly keeps
// unchanged ("Out of scope: Any change to how levels are computed from outcomes").
//
// All state here is a recomputable cache over practice_attempt (schema.sql's skill table comment,
// plan.md §6) — scripts/recompute-schedule.js re-derives it from scratch by replaying
// computeSchedule()/nextLevel() over a skill's full attempt history, so this file is the ONE place
// both the live write path (api/knowledge-cards.js) and the recompute script call into.

// plan.md §1: "retired: level 10 or hand-set to retired; never scheduled." Defined here (not in
// lib/practiceSelection.js, which imports it from here) so this file has no dependency back on the
// selection module — practiceSelection.js's bucketing/weighting logic depends on this file, not
// the other way around.
export const RETIRED_LEVEL = 10

// Finding 1 (plan.md): "Intervals should expand, not repeat. Roughly 1 / 3 / 7 / 16 / 35 days."
export const INTERVAL_LADDER = [1, 3, 7, 16, 35]

// plan.md §2: "Within-session cooldown: 15 minutes minimum before a skill can be served again,
// regardless of state."
export const COOLDOWN_MINUTES = 15

// plan.md §4: "No new skills are introduced while more than 15 skills are in relearning."
export const FAILURE_CAP = 15

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function rungIndex(days) {
  const idx = INTERVAL_LADDER.indexOf(days)
  return idx === -1 ? 0 : idx
}

// The schedule shape every caller reads/writes — never/retired both mean "not on the ladder",
// distinguished by `state` alone (retired also implies "never scheduled again", plan.md §1).
export const NEVER_SCHEDULE = Object.freeze({ state: 'never', interval_days: null, due_at: null, consecutive_correct: 0, stable_interval_days: null })
export const RETIRED_SCHEDULE = Object.freeze({ state: 'retired', interval_days: null, due_at: null, consecutive_correct: 0, stable_interval_days: null })

// current: the skill's schedule fields BEFORE this attempt — { state, interval_days,
// consecutive_correct, stable_interval_days } (use NEVER_SCHEDULE for a skill practiced for the
// first time). outcome: 'correct' | 'incorrect' | 'too_hard'. level: the skill's level AFTER this
// round's level-bump has already been applied by the caller — used only to check retirement here,
// not to recompute the bump itself. now: injectable for tests/recompute replay.
//
// Returns the new schedule fields to write, or null when nothing should change — 'too_hard' is the
// only outcome that returns null (plan.md §2: "does not affect interval or level at all — it is a
// generator failure, not a knowledge signal").
export function computeSchedule({ current, outcome, level, now = new Date() }) {
  if (outcome === 'too_hard') return null
  if (level === RETIRED_LEVEL) return { ...RETIRED_SCHEDULE }

  if (outcome === 'incorrect') {
    // plan.md §1: "relearning" is defined as "failed SINCE LAST PROMOTION" — that presupposes a
    // promotion to 'stable' actually happened. A skill still working through its very first
    // acquisition (never yet promoted) just stays 'learning' on a wrong answer, not 'relearning'.
    if (current.state !== 'stable' && current.state !== 'relearning') {
      return { state: 'learning', interval_days: 1, due_at: addDays(now, 1).toISOString(), consecutive_correct: 0, stable_interval_days: null }
    }
    return {
      state: 'relearning',
      interval_days: 1,
      due_at: addDays(now, 1).toISOString(),
      consecutive_correct: 0,
      // Remember the rung this skill fell FROM, so exiting relearning later can "rejoin the
      // ladder at its previous rung minus one" (plan.md §2). Only captured on the FIRST fail of a
      // relearning episode — a repeat fail while already relearning must not overwrite it with the
      // pinned interval_days=1 that this same branch is about to write.
      stable_interval_days: current.state === 'relearning' ? (current.stable_interval_days ?? 1) : (current.interval_days ?? 1),
    }
  }

  // outcome === 'correct'
  if (current.state === 'relearning') {
    const consecutive = (current.consecutive_correct ?? 0) + 1
    if (consecutive < 2) {
      // plan.md §1: "the level does not increase on the first correct answer after a failure" —
      // same principle applied to scheduling: stay pinned at 1 day until the second consecutive
      // correct actually proves durable (not working-memory) recall.
      return { state: 'relearning', interval_days: 1, due_at: addDays(now, 1).toISOString(), consecutive_correct: consecutive, stable_interval_days: current.stable_interval_days ?? 1 }
    }
    const prevRung = rungIndex(current.stable_interval_days ?? 1)
    const rejoinRung = Math.max(prevRung - 1, 0)
    const interval = INTERVAL_LADDER[rejoinRung]
    return { state: 'stable', interval_days: interval, due_at: addDays(now, interval).toISOString(), consecutive_correct: 0, stable_interval_days: null }
  }

  // never / learning / stable -> advance the ladder one rung (never repeat the same interval).
  // A skill's very first correct answer (current.interval_days is still null) lands on rung 0 (1
  // day) and is labelled 'learning'; only once it's been correct AGAIN — reaching rung 1 (3 days)
  // — does it graduate to 'stable'. This is the one place plan.md doesn't spell out the
  // learning/stable boundary explicitly; rung 0 = 'learning', rung >= 1 = 'stable' is this file's
  // deliberate reading of §1, chosen because it's the simplest rule consistent with "successful
  // retrieval strengthens memory" (finding 2) needing two clean hits before intervals start
  // meaningfully expanding.
  const rung = current.interval_days != null ? rungIndex(current.interval_days) + 1 : 0
  const nextRung = Math.min(rung, INTERVAL_LADDER.length - 1)
  const interval = INTERVAL_LADDER[nextRung]
  return {
    state: nextRung === 0 ? 'learning' : 'stable',
    interval_days: interval,
    due_at: addDays(now, interval).toISOString(),
    consecutive_correct: 0,
    stable_interval_days: null,
  }
}

// The manual editor (CardDetailPanel/SkillsPanel's PATCH .../knowledge-cards { level }) doesn't go
// through computeSchedule at all — it's not an outcome, so it shouldn't move the ladder. It only
// ever needs to handle the two edge transitions that a bare level number forces regardless of
// scheduling history: retiring (level set to 10) and un-setting (level cleared to null). Leaving a
// non-retired, non-null hand-set level alone (returns null) preserves whatever due date practice
// already earned — correcting a level number isn't a reason to reset review timing.
export function scheduleForManualLevel(current, level) {
  if (level === RETIRED_LEVEL) return { ...RETIRED_SCHEDULE }
  if (level === null) return { ...NEVER_SCHEDULE }
  if (current.state === 'retired') {
    // Un-retiring by hand: not derived from any practice history, so there's no ladder position to
    // resume — re-enter at the bottom, due immediately, same as a skill that's never been assessed.
    return { state: 'learning', interval_days: 1, due_at: new Date().toISOString(), consecutive_correct: 0, stable_interval_days: null }
  }
  return null
}

// Level-bump formula shared by the live PATCH path (api/knowledge-cards.js) and
// scripts/recompute-schedule.js's replay — factored out purely so the recompute script can derive
// the same trajectory without duplicating the arithmetic. `current` is the skill's schedule fields
// BEFORE this attempt (same shape/value as computeSchedule's `current` param — use NEVER_SCHEDULE
// for a skill practiced for the first time): plan.md §1 carves out one explicit exception to "level
// computation is out of scope" (§7) — "the level does not increase on the first correct answer
// after a failure," since a single post-miss retrieval measures working memory, not durable recall.
// That's exactly `current.state === 'relearning'` with no consecutive correct yet this episode; the
// SECOND consecutive correct (the one that actually exits relearning) bumps normally. 'too_hard'
// never reaches this path in the live app (api/practice-attempt.js's outcome doesn't bump level)
// but is handled here too so replay stays a straight fold over every attempt row regardless of
// outcome.
export function nextLevel(currentLevel, outcome, current = NEVER_SCHEDULE) {
  const level = currentLevel ?? 1
  if (outcome === 'correct') {
    if (current.state === 'relearning' && (current.consecutive_correct ?? 0) === 0) return level
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
