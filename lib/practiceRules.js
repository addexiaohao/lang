// Practice PROBLEM TYPES — the language-agnostic half of practice generation. A "problem type" is
// a way of drilling a skill (mc_cloze / spelling / exemplar / discrimination_cloze); each owns its
// full "## Task" instruction block and maps to one of the three Anthropic tool schemas
// (`questionType`, see lib/practiceGenerate.js). This is core and shared across every language.
//
// The language-SPECIFIC half — which problem types drill which skill type, at what level weight,
// with what extra prompt prose, and whether a `frame` is required — used to live here as
// SKILL_PROBLEM_TYPES. It's now per-project user-authored config (skill_type_def / drill_rule),
// resolved by lib/languagePack.js. getPracticeRule / resolvePracticeRule / pickProblemType /
// practiceableSkillTypes are now LanguagePack.drillRuleFor / .resolveDrillRule /
// .practiceableSkillTypes. See plan-language-packs.md.
//
// lib/prompts/registry.js's compose() calls PROBLEM_TYPES[problemType].task() for the task section
// and folds the pack's resolved extraPrompt into a "## Target skill" header via skillSection().

// `task(ctx)` is a problem type's FULL "## Task" block — every problem type gets its own, not a
// shared base with a footnote, so e.g. "spelling" genuinely differs from "mc_cloze". `ctx` is
// `{ lang, isVocab }` (mc_cloze), `{ lang }` (spelling, exemplar) — see registry.js's compose()
// call sites.
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
    task: ({ lang, cardName }) => `## Task
Write ONE novel ${lang} sentence using the target word/lemma above${cardName ? ` ("${cardName}")` : ''}, inflected as needed. (See the emit_exemplar_item tool for the exact output format.)

- The target word must be load-bearing: apply this test explicitly before answering — if it were removed or swapped for a plausible alternative, the sentence must become false, odd, or ambiguous.
- The sentence must be novel and complex enough that surrounding context supports comprehension.
- The ⟦⟧ marker pair MUST wrap the inflected form of ${cardName ? `"${cardName}"` : 'the target word/lemma'} and nothing else — never a seed word, a proper name, or any other noun that happens to sit nearby. Before you answer, re-read the text between your ⟦ and ⟧ and confirm it is an inflected form of ${cardName ? `"${cardName}"` : 'the target lemma'}, not a different word.`,
  },
  // Card Groups (plan.md) — a discrimination cloze between the target card and the OTHER members of
  // a group it belongs to. Reuses the plain mc_cloze tool schema/UI unchanged; the only difference
  // is WHERE the distractors come from — the group's other members, named in extraPrompt by
  // buildDiscriminationRule() below (api/practice.js builds that from live group membership). Not a
  // drill_rule in the language pack: its prompt is dynamic, so it stays code.
  discrimination_cloze: {
    questionType: 'mc_cloze',
    task: ({ lang }) => `## Task
Write ONE novel ${lang} sentence that tests the learner's ability to pick the right one of several confusable words — see "## Target skill" below for exactly which words and how they differ. (See the emit_mc_cloze_item tool for the exact output format.)

- Do NOT invent your own distractors. \`options\` must consist of EXACTLY the words named under "## Target skill" below — the target card's own word/form plus each of the other confusable words, each correctly inflected for this exact sentence — and no others.
- Construct the sentence so that, of those exact words, ONLY the target card's own word/form is correct in the blank — every other named word must be clearly, specifically wrong there (not just less natural).
- The sentence must be novel and complex enough that surrounding context supports comprehension.`,
  },
}

// Builds the discrimination-cloze rule (Card Groups) — the one place group membership data
// (fetched by api/practice.js) turns into prompt text naming the other members. `otherMembers` is
// [{ name, note }] (the group's OTHER cards); `groupNote` is the group's shared-axis note. Returns
// null if `otherMembers` is empty. Shape matches LanguagePack._materialize()'s output so
// api/practice.js can treat it interchangeably with a resolved drill rule.
export function buildDiscriminationRule({ cardName, groupNote, otherMembers }) {
  if (!otherMembers || otherMembers.length === 0) return null
  const base = PROBLEM_TYPES.discrimination_cloze
  const otherNames = otherMembers.map(m => m.name).join(', ')
  const lines = [`The words being discriminated: "${cardName}" (the target — the one correct answer here) vs. ${otherNames}.`]
  if (groupNote) lines.push(`Shared axis of comparison: ${groupNote}`)
  const memberNotes = otherMembers.filter(m => m.note).map(m => `- ${m.name}: ${m.note}`)
  if (memberNotes.length > 0) lines.push(`What distinguishes each:\n${memberNotes.join('\n')}`)
  return {
    problemType: 'discrimination_cloze',
    questionType: base.questionType,
    extraPrompt: lines.join('\n\n'),
    requireFrame: false,
  }
}

// How many times the learner can request an easier-vocabulary regeneration of the same item
// (PracticePanel.jsx's "Easier sentence" button, api/practice.js's `easier_level`) before the
// button stops appearing. Imported by both the route (clamps the incoming value) and the client
// (caps the click count / hides the button).
export const MAX_EASIER_SENTENCE_ATTEMPTS = 2
