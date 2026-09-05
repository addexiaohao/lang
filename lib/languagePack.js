// The LanguagePack model: skill-type taxonomy, tag→skill rules, gating edges, per-drill prompt
// prose, weight curves, sense-exempt classes, the vocabulary policy — everything lib/skillTypes.js
// and lib/practiceRules.js used to hardcode for German. See plan-language-packs.md.
//
// This module is ISOMORPHIC (no Node/Supabase imports) — the browser instantiates LanguagePack
// directly from GET /api/language-pack (src/LanguagePackContext.jsx). The server-only fetch-and-
// build helper lives in lib/resolveLanguagePack.js.
//
//   packFromSeed(seedObject)  — build from a germanSeed.js-shaped object (tests, scripts, seed --dry-run)
//   new LanguagePack({ skillTypes, drillRules, meta })  — build from already-fetched rows

import { paradigmSkillTypeValid } from './skillTypes.js'

export class LanguagePackError extends Error {}

// Every drill_rule.question_type maps to one of the three Anthropic tool schemas in
// lib/practiceGenerate.js (its `mode`). discrimination_cloze reuses the mc_cloze schema/UI —
// see lib/practiceRules.js's PROBLEM_TYPES.
const QUESTION_TYPE_MODE = {
  mc_cloze: 'mc_cloze',
  spelling: 'spelling',
  exemplar: 'exemplar',
  discrimination_cloze: 'mc_cloze',
}

// Named level→weight curves (drill_rule.weight_curve). Never user code. `flat` is the only one the
// German seed uses; `rising`/`falling` exist so a project can shift a drill's likelihood as mastery
// changes without hand-writing a function (the old SKILL_PROBLEM_TYPES `weight(level)` closures).
const WEIGHT_CURVES = {
  flat: () => 1,
  rising: (level) => clampLevel(level) / 10,
  falling: (level) => (11 - clampLevel(level)) / 10,
}
function clampLevel(level) {
  return Math.max(1, Math.min(10, Number(level) || 1))
}

// Default vocabulary policy — language-neutral wording (nothing German-specific), used when a pack
// doesn't set meta.vocabulary_policy. Identical to what the German project uses, so seeding it is
// explicit-but-redundant (makes it visible/editable) rather than a behavior change.
export const DEFAULT_VOCABULARY_POLICY = `Every word in the sentence other than the target word/form itself must be simple, common, everyday vocabulary — the kind a learner meets in their first year or two, not anything rare, technical, archaic, or literary. If the natural way to say something needs a rarer word, do not use it — write a shorter, plainer sentence instead. A simple sentence is always the right choice over a more sophisticated one.`

// plan-language-packs.md's non-negotiable floor: vocabulary always has a `meaning` skill type,
// even with zero pack rows. A pack MAY override its label/gate/importance by supplying its own
// vocabulary `meaning` row (the German seed does); this only fills the gap when it doesn't.
const MEANING_FLOOR = {
  key: 'meaning', kind: 'vocabulary', label: 'Meaning',
  applies_when: null, gate: null, importance_default: 'inherit', display_order: 0,
}

// The tiny declarative matcher (plan-language-packs.md — no nesting, no expressions). Used both for
// skill_type_def.applies_when (which cards grow this skill) and drill_rule.applies_when (which
// prompt variant a card gets). `cond` null/undefined = always matches.
export function matchApplies(cardTags, cardKind, cond) {
  if (!cond) return true
  if (cond.kind && cond.kind !== cardKind) return false
  const set = new Set(cardTags ?? [])
  if (Array.isArray(cond.any_tag) && !cond.any_tag.some((t) => set.has(t))) return false
  if (Array.isArray(cond.all_tags) && !cond.all_tags.every((t) => set.has(t))) return false
  if (cond.not?.any_tag && cond.not.any_tag.some((t) => set.has(t))) return false
  if (cond.not?.all_tags && cond.not.all_tags.length > 0 && cond.not.all_tags.every((t) => set.has(t))) return false
  return true
}

function substitutePlaceholders(text, card) {
  if (!text) return ''
  const stem = (card.name ?? '').replace(/^-|-$/g, '')
  return text.replaceAll('{cardName}', card.name ?? '').replaceAll('{cardStem}', stem)
}

