// Registry of skill types per card kind, plus validation shared by every write path that touches
// the `skill` table (api/save.js's card-creation flow, api/knowledge-cards.js's manual PATCH,
// scripts/backfill-skills.js). See schema.sql's `skill` table comment and plan.md §4.

export const SKILL_TYPES = {
  vocabulary: ['meaning', 'gender', 'plural-spelling', 'case', 'imperative-spelling', 'past-participle-spelling', 'present-spelling', 'simple-past-spelling', 'subjunctive-1-spelling', 'subjunctive-2-spelling', 'separated-form-understanding/recognition'],
  grammar: ['production'],
  expression: ['meaning'],
}

// PROVISIONAL — seeded from the project's existing tag catalog (noun/verb/verb-separable/etc.,
// see database_backups/data.sql) as a reasonable starting point. The user will hand-tune these
// tag -> extra-skill-type rules; this is the one table to edit when they do.
const VOCAB_TAG_RULES = [
  { tag: 'noun', adds: ['gender'] },
  { tag: 'noun-irregular', adds: ['plural-spelling'] },
  { tag: 'preposition', adds: ['case'] },
  { tag: 'verb-irregular-imperative', adds: ['imperative-spelling'] },
  { tag: 'verb-irregular-past-participle', adds: ['past-participle-spelling'] },
  { tag: 'verb-irregular-plural', adds: ['plural-spelling'] },
  { tag: 'verb-irregular-present', adds: ['present-spelling'] },
  { tag: 'verb-irregular-simple-past', adds: ['simple-past-spelling'] },
  { tag: 'verb-irregular-subjunctive-1', adds: ['subjunctive-1-spelling'] },
  { tag: 'verb-irregular-subjunctive-2', adds: ['subjunctive-2-spelling'] },
  { tag: 'verb-separable', adds: ['separated-form-understanding/recognition'] },
]

// Default importance assigned to a skill row when it's first created (eager flat-card creation
// in save_card_and_link, or scripts/backfill-skills.js) — per skill type, and a function of the
// card's own importance rather than a flat copy. PROVISIONAL — every entry is a placeholder
// `(cardImportance) => cardImportance` today; the user will hand-tune the per-type formulas here.
const DEFAULT_SKILL_IMPORTANCE = {
  vocabulary: {
    'meaning': (cardImportance) => cardImportance,
    'gender': (cardImportance) => cardImportance,
    'plural-spelling': (cardImportance) => 2,
    'case': (cardImportance) => cardImportance,
    'imperative-spelling': (cardImportance) => 2,
    'past-participle-spelling': (cardImportance) => 2,
    'present-spelling': (cardImportance) => 2,
    'simple-past-spelling': (cardImportance) => 2,
    'subjunctive-1-spelling': (cardImportance) => 2,
    'subjunctive-2-spelling': (cardImportance) => 2,
    'separated-form-understanding/recognition': (cardImportance) => 2,
  },
  grammar: {
    'production': (cardImportance) => cardImportance,
  },
  expression: {
    'meaning': (cardImportance) => cardImportance,
  },
}

// kind: card.kind. type: skill type (SKILL_TYPES[kind] member). cardImportance: the card's own
// importance (0-10, possibly null) — the variable each type's formula above can use.
export function deriveSkillImportance(kind, type, cardImportance) {
  const fn = DEFAULT_SKILL_IMPORTANCE[kind]?.[type]
  return fn ? fn(cardImportance) : cardImportance
}

// Which skill types a newly-saved flat card (no details.axes) should get eagerly, level = null
// (never practiced). Paradigm cards get none eagerly — see schema.sql's skill table comment.
export function deriveFlatSkillTypes(card) {
  const kind = card.kind
  if (kind === 'grammar') return [...SKILL_TYPES.grammar]
  if (kind === 'expression') return [...SKILL_TYPES.expression]
  if (kind !== 'vocabulary') return []

  const tags = new Set(card.tags ?? [])
  const types = new Set(['meaning'])
  const removed = new Set()
  for (const rule of VOCAB_TAG_RULES) {
    if (!tags.has(rule.tag)) continue
    for (const t of rule.adds) types.add(t)
    for (const t of rule.removes ?? []) removed.add(t)
  }
  for (const t of removed) types.delete(t)
  return [...types]
}

