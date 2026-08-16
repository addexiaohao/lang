// Practice selection AND prompt content for skill practice generation — single source of truth.
// (Previously split: this file held only selection logic, lib/prompts/registry.js held all prompt
// text. That meant two separate enumerations of skill/problem types that had to be kept in sync
// by hand, enforced only by a runtime throw. Reverted — not worth the cross-file tax for content
// that's still mostly empty stubs.) lib/prompts/registry.js still owns the truly shared assembly —
// tool-call framing, card context, seed section — text that doesn't vary by problem type or skill
// type at all.
//
//   skill type   (lib/skillTypes.js's SKILL_TYPES, e.g. "gender", "plural-spelling")
//       │  SKILL_PROBLEM_TYPES[skillType] lists which problem types can drill it, a
//       │  level-dependent weight for each, and that combo's own extra prompt fragment
//       ▼
//   problem type (a way of drilling a skill, e.g. "mc_cloze", "spelling")
//       │  PROBLEM_TYPES[problemType] resolves it to a questionType + this problem type's own
//       │  full "## Task" instruction template
//       ▼
//   questionType (which Anthropic tool schema renders it — 'mc_cloze', 'spelling', or 'exemplar',
//                 see the TOOLS registry in lib/practiceGenerate.js; every problem type must map
//                 to one of these three, since those are the only schemas that exist today)
//
// getPracticeRule(skillType, level) ties it together into { problemType, questionType,
// extraPrompt } for lib/prompts/registry.js's compose() to assemble.

// ── Problem types ──────────────────────────────────────────────────────────────────────────────
// A "problem type" is a way of drilling a skill, independent of which skill it drills. `task(ctx)`
// is that problem type's FULL "## Task" instruction block — every problem type gets its own, not a
// shared base template with a footnote tacked on, so e.g. "spelling" genuinely differs from
// "mc_cloze" (no options shown, type the exact answer instead). `ctx` is `{ lang, isVocab }`
// (mc_cloze), `{ lang }` (spelling, exemplar) — see registry.js's compose() call sites for exactly
// what's passed.
export const PROBLEM_TYPES = {
  mc_cloze: {
    questionType: 'mc_cloze',
    task: ({ lang }) => `## Task
Write ONE novel ${lang} sentence testing this skill. (See the emit_mc_cloze_item tool for the exact output format.)

- Write like a native speaker actually talking or writing today — a text to a friend, a diary entry, an overheard remark, a work email. Not a textbook stub, not a sentence built to showcase grammar.
- This is a one-shot request — there is no history of prior sentences to vary against, so just pick whatever style, length, structure, and register genuinely fits: don't default to the same simple subject-verb-object shape out of habit. Use natural word order, idiomatic collocations, and real-world specificity (concrete people, places, situations) over generic filler.
- The sentence must be novel and complex enough that surrounding context supports comprehension.
- Every distractor must be genuinely plausible in the frame: wrong only along the dimension this skill tests.
- The sentence must pin down enough context that the correct answer is the ONLY option a fluent speaker would accept in that blank — if a distractor could also sound natural there, tighten the sentence (add a detail, a clause, a contrast) until it can't.`,
  },
  spelling: {
    questionType: 'spelling',
    task: ({ lang }) => `## Task
Write ONE novel ${lang} sentence with a blank where the target form belongs, plus its English meaning. (See the emit_spelling_item tool for the exact output format.)

- Write like a native speaker actually talking or writing today — a text to a friend, a diary entry, an overheard remark, a work email. Not a textbook stub, not a sentence built to showcase grammar.
- This is a one-shot request — there is no history of prior sentences to vary against, so just pick whatever style, length, structure, and register genuinely fits: don't default to the same simple subject-verb-object shape out of habit. Use natural word order, idiomatic collocations, and real-world specificity (concrete people, places, situations) over generic filler.
- The sentence must be novel and complex enough that surrounding context supports comprehension.
- \`meaning\` is the learner's ONLY hint besides the sentence — it must pin down exactly which word/form belongs in the blank (its sense, and where relevant its grammatical role, tense, or person) precisely enough that a fluent speaker could produce the exact spelling from it, but it must never leak the spelling itself.
- \`answer\` must be exactly the string the learner is expected to type: correct capitalization, umlauts/diacritics, and internal spacing if the form is multi-word. It is graded as an exact match (after trimming leading/trailing whitespace only), so get every character right.`,
  },
  exemplar: {
    questionType: 'exemplar',
    task: ({ lang }) => `## Task
Write ONE novel ${lang} sentence using the target word/lemma above, inflected as needed. (See the emit_exemplar_item tool for the exact output format.)

- The target word must be load-bearing: apply this test explicitly before answering — if it were removed or swapped for a plausible alternative, the sentence must become false, odd, or ambiguous.
- Write like a native speaker actually talking or writing today — a text to a friend, a diary entry, an overheard remark, a work email. Not a textbook stub, not a sentence built to showcase grammar.
- This is a one-shot request — there is no history of prior sentences to vary against, so just pick whatever style, length, structure, and register genuinely fits: don't default to the same simple subject-verb-object shape out of habit. Use natural word order, idiomatic collocations, and real-world specificity (concrete people, places, situations) over generic filler.
- The sentence must be novel and complex enough that surrounding context supports comprehension.`,
  },
}

