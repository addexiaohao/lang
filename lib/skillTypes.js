// Core, language-agnostic skill helpers: paradigm/sense axis readers, the DB<->external skill_type
// translation, and structural validation of a paradigm card's dotted-path skill types.
//
// Everything language-SPECIFIC that used to live here — the SKILL_TYPES registry, the
// tag->skill-type rules (VOCAB_TAG_RULES), gating edges (SKILL_GATES), default-importance formulas
// (DEFAULT_SKILL_IMPORTANCE), and the sense-exempt word classes (SENSE_EXEMPT_TAGS) — is now
// per-project, user-authored config resolved by lib/languagePack.js from the skill_type_def /
// drill_rule tables. See plan-language-packs.md. The functions that consumed those constants
// (deriveFlatSkillTypes, deriveSkillImportance, isGateSatisfied, isSenseExempt, validateSkillType)
// are now methods on the resolved LanguagePack.

// Canonical cell key derivation for paradigm axis_values, shared by the frontend's axes-grid
// preview and any per-cell write path. Axis names sorted alphabetically, values
// lowercased/slugified, joined with "-".
export function deriveCellKey(axisValues) {
  return Object.keys(axisValues)
    .sort()
    .map(k => String(axisValues[k]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .join('-')
}

// ── Paradigm / word-sense axes ────────────────────────────────────────────────────────────────
// A polysemous word is a card with a one-dimensional paradigm: a single axis named "sense" whose
// values are objects (not bare strings, unlike every other paradigm axis) so each sense can carry
// a `gloss` (and, once encountered, an `example` excerpt) alongside its `key`. The three
// axisValue* readers below are the one place that reads an axis value's shape, so declension grids
// (plain string values) and sense axes (object values) share the same code with no kind check.

// The dotted-path skill type segment for an axis value — a sense axis's skill types ARE its axis
// values' keys (e.g. "seating", "financial"), same as any other paradigm axis's values.
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

// Structural validity of a skill `type` for a card that IS a paradigm (details.axes present): a
// dotted path with one segment per axis, each segment a legal value key for that axis. Returns
// true/false for a paradigm card, or `null` for a flat card — meaning "not a structural question,
// the language pack decides" (see lib/languagePack.js's validateSkillType).
export function paradigmSkillTypeValid(card, type) {
  const axes = card?.details?.axes
  if (!Array.isArray(axes) || axes.length === 0) return null
  const segments = type.split('.')
  if (segments.length !== axes.length) return false
  return axes.every((axis, i) => Array.isArray(axis.values) && axis.values.some(v => axisValueKey(v) === segments[i]))
}

// ── DB <-> external skill_type translation ────────────────────────────────────────────────────
// A sense skill deliberately KEEPS `skill.type = 'meaning'` in the database — it groups with every
// ordinary meaning skill for filtering/gating/practice-rule purposes — and uses the `sense_type`
// column to record which sense. Every consumer OUTSIDE the DB layer addresses a skill by ONE
// external string (e.g. "financial"); these two functions are the only translation point.

// DB row -> external skill_type string.
export function resolveSkillType(row) {
  return row.sense_type || row.type
}

// (card, external skill_type) -> the { type, sense_type } to write/query by. Validate the external
// type first (LanguagePack.validateSkillType) — this only decides which DB shape a (card, type)
// pair maps to.
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
