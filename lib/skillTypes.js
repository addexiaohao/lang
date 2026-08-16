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
// importance (1-10, possibly null) — the variable each type's formula above can use.
export function deriveSkillImportance(kind, type, cardImportance) {
  const fn = DEFAULT_SKILL_IMPORTANCE[kind]?.[type]
  return fn ? fn(cardImportance) : cardImportance
}

// Which skill types a newly-saved flat card (no details.axes) should get eagerly, level = 1.
// Paradigm cards get none eagerly — see schema.sql's skill table comment.
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

// card: { kind, details }. Paradigm cards (details.axes present) validate `type` as a dotted path
// with one segment per axis, each segment a legal value for that axis. Flat cards validate `type`
// against SKILL_TYPES[kind].
export function validateSkillType(card, type) {
  const axes = card.details?.axes
  if (Array.isArray(axes) && axes.length > 0) {
    const segments = type.split('.')
    if (segments.length !== axes.length) return false
    return axes.every((axis, i) => Array.isArray(axis.values) && axis.values.includes(segments[i]))
  }
  const legal = SKILL_TYPES[card.kind] ?? []
  return legal.includes(type)
}
