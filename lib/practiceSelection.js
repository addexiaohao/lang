// Practice session selection (plan.md — "Practice Scheduling" §5). Picks which skills to serve in
// a quick-start session — api/skills.js's `sort=weighted` mode is the only caller. Cards are
// loaded once, up front, with every skill row attached (including its scheduling fields — state,
// interval_days, due_at — and its last practice_attempt timestamp for the cooldown check);
// selectScheduledPracticeSkills does all further filtering/bucketing/weighting/
// interleaving in memory, no further DB round trips.
//
// plan.md §5 frames selection as "a query, computed per item" specifically so a stored "to test"
// bag never goes stale mid-session. This module is a practical middle ground for this app's scale:
// each of the N items in a session IS freshly computed against the full live candidate pool (the
// while-loop below re-evaluates weights against whatever's left after each pick, same as the
// interleaving constraints require), but the whole batch is still handed to the client once per
// "Quick practice" click rather than re-queried after every single round. A card/skill added or
// hand-edited mid-session won't retroactively reshuffle an already-started session — a real, known
// gap the plan warns about, accepted here rather than reworking the session/PracticePanel flow.

import { RETIRED_LEVEL, isInCooldown, isDue, FAILURE_CAP } from './practiceScheduling.js'
import { isGateSatisfied } from './skillTypes.js'

export { RETIRED_LEVEL }

// Retained for api/practice.js's pickSubstituteSkill fallback (picking a different skill when the
// originally requested one has no problem type configured) — a rare edge path this rewrite
// deliberately leaves on its simpler, pre-scheduling recency rule rather than threading the full
// gating/cooldown machinery through a one-off DB query. See that file's own comment.
export const EXCLUDE_RECENT_DAYS = 5

const DEFAULT_IMPORTANCE_WEIGHT = 5

// plan.md §5, bucket 1: "relearning — highest priority". A flat weight well above anything a
// stable/overdue skill can reach keeps a relearning queue from being crowded out by importance
// alone — the whole point of relearning is that it comes back SOON, not "eventually, if important".
const RELEARNING_WEIGHT = 100
// Bucket 2: "stable and overdue — priority scaled by how overdue". Base weight plus one point per
// overdue day, capped so a single very-overdue stable skill can't dominate every session forever.
const STABLE_BASE_WEIGHT = 20
const MAX_OVERDUE_BONUS_DAYS = 30
// Bucket 3 ('learning' and, when the cap allows it, 'never'): a flat mid-low weight — due dates
// already control how often these come up, so no overdue scaling is needed the way stable has.
const BASE_WEIGHT = 10

// plan.md §5 step 4: "weight by card importance, multiplied by a staleness factor so a
// high-importance skill does not monopolise consecutive sessions." Staleness ramps from a floor
// (never fully zeroes out importance) up to 1 over a month of not being touched; a skill with no
// attempt at all is maximally stale.
const STALENESS_FLOOR = 0.1
const STALENESS_FULL_DAYS = 30

// plan.md §5 step 5: "prefer alternating skill types" — a soft penalty, not a hard block, applied
// to a candidate whose type matches the immediately preceding pick.
const SAME_TYPE_PENALTY = 0.25

function bucketWeight(skill, now) {
  if (skill.state === 'relearning') return RELEARNING_WEIGHT
  if (skill.state === 'stable') {
    const overdueDays = skill.due_at ? Math.max(0, (now - new Date(skill.due_at)) / 86400000) : 0
    return STABLE_BASE_WEIGHT + Math.min(overdueDays, MAX_OVERDUE_BONUS_DAYS)
  }
  return BASE_WEIGHT // 'learning' or 'never'
}

function stalenessFactor(skill, now) {
  if (!skill.last_attempt_at) return 1
  const days = Math.max(0, (now - new Date(skill.last_attempt_at)) / 86400000)
  return Math.min(1, Math.max(STALENESS_FLOOR, days / STALENESS_FULL_DAYS))
}

function flatten(cards) {
  const rows = []
  for (const card of cards) {
    for (const skill of card.skills) rows.push({ card, skill })
  }
  return rows
}

function weightedPick(rows, weightFn) {
  const weighted = rows.map((r) => ({ r, w: weightFn(r) })).filter((x) => x.w > 0)
  const total = weighted.reduce((sum, x) => sum + x.w, 0)
  if (total <= 0) return null
  let roll = Math.random() * total
  for (const x of weighted) {
    roll -= x.w
    if (roll <= 0) return x.r
  }
  return weighted[weighted.length - 1].r // floating-point fallback
}

// cards: [{ ...cardFields, importance, skills: [{ id, type, level, importance, state, due_at,
//   last_attempt_at, dbType }] }] — the FULL project-wide pool (every card's
//   full skill set, including retired/gated/on-cooldown rows), same convention the old
//   two-stage picker used: gating needs sibling levels regardless of whether the sibling itself is
//   pickable right now.
// n: how many items to select.
// options.now: injectable Date for tests. options.failureCap: plan.md §4's config value (default
//   15) — "no new skills are introduced while more than this many are in relearning."
//
// Returns { picks: [{ card, skill }], relearningCount, capHit } — capHit is surfaced back through
// the API so the client can show plan.md §4's "working through N tricky ones" state instead of
// silently just... not introducing new words.
export function selectScheduledPracticeSkills(cards, n, options = {}) {
  const { now = new Date(), failureCap = FAILURE_CAP } = options

  const relearningCount = cards.reduce(
    (sum, c) => sum + c.skills.filter((s) => s.state === 'relearning').length,
    0
  )
  const capHit = relearningCount > failureCap

  // plan.md §5 step 1: "Filter to eligible: not retired, not in cooldown, gates satisfied, due_at
  // <= now()." Gating is checked against the card's OTHER skills (dbType-keyed rows), not the
  // resolved external type — see lib/skillTypes.js's isGateSatisfied.
  let candidates = flatten(cards).filter(({ card, skill }) => {
    if (skill.state === 'retired') return false
    if (isInCooldown(skill.last_attempt_at, now)) return false
    if (!isDue(skill.due_at, now)) return false
    if (skill.state === 'never' && capHit) return false
    return isGateSatisfied(card, skill.type, card.skills.map((s) => ({ type: s.dbType, level: s.level, state: s.state })))
  })

  const picks = []
  let lastCardId = null
  let lastType = null

  while (picks.length < n && candidates.length > 0) {
    // plan.md §5 step 5, hard constraint: "never serve two items on the same card consecutively."
    // Relaxed only if literally nothing else remains eligible, so a session with one lone
    // practiceable card doesn't just stop short.
    const noSameCard = candidates.filter(({ card }) => card.id !== lastCardId)
    const pool = noSameCard.length > 0 ? noSameCard : candidates
    const pick = weightedPick(pool, ({ card, skill }) => {
      let w = bucketWeight(skill, now) * Math.max(card.importance ?? DEFAULT_IMPORTANCE_WEIGHT, 1) * stalenessFactor(skill, now)
      if (skill.type === lastType) w *= SAME_TYPE_PENALTY // soft preference, not a hard block
      return w
    })
    if (!pick) break

    picks.push(pick)
    lastCardId = pick.card.id
    lastType = pick.skill.type
    candidates = candidates.filter(({ skill }) => skill.id !== pick.skill.id)
  }

  return { picks, relearningCount, capHit }
}