function weightedPick(rows, weightFn) {
  const weighted = rows.map((r) => ({ r, w: weightFn(r) })).filter((x) => x.w > 0)
  const total = weighted.reduce((s, x) => s + x.w, 0)
  if (total <= 0) return null
  let roll = Math.random() * total
  for (const x of weighted) {
    roll -= x.w
    if (roll <= 0) return x.r
  }
  return weighted[weighted.length - 1].r
}

function withinLevel(rule, level) {
  const lvl = clampLevel(level)
  if (rule.level_floor != null && lvl < rule.level_floor) return false
  if (rule.level_ceiling != null && lvl > rule.level_ceiling) return false
  return true
}

export class LanguagePack {
  // skillTypes / drillRules: normalized row arrays (DB shape or germanSeed shape — same field
  // names). meta: { vocabulary_policy?, sense_exempt_tags? } (from projects.config.language_meta).
  constructor({ skillTypes = [], drillRules = [], meta = {} } = {}) {
    this.meta = {
      vocabulary_policy: meta.vocabulary_policy || DEFAULT_VOCABULARY_POLICY,
      sense_exempt_tags: meta.sense_exempt_tags ?? [],
    }
    this._senseExemptSet = new Set(this.meta.sense_exempt_tags)

    this.skillTypes = [...skillTypes]
    if (!this.skillTypes.some((s) => s.kind === 'vocabulary' && s.key === 'meaning')) {
      this.skillTypes.unshift({ ...MEANING_FLOOR })
    }
    this.drillRules = [...drillRules]
    this._validate()
  }

  _validate() {
    for (const d of this.drillRules) {
      if (!QUESTION_TYPE_MODE[d.question_type]) {
        throw new LanguagePackError(`drill_rule ${d.kind}/${d.skill_type_key}: unknown question_type "${d.question_type}"`)
      }
    }
    for (const s of this.skillTypes) {
      if (s.gate && !this.skillTypes.some((x) => x.kind === s.kind && x.key === s.gate.requires)) {
        throw new LanguagePackError(`skill_type_def ${s.kind}/${s.key}: gate.requires "${s.gate.requires}" is not a skill type in this pack`)
      }
    }
  }

  _defFor(kind, key) {
    return this.skillTypes.find((s) => s.kind === kind && s.key === key) ?? null
  }

  // Which skill types a newly-saved flat card should get eagerly (replaces
  // lib/skillTypes.js's deriveFlatSkillTypes). Paradigm cards get none — the caller checks
  // details.axes before calling this, same as before.
  skillTypesForCard(card) {
    return this.skillTypes
      .filter((s) => s.kind === card.kind && matchApplies(card.tags, card.kind, s.applies_when))
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
      .map((s) => s.key)
  }

  // Default skill.importance at creation (replaces deriveSkillImportance). "inherit" → the card's
  // own importance; a number → that number; no matching def → inherit.
  skillImportance(card, skillType) {
    const spec = this._defFor(card.kind, skillType)?.importance_default ?? 'inherit'
    if (typeof spec === 'number') return spec
    return card.importance ?? null
  }

  // True iff `type` is a legal skill type for `card` — structural check for paradigm/sense cards
  // (lib/skillTypes.js), pack membership for flat cards. Replaces lib/skillTypes.js's
  // validateSkillType.
  validateSkillType(card, type) {
    const structural = paradigmSkillTypeValid(card, type)
    if (structural !== null) return structural
    return this.skillTypes.some((s) => s.kind === card.kind && s.key === type)
  }

  gateFor(kind, skillType) {
    return this._defFor(kind, skillType)?.gate ?? null
  }

  // card: { kind }. skillType: the EXTERNAL type checked for eligibility. cardSkillRows: the card's
  // OTHER skill rows, DB-typed ({ type, level, state }) — a gate's `requires` names a DB type like
  // 'meaning', which every sense of a sense-split card shares. Replaces lib/skillTypes.js's
  // isGateSatisfied. Gate is on a *state* threshold (default 'stable'), not a bare level — a lapsed
  // prerequisite drops to 'learning' and stops unlocking dependents.
  isGateSatisfied(card, skillType, cardSkillRows) {
    const rule = this.gateFor(card.kind, skillType)
    if (!rule) return true
    const wantState = rule.state ?? 'stable'
    return (cardSkillRows ?? []).some(
      (row) => row.type === rule.requires && row.level != null && row.level >= rule.min_level && row.state === wantState
    )
  }

