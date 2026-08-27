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

- The sentence must be novel and complex enough that surrounding context supports comprehension.
- Every distractor must be genuinely plausible in the frame: wrong only along the dimension this skill tests.
- The sentence must pin down enough context that the correct answer is the ONLY option a fluent speaker would accept in that blank — if a distractor could also sound natural there, tighten the sentence (add a detail, a clause, a contrast) until it can't.
- Before finalizing, self-check every distractor: can you state, in one line, exactly what makes it false, odd, or ungrammatical in this exact sentence? If not, it is not a valid distractor — swap it for one you can defend. Report that line per distractor in \`distractor_reasons\`.`,
  },
  spelling: {
    questionType: 'spelling',
    task: ({ lang }) => `## Task
Write ONE novel ${lang} sentence with a blank where the target form belongs, plus its English meaning. (See the emit_spelling_item tool for the exact output format.)

- The sentence must be novel and complex enough that surrounding context supports comprehension.
- The sentence itself must force the exact grammatical form the blank needs — person, number, tense, mood, case, whatever this skill tests. Put the subject, tense markers, agreement triggers and any other cues into the sentence so that a fluent speaker has exactly one possible form to write there.
- \`meaning\` identifies only the LEXICAL item — the lemma and its sense — precisely enough to know which word belongs in the blank, and nothing about its inflection. Never name the grammatical form the blank wants (do NOT write "third-person plural present tense", "past participle", "dative plural", etc.) — the sentence, not \`meaning\`, is what tells the learner which form to produce. \`meaning\` must also never leak the spelling itself.
- \`answer\` must be exactly the string the learner is expected to type: correct capitalization, umlauts/diacritics, and internal spacing if the form is multi-word. It is graded as an exact match (after trimming leading/trailing whitespace only), so get every character right.`,
  },
  exemplar: {
    questionType: 'exemplar',
    task: ({ lang }) => `## Task
Write ONE novel ${lang} sentence using the target word/lemma above, inflected as needed. (See the emit_exemplar_item tool for the exact output format.)

- The target word must be load-bearing: apply this test explicitly before answering — if it were removed or swapped for a plausible alternative, the sentence must become false, odd, or ambiguous.
- The sentence must be novel and complex enough that surrounding context supports comprehension.`,
  },
  // Card Groups (plan.md) — a discrimination cloze between the target card and the OTHER members
  // of a group it belongs to (wissen/kennen, legen/stellen/setzen). Reuses the plain mc_cloze tool
  // schema/UI unchanged (still `emit_mc_cloze_item`, still rendered by PracticeMcCloze.jsx) — the
  // only thing that differs is WHERE the distractors come from: not the model's own invention, but
  // the group's other members, named explicitly in extraPrompt (api/practice.js builds that from
  // the card's actual group membership at generation time). This is the whole point of the feature
  // — distractor plausibility guaranteed by construction (real confusable words the user themselves
  // flagged), rather than by prompt instruction alone, which is the hardest constraint an ordinary
  // mc_cloze item has to satisfy.
  discrimination_cloze: {
    questionType: 'mc_cloze',
    task: ({ lang }) => `## Task
Write ONE novel ${lang} sentence that tests the learner's ability to pick the right one of several confusable words — see "## Target skill" below for exactly which words and how they differ. (See the emit_mc_cloze_item tool for the exact output format.)

- Do NOT invent your own distractors. \`options\` must consist of EXACTLY the words named under "## Target skill" below — the target card's own word/form plus each of the other confusable words, each correctly inflected for this exact sentence — and no others.
- Construct the sentence so that, of those exact words, ONLY the target card's own word/form is correct in the blank — every other named word must be clearly, specifically wrong there (not just less natural).
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

- Near-synonyms are the most common way this self-check silently fails — words close enough in sense (Ferien/Urlaub/Freizeit, gleich/bald/manchmal, Garten/Zimmer/Keller, neu/alt/blau) that a generic frame ("Die Kinder freuen sich auf die ___") leaves several of them equally acceptable. Before finalizing, name IN THE SENTENCE one concrete, checkable detail — a specific consequence, a number/duration, a named contrast, a cause that only follows from THIS word's precise sense — that a fluent speaker would use to rule out every distractor individually. If you can't point to that detail in the sentence you wrote, add it or pick a less generic frame.
- "${cardName}" need not fill the blank itself — the blank can be a different word whose one correct choice hinges on what "${cardName}" means (e.g. testing "Wasser": "Ich habe seit Stunden nichts getrunken, ich muss dringend etwas ___" — trinken vs essen vs schlafen — only answerable by knowing water is for drinking).
- If "${cardName}" is a prefix/suffix/word-formation pattern (e.g. "-bar", "un-", "-los") rather than a full word: hold the base stem fixed across every option and vary only the pattern (e.g. "-bar" on "trink-": trinkbar vs getrunken vs trinkend vs trinklich), or work "${cardName.replace(/^-|-$/g, '')}" itself into the sentence as running text so the blank turns on understanding it. Never let every option carry the pattern on a different stem (trinkbar/essbar/sichtbar/hörbar) — that tests the stems, not "${cardName}".
- Distractors must be grammatically sound but wrong specifically because of "${cardName}"'s sense — not for an unrelated reason (different stem, tense, case).
- Every added clause must be logically consistent with the rest of the sentence, not just individually plausible — don't bolt on a causal/temporal clause purely to add complexity if it ends up contradicting the main clause (e.g. giving a reason that couldn't actually cause the stated result).`
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

- Before writing the sentence, pick a verb/noun/scenario where THIS EXACT preposition is the obviously correct, idiomatic choice — not one where a different preposition would actually fit better or equally well (e.g. "bei" names presence alongside someone/something static; it is NOT how German expresses a sound's source (use "von") or the topic of speech (use "über"/"mit")). If you can't confidently defend that this preposition, and no other, belongs here, pick a different noun/scenario before proceeding — a wrong-preposition sentence fails this check even when the case-marking itself is perfect.
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
    {
      problemType: 'mc_cloze', weight: () => 1, prompt: ({ cardName, cardTags }) => {
        // Not every `production` card is about which preposition/conjunction to use (see
        // SKILL_TYPES.grammar — 'production' is grammar's only flat type) — the frame-first
        // instructions below only make sense, and are only forced (see lib/practiceValidation.js's
        // `frame` requirement), for cards tagged `production-which-preposition` or
        // `production-which-conjunction` (see tests/fixtures/cards.js).
        if (cardTags?.includes('production-which-preposition')) return `\
This question tests PRODUCTION of the preposition named at the start of "${cardName}" (the lemma before " + ") — which preposition a specific verb/construction genuinely governs in that exact use-case — not recognition, and not which case it takes (a separate skill, "case").

Build the item in this order, not sentence-first:
1. Pick ONE specific verb, adjective, or fixed construction that genuinely, idiomatically governs this exact preposition in this exact use-case (e.g. for "an": denken an, sich erinnern an, sich lehnen an — real, dictionary-attested verb/adjective-preposition pairings, never one you're merely guessing could take it).
2. State that choice, verbatim as it will appear in the sentence, in \`frame\` — BEFORE writing the sentence.
3. Build the sentence around that frame. Never write the sentence first and bolt a preposition onto it afterward.

- Blank out ONLY the preposition. The rest of the frame (the verb/construction named in \`frame\`) stays fixed as ordinary running text in the sentence.
- Watch for near-synonym prepositions (von/aus, nach/zu, an/auf) especially — many verbs genuinely tolerate more than one of these with only a nuance difference (e.g. "abfahren" accepts both "von" and "aus" a departure city). A frame like that is NOT valid here: pick a frame where dictionaries/grammar references mark exactly ONE of the candidate prepositions as correct and the others as outright wrong, not just less common (e.g. "stammen aus" never "stammen von" for origin; "sich freuen auf" never "sich freuen zu" for an upcoming event).
- Every distractor must be a different preposition that this exact frame, in this exact sentence, genuinely rejects — not just a less natural choice. Per the base task's self-check: if you can't state why this frame rules out a candidate preposition, it isn't a valid distractor for this item.`

        if (cardTags?.includes('production-which-conjunction')) return `\
This question tests PRODUCTION of the conjunction named by "${cardName}" — which conjunction a specific relationship between two clauses genuinely calls for — not recognition of its meaning in isolation.

Build the item in this order, not sentence-first:
1. Pick ONE specific temporal/causal/concessive/conditional relationship between two concrete events that ONLY "${cardName}" expresses correctly (e.g. for "als": one single, specific past occasion — never a repeated or habitual one, which needs "wenn"; for "nachdem": a completed event strictly before another, usually forcing a tense shift (Plusquamperfekt → Präteritum/Perfekt) between the two clauses — that tense shift is itself evidence nothing else fits; for "obwohl": a real, stated conflict where the expected outcome does NOT happen).
2. State that relationship, in one line, in \`frame\` — BEFORE writing the sentence (e.g. "a single past occasion, not habitual — rules out wenn").
3. Build the sentence around that relationship, choosing tenses and details that make it concrete and singular (a specific date, an unrepeatable event, an explicit result) — vague, generic clauses ("Es regnete, ___ ich nach Hause kam") are exactly what makes als/wenn/während/nachdem/weil/obwohl all sound equally fine; a story-like connector sentence with no such anchor is not acceptable here.
- Every distractor conjunction must be one that a fluent speaker would reject outright for the relationship you named in \`frame\`, not just consider less elegant. Temporal conjunctions (als/wenn/während/nachdem/bevor) and causal/concessive ones (weil/obwohl/da) are notoriously interchangeable in underspecified sentences — if you can't point to the specific word/tense/detail in your sentence that rules a candidate out, it isn't a valid distractor.`

        return ''
      },
    },
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
// may be a plain string (no card-specific content needed) or a `({ cardName, cardTags }) => string`
// function (see SKILL_PROBLEM_TYPES' `meaning` rows for an example). cardTags: the card's own
// `tags` array, threaded through so a row's `prompt` can branch on a specific tag (e.g.
// `production`'s row only emits its preposition-frame instructions when the card carries
// `production-which-preposition` — a `production` card need not be about a preposition at all).
// Returns null when this skill type has no practiceable problem type right now (see
// pickProblemType above) — api/practice.js is responsible for substituting a different skill in
// that case, not this function.
export function getPracticeRule(skillType, level = 1, { cardName, cardTags } = {}) {
  const picked = pickProblemType(skillType, level)
  if (!picked) return null
  const base = PROBLEM_TYPES[picked.problemType]
  if (!base) return null
  const extraPrompt = typeof picked.prompt === 'function' ? picked.prompt({ cardName, cardTags }) : picked.prompt
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
export function resolvePracticeRule(skillType, problemType, { cardName, cardTags } = {}) {
  const row = SKILL_PROBLEM_TYPES[skillType]?.find(r => r.problemType === problemType)
  if (!row) return null
  const base = PROBLEM_TYPES[problemType]
  if (!base) return null
  const extraPrompt = typeof row.prompt === 'function' ? row.prompt({ cardName, cardTags }) : row.prompt
  return { problemType, questionType: base.questionType, extraPrompt }
}

// Builds the { problemType, questionType, extraPrompt } rule for a discrimination cloze (Card
// Groups, see PROBLEM_TYPES.discrimination_cloze above) — the one place group membership data
// (fetched by api/practice.js, which this file has no DB access to) turns into the actual prompt
// text naming the other members. `otherMembers` is [{ name, note }], the group's OTHER cards (not
// including the one being drilled); `groupNote` is the group's own shared-axis note, either can be
// null/empty. Returns null if `otherMembers` is empty — nothing to discriminate against.
export function buildDiscriminationRule({ cardName, groupNote, otherMembers }) {
  if (!otherMembers || otherMembers.length === 0) return null
  const base = PROBLEM_TYPES.discrimination_cloze
  const otherNames = otherMembers.map(m => m.name).join(', ')
  const lines = [`The words being discriminated: "${cardName}" (the target — the one correct answer here) vs. ${otherNames}.`]
  if (groupNote) lines.push(`Shared axis of comparison: ${groupNote}`)
  const memberNotes = otherMembers.filter(m => m.note).map(m => `- ${m.name}: ${m.note}`)
  if (memberNotes.length > 0) lines.push(`What distinguishes each:\n${memberNotes.join('\n')}`)
  return { problemType: 'discrimination_cloze', questionType: base.questionType, extraPrompt: lines.join('\n\n') }
}

// How many times the learner can request an easier-vocabulary regeneration of the same item
// (PracticePanel.jsx's "Easier sentence" button, api/practice.js's `easier_level`) before the
// button stops appearing. One place to tune, imported by both the route (clamps the incoming
// value) and the client (caps the click count / hides the button).
export const MAX_EASIER_SENTENCE_ATTEMPTS = 2