// ── Skill type -> problem types ────────────────────────────────────────────────────────────────
// For each skill type: which problem types can drill it, how likely each is at a given mastery
// `level` (1-10, the skill's current `level` column), and that specific (skillType, problemType)
// combo's own extra prompt fragment — layered under a fixed "## Target skill" header (see
// registry.js's skillSection()) on top of the picked problem type's task template above.
//
// `weight(level)` values are NOT required to add up to any particular total — pickProblemType()
// below normalizes by the sum of whatever weights are present, so e.g. weights of {1, 9} and
// {10, 90} pick identically. This also doubles as a hard block: a weight of 0 (or a function that
// returns 0 for certain levels) makes that (skillType, problemType, level) combo genuinely
// unselectable, not just unlikely — see pickProblemType's <=0 filter below.
//
// Example: a skill type with `{ mc_cloze: level => 10 - level, spelling: level => level }` — at
// level 7 that's weights {mc_cloze: 3, spelling: 7} => 30%/70%; at level 1, {9, 1} => 90%/10%, i.e.
// the drill gets harder as mastery increases. Tune per skill type as real behavior is observed.
//
// PROVISIONAL, like lib/skillTypes.js's tag-rule tables — every entry below is a placeholder
// starting point (weights and prompts alike), expected to be hand-tuned over time. A skill type
// with NO entry here (or whose weights are all <=0 at the given level) has no practiceable problem
// type — api/practice.js silently substitutes a different, practiceable skill instead of erroring
// (see practiceableSkillTypes() below).
const SKILL_PROBLEM_TYPES = {
  meaning: [
    {
      problemType: 'mc_cloze', weight: () => 1, prompt: ({ cardName }) => `\
Self-check before answering: would someone who knows every other word here, but not "${cardName}", still land on the right option? If so, start over.

- "${cardName}" need not fill the blank itself — the blank can be a different word whose one correct choice hinges on what "${cardName}" means (e.g. testing "Wasser": "Ich habe seit Stunden nichts getrunken, ich muss dringend etwas ___" — trinken vs essen vs schlafen — only answerable by knowing water is for drinking).
- If "${cardName}" is a prefix/suffix/word-formation pattern (e.g. "-bar", "un-", "-los") rather than a full word: hold the base stem fixed across every option and vary only the pattern (e.g. "-bar" on "trink-": trinkbar vs getrunken vs trinkend vs trinklich), or work "${cardName.replace(/^-|-$/g, '')}" itself into the sentence as running text so the blank turns on understanding it. Never let every option carry the pattern on a different stem (trinkbar/essbar/sichtbar/hörbar) — that tests the stems, not "${cardName}".
- Distractors must be grammatically sound but wrong specifically because of "${cardName}"'s sense — not for an unrelated reason (different stem, tense, case).`
    },
    { problemType: 'exemplar', weight: () => 1, prompt: '' },
  ],
  gender: [
    {
      problemType: 'mc_cloze', weight: (level) => 1, prompt: `\
This question tests the user knows the Gender of this noun. The noun itself must never be in the blank. 

- Instead, blank out the case-marked part of speech that is forced by this noun.` },
  ],
  'plural-spelling': [
    { problemType: 'spelling', weight: () => 1, prompt: '' },
  ],
  case: [
    {
      problemType: 'mc_cloze', weight: () => 1, prompt: `\
This question tests which grammatical case this preposition governs in context — it is NEVER a test of which preposition to use.

- Keep this exact preposition fixed as ordinary running text in the sentence: it must not be the blank, and it must not appear as (or vary across) the answer options.
- Instead, blank out the case-marked article/pronoun/possessive/adjective ending of the preposition's complement.
- Every option must be a different case-marked form of that SAME complement (e.g. "den" vs. "dem" for the same masculine noun) — never a different noun, never a different preposition.
- If this is a two-way preposition (accusative for motion/direction/change of state, dative for static location/position), the sentence must unambiguously signal which one applies (e.g. a verb of movement into/onto something vs. a verb of being/remaining somewhere) so only one case-marked option is grammatical.
- If this preposition forces a case, make the correct choice as counter-intuitive as possible, while still having one unambiguous correct answer.
- Distractions must have the same meaning as the correct answer, but genuinely indicate the wrong case
- In the English translation you provide, do not indicate which answer is correct, and do not tell the user the case of options (e.g. translate "die" as "the
- instead of "the (deminine)) However, in the translation of the sentnece, do indicate the gender of the noun that also determins the answer` },
  ],
  'imperative-spelling': [
    { problemType: 'spelling', weight: () => 1, prompt: '' },
  ],
  'past-participle-spelling': [
    { problemType: 'spelling', weight: () => 1, prompt: '' },
  ],
  'present-spelling': [
    { problemType: 'spelling', weight: () => 1, prompt: '' },
  ],
  'simple-past-spelling': [
    { problemType: 'spelling', weight: () => 1, prompt: '' },
  ],
  'subjunctive-1-spelling': [
    { problemType: 'spelling', weight: () => 1, prompt: '' },
  ],
  'subjunctive-2-spelling': [
    { problemType: 'spelling', weight: () => 1, prompt: '' },
  ],
  'separated-form-understanding/recognition': [
    { problemType: 'exemplar', weight: () => 1, prompt: '' },
  ],
  production: [
    { problemType: 'mc_cloze', weight: () => 1, prompt: '' },
  ],
}