  // Word classes whose variation is grammatical/pragmatic, not lexical — never sense-split.
  // Replaces lib/skillTypes.js's isSenseExempt.
  isSenseExempt(card) {
    if (card.kind !== 'vocabulary') return true
    return (card.tags ?? []).some((t) => this._senseExemptSet.has(t))
  }

  // Skill type keys that have at least one enabled drill rule — the pool api/practice.js's
  // pickSubstituteSkill draws from. Replaces lib/practiceRules.js's practiceableSkillTypes().
  practiceableSkillTypes() {
    return [...new Set(this.drillRules.filter((d) => d.enabled).map((d) => d.skill_type_key))]
  }

  _materialize(rule, card) {
    return {
      questionType: QUESTION_TYPE_MODE[rule.question_type],
      problemType: rule.question_type,
      extraPrompt: substitutePlaceholders(rule.prompt, card),
      requireFrame: !!rule.require_frame,
    }
  }

  // Weighted pick of a drill rule for (card, skillType) at a mastery `level`. Filters by
  // kind/skillType/enabled/level-window/applies_when, keeps the highest-priority tier, then samples
  // that tier by weight curve. Returns { questionType, problemType, extraPrompt, requireFrame } or
  // null ("nothing practiceable" — api/practice.js substitutes a different skill). Replaces
  // lib/practiceRules.js's getPracticeRule + pickProblemType.
  drillRuleFor(card, skillType, level = 1) {
    const cands = this.drillRules.filter(
      (d) =>
        d.kind === card.kind &&
        d.skill_type_key === skillType &&
        d.enabled &&
        withinLevel(d, level) &&
        matchApplies(card.tags, card.kind, d.applies_when)
    )
    if (cands.length === 0) return null
    const maxPriority = Math.max(...cands.map((d) => d.priority ?? 0))
    const top = cands.filter((d) => (d.priority ?? 0) === maxPriority)
    const picked = weightedPick(top, (d) => (WEIGHT_CURVES[d.weight_curve] ?? WEIGHT_CURVES.flat)(level))
    return picked ? this._materialize(picked, card) : null
  }

  // Deterministic lookup of a KNOWN (skillType, questionType) rule — for continuing an existing
  // "Easier sentence" conversation without re-rolling drillRuleFor's weighted pick (which could
  // swap the tool schema mid-conversation). Highest-priority matching rule wins. Returns null if
  // that pair no longer exists (hand-edited between requests) — caller falls back to drillRuleFor.
  // Replaces lib/practiceRules.js's resolvePracticeRule.
  resolveDrillRule(card, skillType, questionType) {
    const cands = this.drillRules
      .filter(
        (d) =>
          d.kind === card.kind &&
          d.skill_type_key === skillType &&
          d.question_type === questionType &&
          d.enabled &&
          matchApplies(card.tags, card.kind, d.applies_when)
      )
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    return cands.length ? this._materialize(cands[0], card) : null
  }

  // Skill type keys for a kind, in display order — used to sort a card's skill list in the UI
  // (CardDetailPanel) regardless of whether each type currently applies to that specific card.
  skillTypeKeysForKind(kind) {
    return this.skillTypes
      .filter((s) => s.kind === kind)
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
      .map((s) => s.key)
  }

  vocabularyPolicyText() {
    return this.meta.vocabulary_policy
  }
}

// germanSeed.js-shaped object → LanguagePack. `seed.skill_types` / `seed.drill_rules` already use
// the DB field names, so this is mostly a passthrough.
export function packFromSeed(seed) {
  return new LanguagePack({
    skillTypes: seed.skill_types ?? [],
    drillRules: (seed.drill_rules ?? []).map((d) => ({
      priority: 0, enabled: true, weight_curve: 'flat', require_frame: false, applies_when: null, prompt: '',
      ...d,
    })),
    meta: {
      vocabulary_policy: seed.meta?.vocabulary_policy,
      sense_exempt_tags: seed.meta?.sense_exempt_tags,
    },
  })
}

// resolveLanguagePack (server-only, needs Supabase) lives in lib/resolveLanguagePack.js so this
// module stays isomorphic — the browser imports LanguagePack from here directly.
