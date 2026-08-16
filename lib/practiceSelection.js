// "Quick practice" skill selection (Practice mode's quick-start — see api/skills.js's
// `sort=weighted`). Two-stage weighted sample per quiz item: pick a CARD weighted by the card's
// own importance, then pick a SKILL on that card weighted by SKILL_SELECTION_WEIGHTS — a rule that
// can look at the levels of the card's OTHER skills, not just the one being weighed (e.g. gating a
// noun's "gender" behind its "meaning" being reasonably solid first). This is a different concern
// from lib/practiceRules.js's SKILL_PROBLEM_TYPES: that picks *how* to drill an already-chosen
// skill (mc_cloze vs spelling vs exemplar); this picks *which* skill on *which* card gets drilled
// in the first place.
//
// Cards are loaded once, up front, with every skill row attached (api/skills.js does this in a
// single query) — selectQuickPracticeSkills does all further sampling and re-selection in memory,
// no DB round trips, even when a card turns out to have nothing practiceable right now.

const DEFAULT_IMPORTANCE_WEIGHT = 5
const MEANING_GATE_LEVEL = 7

function meaningLevel(levelsByType) {
  return levelsByType.meaning ?? 1
}

function gatedByMeaning(level, levelsByType) {
  return meaningLevel(levelsByType) >= MEANING_GATE_LEVEL ? 1 : 0
}

// PROVISIONAL — same spirit as lib/skillTypes.js's DEFAULT_SKILL_IMPORTANCE and
// lib/practiceRules.js's SKILL_PROBLEM_TYPES: a placeholder starting point, expected to be
// hand-tuned once real behavior is observed. Per skill type, a function of (level, levelsByType)
// -> selection weight, where levelsByType is a { [skillType]: level } map of every skill type
// present on the SAME card (unassessed treated as level 1). <=0 makes that type unselectable on
// this card right now — same hard-block semantics as pickProblemType in lib/practiceRules.js. A
// type with no entry here (notably a paradigm cell's dotted axis path, e.g. "akk.masc") defaults
// to a flat weight of 1 — it has no sibling skill to gate behind.
//
// Today's placeholder: "meaning" is always in play; every other vocabulary facet (gender, the
// spelling forms, separability, case) is gated behind "meaning" reaching MEANING_GATE_LEVEL, so a
// card's core sense is solid before its grammatical facets get drilled.
export const SKILL_SELECTION_WEIGHTS = {
  meaning: () => 1,
  production: () => 1,
  gender: gatedByMeaning,
  'plural-spelling': gatedByMeaning,
  case: gatedByMeaning,
  'imperative-spelling': gatedByMeaning,
  'past-participle-spelling': gatedByMeaning,
  'present-spelling': gatedByMeaning,
  'simple-past-spelling': gatedByMeaning,
  'subjunctive-1-spelling': gatedByMeaning,
  'subjunctive-2-spelling': gatedByMeaning,
  'separated-form-understanding/recognition': gatedByMeaning,
}

function selectionWeight(type, level, levelsByType) {
  const fn = SKILL_SELECTION_WEIGHTS[type]
  return fn ? fn(level, levelsByType) : 1
}

// Weighted-random pick of one skill row out of `skills` (a single card's FULL skill set — every
// row, including ones `eligible` rejects, since gating rules need sibling levels regardless of
// whether that sibling is itself pickable right now). `eligible(skill) -> bool` filters which rows
// may actually be chosen (e.g. not excluded by recency, not already picked this session — see
// selectQuickPracticeSkills). Returns null if nothing eligible has a positive weight.
export function pickSkillForCard(skills, eligible) {
  if (!skills || skills.length === 0) return null
  const levelsByType = Object.fromEntries(skills.map((s) => [s.type, s.level ?? 1]))
  const weighted = skills
    .filter(eligible)
    .map((skill) => ({ skill, w: selectionWeight(skill.type, skill.level ?? 1, levelsByType) }))
    .filter((row) => row.w > 0)
  const total = weighted.reduce((sum, row) => sum + row.w, 0)
  if (total <= 0) return null

  let r = Math.random() * total
  for (const row of weighted) {
    r -= row.w
    if (r <= 0) return row.skill
  }
  return weighted[weighted.length - 1].skill // floating-point fallback
}

// Weighted-random pick of one card out of `cards`, by importance (missing importance falls back to
// DEFAULT_IMPORTANCE_WEIGHT) — same weighting convention as skill importance elsewhere in the app.
function pickCard(cards) {
  const total = cards.reduce((sum, c) => sum + Math.max(c.importance ?? DEFAULT_IMPORTANCE_WEIGHT, 1), 0)
  if (total <= 0) return null

  let r = Math.random() * total
  for (const card of cards) {
    r -= Math.max(card.importance ?? DEFAULT_IMPORTANCE_WEIGHT, 1)
    if (r <= 0) return card
  }
  return cards[cards.length - 1] // floating-point fallback
}

// Selects up to `n` skills for a quick-practice session. Per item: weighted-pick a card by
// importance, then weighted-pick a skill on it (pickSkillForCard). If the chosen card has nothing
// practiceable right now — no skills at all, everything excluded by `eligible`, or every weight
// gates to 0 — it's dropped from the candidate pool and a different card is picked instead; no DB
// round trip, since `cards` is the full candidate set the caller already loaded (see
// api/skills.js). A card can supply more than one item (different skills), but the same skill
// row is never returned twice in one call.
//
// cards: [{ ...cardFields, skills: [{ id, type, level, importance, last_correct }] }]
// eligible: (skill) -> bool, e.g. "last_correct is null or older than the recency cutoff".
export function selectQuickPracticeSkills(cards, n, eligible) {
  const picked = new Set()
  let pool = cards.filter((c) => c.skills.length > 0)
  const results = []

  while (results.length < n && pool.length > 0) {
    const card = pickCard(pool)
    const skill = pickSkillForCard(card.skills, (s) => !picked.has(s.id) && eligible(s))
    if (!skill) {
      pool = pool.filter((c) => c !== card)
      continue
    }
    picked.add(skill.id)
    results.push({ card, skill })
    if (card.skills.every((s) => picked.has(s.id))) {
      pool = pool.filter((c) => c !== card)
    }
  }

  return results
}