// Canonical cell key derivation for paradigm axis_values, shared by the frontend's axes-grid
// preview and any future per-cell write path. Axis names sorted alphabetically, values
// lowercased/slugified, joined with "-". (Historically lived in api/save.js for table_cells.)
export function deriveCellKey(axisValues) {
  return Object.keys(axisValues)
    .sort()
    .map(k => String(axisValues[k]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .join('-')
}

// ── Gating (plan.md — "Practice Scheduling" §3) ────────────────────────────────────────────────
// "A skill is not eligible until its prerequisites within the same card are met." Keyed by
// card.kind then external skill type; a missing entry (including every kind's `meaning`/paradigm
// dotted-path/sense-key type — see below) means "no gate, always eligible" by construction, so
// sense skills and paradigm cells don't need special-casing here at all.
export const SKILL_GATES = {
  vocabulary: {
    meaning: null,
    gender: { prereqType: 'meaning', minLevel: 3 },
    'plural-spelling': { prereqType: 'meaning', minLevel: 3 },
    case: { prereqType: 'meaning', minLevel: 3 },
    'imperative-spelling': { prereqType: 'meaning', minLevel: 3 },
    'past-participle-spelling': { prereqType: 'meaning', minLevel: 3 },
    'present-spelling': { prereqType: 'meaning', minLevel: 3 },
    'simple-past-spelling': { prereqType: 'meaning', minLevel: 3 },
    'subjunctive-1-spelling': { prereqType: 'meaning', minLevel: 3 },
    'subjunctive-2-spelling': { prereqType: 'meaning', minLevel: 3 },
    'separated-form-understanding/recognition': { prereqType: 'meaning', minLevel: 3 },
  },
  grammar: {
    // 'production' is a grammar card's ONLY flat type (SKILL_TYPES.grammar) — a grammar card never
    // gets a `meaning` skill row at all, so there's no same-card sibling for plan.md §3's
    // "production skills | meaning >= 8" row to gate against here. Read as applying to a future
    // vocabulary-level production skill type instead; grammar's own `production` stays ungated.
    production: null,
  },
  expression: {
    meaning: null,
  },
}

// card: { kind }. skillType: the EXTERNAL type being checked for eligibility (e.g. "gender", a
// sense key like "financial", or a paradigm dotted path like "akk.masc" — none of which appear in
// SKILL_GATES, so they resolve to "ungated" automatically). cardSkillRows: every OTHER skill row on
// the SAME card, DB-shaped ({ type, level, state } — `type` here means the literal DB column, not
// the resolved external string, since a gate's prereqType names a DB type like "meaning" and must
// match every sense of a sense-split card at once, not just one sense key).
//
// plan.md §3: "Gate on a *stable* threshold, not a bare number" — a prerequisite skill whose level
// clears minLevel but is currently `relearning` does NOT satisfy the gate, so a lapsed prerequisite
// can't keep unlocking dependents while its own queue is still working itself out.
export function isGateSatisfied(card, skillType, cardSkillRows) {
  const rule = SKILL_GATES[card.kind]?.[skillType]
  if (!rule) return true
  return (cardSkillRows ?? []).some(
    (row) => row.type === rule.prereqType && row.level != null && row.level >= rule.minLevel && row.state === 'stable'
  )
}

// card: { kind, details }. Paradigm cards (details.axes present) validate `type` as a dotted path
// with one segment per axis, each segment a legal value for that axis. Flat cards validate `type`
// against SKILL_TYPES[kind].
export function validateSkillType(card, type) {
  const axes = card.details?.axes
  if (Array.isArray(axes) && axes.length > 0) {
    const segments = type.split('.')
    if (segments.length !== axes.length) return false
    return axes.every((axis, i) => Array.isArray(axis.values) && axis.values.some(v => axisValueKey(v) === segments[i]))
  }
  const legal = SKILL_TYPES[card.kind] ?? []
  return legal.includes(type)
}

// ── Word senses (plan.md — "Word Senses") ──────────────────────────────────────────────────────
// A polysemous word is a card with a one-dimensional paradigm: a single axis named "sense" whose
// values are objects (not bare strings, unlike every other paradigm axis) so each sense can carry
// a `gloss` (and, once encountered, an `example` excerpt) alongside its `key`. axisValueKey/
// axisValueGloss/axisValueExample below are the one place that reads an axis value's shape, so
// every other paradigm axis (declension grids etc, plain string values) and every sense axis
// (object values) can be handled by the same code without a kind check at each call site.

// The dotted-path skill type segment for an axis value — a sense axis's skill types ARE its axis
// values' keys (e.g. "seating", "financial"), same as any other paradigm axis's values double as
// its cell types.
export function axisValueKey(v) {
  return typeof v === 'string' ? v : v.key
}

export function axisValueGloss(v) {
  return typeof v === 'string' ? null : (v.gloss ?? null)
}

export function axisValueExample(v) {
  return typeof v === 'string' ? null : (v.example ?? null)
}

export function isSenseAxis(axis) {
  return axis?.name === 'sense'
}

// A sense skill deliberately KEEPS `skill.type = 'meaning'` in the database — it still groups with
// every ordinary meaning skill for filtering/gating/practice-rule purposes (see lib/practiceRules.js,
// lib/practiceSelection.js) — and uses the `sense_type` column to record which sense, instead of
// overloading `type` with the sense key. Every consumer OUTSIDE the DB layer still addresses a skill
// by ONE string, exactly as before senses existed (e.g. "financial") — these two functions are the
// only place that translates between that single external string and the two DB columns.
//
// resolveSkillType: DB row -> external skill_type string.
export function resolveSkillType(row) {
  return row.sense_type || row.type
}

// skillDbColumns: (card, external skill_type) -> the { type, sense_type } to write/query by. Callers
// should validate the external type first (validateSkillType) — this doesn't re-check axis
// membership, it just decides which DB shape a given (card, type) pair maps to.
export function skillDbColumns(card, skillType) {
  return hasSenseAxis(card) ? { type: 'meaning', sense_type: skillType } : { type: skillType, sense_type: '' }
}

// True iff this card already carries a sense axis (has been split into >= 2 senses).
export function hasSenseAxis(card) {
  const axes = card?.details?.axes
  return Array.isArray(axes) && axes.length > 0 && isSenseAxis(axes[0])
}

// The card's sense axis values, or null if it doesn't have one yet (monosemous, still a flat
// `meaning` skill).
export function senseValues(card) {
  return hasSenseAxis(card) ? (card.details.axes[0].values ?? []) : null
}

// Word classes whose variation is grammatical/pragmatic rather than lexical — sense splitting
// never applies to these regardless of how many uses a word has (plan.md's "Exempt word classes":
// prepositions, particles, separable prefixes/affixes, function words generally). Tag-driven, same
// shape as VOCAB_TAG_RULES above — the one table to extend as new exempt classes surface, rather
// than a hardcoded word list.
const SENSE_EXEMPT_TAGS = new Set([
  'preposition',
  'particle',
  'separable-prefix',
  'affix',
  'article',
  'pronoun',
  'conjunction',
  'auxiliary',
  'modal-verb',
])

// card: { kind, tags }. Only vocabulary cards are ever sense-split (grammar/expression cards have
// no notion of "sense" in this model) — a non-vocabulary card is exempt unconditionally.
export function isSenseExempt(card) {
  if (card.kind !== 'vocabulary') return true
  const tags = card.tags ?? []
  return tags.some(t => SENSE_EXEMPT_TAGS.has(t))
}