// Weighted-random pick of a { problemType, prompt } row for one skill type at a given mastery
// level. Returns null if the skill type has no rows configured, or every configured weight
// evaluates to <=0 at this level — callers treat null as "not practiceable right now".
export function pickProblemType(skillType, level = 1) {
  const table = SKILL_PROBLEM_TYPES[skillType]
  if (!table || table.length === 0) return null

  const weighted = table
    .map((row) => ({ ...row, w: row.weight(level) }))
    .filter((row) => row.w > 0)
  const total = weighted.reduce((sum, row) => sum + row.w, 0)
  if (total <= 0) return null

  let r = Math.random() * total
  for (const row of weighted) {
    r -= row.w
    if (r <= 0) return row
  }
  return weighted[weighted.length - 1] // floating-point fallback
}

// skillType: lib/skillTypes.js SKILL_TYPES member. level: the skill's current `level` (1-10,
// defaults to 1 for a never-practiced skill — see schema.sql). cardName: the target card's own
// `name`, threaded through so a row's `prompt` can name the card directly (e.g. "does the user
// know what \"dass\" means") instead of speaking generically about "this card" — a row's `prompt`
// may be a plain string (no card-specific content needed) or a `({ cardName }) => string` function
// (see SKILL_PROBLEM_TYPES' `meaning` rows for an example). Returns null when this skill type has
// no practiceable problem type right now (see pickProblemType above) — api/practice.js is
// responsible for substituting a different skill in that case, not this function.
export function getPracticeRule(skillType, level = 1, { cardName } = {}) {
  const picked = pickProblemType(skillType, level)
  if (!picked) return null
  const base = PROBLEM_TYPES[picked.problemType]
  if (!base) return null
  const extraPrompt = typeof picked.prompt === 'function' ? picked.prompt({ cardName }) : picked.prompt
  return { problemType: picked.problemType, questionType: base.questionType, extraPrompt }
}

// Skill types that have at least one problem type row configured (regardless of level — used to
// query for a substitute skill, not to pick one for a specific level). See api/practice.js.
export function practiceableSkillTypes() {
  return Object.keys(SKILL_PROBLEM_TYPES)
}

// Resolves the { problemType, questionType, extraPrompt } row for a KNOWN (skillType, problemType)
// pair, deterministically — no weighted random pick. Used only when continuing an existing
// conversation (api/practice.js's "Easier sentence" flow, lib/practiceGenerate.js's `history`
// param): re-calling getPracticeRule for the same skillType/level could legitimately pick a
// DIFFERENT problemType than the one the conversation already started with (pickProblemType is a
// weighted random draw, not stable across calls), which would silently swap the tool schema (and
// therefore `mode`) out from under an in-progress multi-turn conversation. The caller instead
// tells us which problemType this conversation already committed to (from the first turn's
// response) and we just look up its row directly. Returns null if that pair no longer exists in
// SKILL_PROBLEM_TYPES (e.g. hand-edited between requests) — the caller falls back to
// getPracticeRule and starts fresh.
export function resolvePracticeRule(skillType, problemType, { cardName } = {}) {
  const row = SKILL_PROBLEM_TYPES[skillType]?.find(r => r.problemType === problemType)
  if (!row) return null
  const base = PROBLEM_TYPES[problemType]
  if (!base) return null
  const extraPrompt = typeof row.prompt === 'function' ? row.prompt({ cardName }) : row.prompt
  return { problemType, questionType: base.questionType, extraPrompt }
}

// How many times the learner can request an easier-vocabulary regeneration of the same item
// (PracticePanel.jsx's "Easier sentence" button, api/practice.js's `easier_level`) before the
// button stops appearing. One place to tune, imported by both the route (clamps the incoming
// value) and the client (caps the click count / hides the button).
export const MAX_EASIER_SENTENCE_ATTEMPTS = 2
