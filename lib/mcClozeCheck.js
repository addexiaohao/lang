// Answer-uniqueness check for generated mc_cloze items — beyond validatePracticeItem's mechanical
// checks (one blank, options unique, answer in options), this asks a small/cheap model to judge
// each option filled into the blank, one sentence per option, one independent conversation per
// sentence (so the judge can't see the other options and rationalize). The forced tool call keeps
// its verdict machine-parsable by construction (two booleans), plus a required `reason` string on
// every call — a brief confirmation on a pass, a real explanation of what's wrong on a fail — so a
// flagged sentence is never logged without an explanation of why, and the model can't drift into
// free-form chain-of-thought inside that field either (the schema and prompt both insist on a
// single settled verdict, not an in-progress deliberation).
//
// Pass condition is checked in both directions, with equal rigor, via the same per-option
// isolated judgment call and the same three criteria for both — "grammatical AND sensible AND
// matches_meaning" — nothing about the "correct" option is assumed or skipped:
//   - the correct answer's sentence must independently come back grammatical AND sensible AND a
//     match for the item's own `translation` — it is judged exactly like every distractor, not
//     waved through because the generator labeled it correct
//   - every distractor's sentence must NOT come back grammatical AND sensible AND matching that
//     same translation all at once — it's fine for a distractor to be wrong for any reason
//     (ungrammatical, grammatical-but-nonsensical, or — the case `matches_meaning` exists for —
//     perfectly natural but expressing a clearly DIFFERENT meaning, e.g. "vor" (ago) filled into a
//     sentence whose target meaning was "in" (within a timeframe): both are fine standalone German,
//     but only one means what the exercise is asking for) as long as it's wrong SOMEHOW. A
//     distractor only fails the check if a fluent speaker, given the target meaning, would say this
//     option ALSO correctly expresses it — i.e. it's a real alternative answer, which means the
//     "correct" answer isn't actually unique.
// `matches_meaning` is what lets a cluster of individually-natural near-synonyms (prepositions,
// conjunctions, etc.) work as valid distractors at all: `sensible` alone can't tell "genuinely valid
// alternative" apart from "natural sentence, wrong meaning" — grounding the checker in the item's
// own `translation` (rather than asking it to guess which reading was "intended") answers that
// directly instead of heuristically. See lib/practiceRules.js / lib/languagePacks/germanSeed.js's
// production-which-preposition/conjunction rules, which now show `translation` to the learner
// before they answer for exactly this reason (PracticeMcCloze.jsx's `revealTranslation`).
// Used by lib/practiceGenerate.js, which retries generation (same as any other
// PracticeValidationError) when any of the three checks fails.

export const DEFAULT_CHECK_MODEL = 'claude-sonnet-4-6'

const CHECK_TOOL = {
  name: 'emit_sentence_check',
  description: 'Judge one sentence for grammatical correctness and whether it makes sense.',
  input_schema: {
    type: 'object',
    properties: {
      grammatical: { type: 'boolean', description: 'True only if the sentence is fully grammatically correct as written (case, gender, agreement, word order, conjugation, etc.) — any error, however small, makes this false.' },
      sensible: { type: 'boolean', description: 'True only if the sentence is fully coherent: plausible, logically consistent, internally consistent in its own timeline/tense reference (not just each clause plausible in isolation), AND natural in its tense/aspect choices across clauses — not merely grammatically legal. False for a sentence that is individually well-formed per clause but contradicts itself as a whole — e.g. describing a repeated past event with a present-perfect-style framing ("I have already seen X three times") and then, in the same breath, treating "the next occurrence" as if it too already happened and was evaluated, which only a stricter, temporally-consistent phrasing would properly support. Also false for a sentence whose clauses mix two past tenses/aspects (e.g. simple past and present-perfect, or German Präteritum and Perfekt) in a way that is grammatically permitted but would read as inconsistent to a native speaker, with no discourse reason for the shift — e.g. "Er konnte sie nicht überzeugen, und sie hat die Meinung ihrer Schwester geteilt" mixes Präteritum and Perfekt across two clauses describing the same past situation for no reason; a native speaker keeps both in one tense ("...und sie teilte..." or "...und sie hat...geteilt", not one of each). A tense/aspect shift IS fine when it serves a real function — e.g. one clause narrates a single past event while another describes a state persisting to now — so judge whether THIS shift is motivated, not whether two different tenses merely co-occur in the sentence. Also false when a verb was given a real, grammatical case/preposition frame that carries a DIFFERENT meaning than the sentence is clearly trying to express — grammatical validity of some reading is not enough if that reading is not the intended one. E.g. German "gehören" + dative means "is owned by," not "belongs in/at the right place for": "Dieses Tier gehört dem Gehege im Zoo" is grammatical and parses (the enclosure owns the animal), but that is an implausible claim and clearly not what the sentence means to say (that the animal belongs IN the enclosure) — the correct construction for that meaning is "gehören" + "in" + accusative ("gehört ins Gehege"). Judge the sentence\'s actual literal meaning under the frame it used, not the frame you assume was intended — if that literal meaning is an odd or implausible claim, mark it not sensible even though every word is inflected correctly. Watch the OPPOSITE mistake too, specifically for connectors/conjunctions expressing a logical relation between clauses (temporal, causal, concessive, conditional, adversative, etc. — "nachdem"/"obwohl"/"weil"/"wenn"/"während"/"bevor" or English "after"/"although"/"because"/"if"/"while"/"before"): do not mark such a sentence not-sensible just because its relation feels like it probably was not the one an exercise-writer intended. You are never told what was intended and must not guess at it — judge PURELY whether the relation this exact word asserts holds up as an unremarkable, natural claim on its own, with no outside context. E.g. "Obwohl sie gegessen hatte, merkte sie, dass sie noch Hunger hatte" ("Although she had eaten, she noticed she was still hungry") is a completely ordinary, natural thing to say — sensible: true — even if a "nachdem" (temporal) reading of the same two clauses was the one actually being tested; being usable with more than one connector doesn\'t make either reading less sensible, it just means this pair of clauses is a bad choice for testing that connector, which is exactly the failure this check exists to surface. Judge \`sensible\` independently of \`grammatical\` — a grammatically broken sentence can still be sensible, and vice versa.' },
      matches_meaning: { type: 'boolean', description: 'True only if THIS EXACT sentence conveys the SAME meaning as the target English meaning you were given — not merely a plausible meaning, not just similar in topic, not just compatible with it. A sentence can be perfectly grammatical and fully sensible on its own while still expressing a clearly DIFFERENT meaning than the target — e.g. target meaning "it took three years" (a duration within which something was completed) vs. a sentence that actually says "three years ago": both are completely natural, well-formed German, but only one of them means what the target says, so the "three years ago" one must get matches_meaning: false. Judge the MEANING, not the exact English wording — do not fail this over a looser paraphrase or a synonym that preserves the same meaning as the target. Judge this independently of grammatical/sensible: a sentence can fail matches_meaning while being perfectly grammatical and sensible under its own (different, unintended) meaning, and a sentence with a small grammar slip can still intend the right meaning.' },
      reason: { type: 'string', minLength: 1, description: 'Always required and NEVER empty, in ENGLISH. If grammatical, sensible, AND matches_meaning are ALL true: a brief confirmation only, e.g. "Correct." — do not justify or elaborate on a pass. If any of the three is false: one short sentence pinpointing exactly what is wrong (e.g. "wrong case: should be dative \'dem\' not accusative \'den\'", or "means \'three years ago\', not the target \'within three years\'") — quote the offending word/phrase from the sentence verbatim, but write the explanation itself in English regardless of the sentence\'s language. Commit to a final verdict — do not think out loud or second-guess yourself in this field; if you reconsider mid-explanation, make sure `grammatical`/`sensible`/`matches_meaning` reflect your FINAL judgment, not an earlier one.' },
    },
    required: ['grammatical', 'sensible', 'matches_meaning', 'reason'],
  },
}

function checkSystemPrompt(lang) {
  return `You are a strict ${lang} grammar and coherence checker. You will be given a target English meaning and one ${lang} sentence. Judge the sentence on three independent dimensions and respond ONLY by calling the emit_sentence_check tool — no other text.

Be strict on \`sensible\`: judge the sentence ENTIRELY ON ITS OWN, with no reference to the target meaning at all — that comparison is \`matches_meaning\`'s job, not this one. Read the whole sentence as one coherent statement, not clause-by-clause — a sentence whose individual clauses are each plausible but which contradicts itself as a whole (e.g. mixed/inconsistent tense reference implying impossible timeline) is NOT sensible, and neither is one where clauses mix two past tenses/aspects for no discourse reason even though each clause is individually grammatical (an unmotivated mix, not merely two different tenses appearing anywhere in the sentence — a shift that serves a real function, like one clause narrating a single past event and another describing a state persisting to now, is fine). Also not sensible: a verb used under a real, grammatical case/preposition frame whose actual meaning under that frame is a different, often implausible claim from what the sentence is clearly trying to say (e.g. German "gehören" + dative = "is owned by," not "belongs in/at" — "Dieses Tier gehört dem Gehege" grammatically claims the enclosure owns the animal, which is not sensible, rather than saying the animal belongs in the enclosure, which needs "gehört ins Gehege"). Judge the sentence's actual literal meaning under the frame it used, not the frame you assume was meant. But watch the opposite mistake for connectors/conjunctions (temporal, causal, concessive, conditional, adversative — "nachdem"/"obwohl"/"weil"/"wenn" or English "after"/"although"/"because"/"if"): a sentence remaining natural under more than one connector doesn't make either reading not-sensible on its own — it just means \`matches_meaning\` is the dimension that will (correctly) reject the wrong one.

Be equally strict on \`matches_meaning\`, in the opposite direction: this is the ONLY dimension that compares against the given target meaning, and it must do so precisely. A sentence that is completely natural and sensible in isolation can still fail this — e.g. target "within three years" vs. a sentence that actually says "three years ago": both are fine standalone German, but only one means what the target says, so the other is matches_meaning: false even though grammatical and sensible are both true. Do not fail it over a looser paraphrase or synonym that preserves the SAME meaning as the target — you're judging meaning, not exact wording.

Always include a \`reason\`, written in English (you may quote the ${lang} sentence/words it refers to verbatim) — never write the reason itself in ${lang}. Do your reasoning BEFORE deciding \`grammatical\`/\`sensible\`/\`matches_meaning\`, not after: \`reason\` must state your final verdict, not an in-progress deliberation that ends up disagreeing with the booleans you report.`
}

// Fills the sentence's single "___" blank with one option — same blank convention mc_cloze items
// use (validatePracticeItem enforces exactly one).
export function fillBlank(sentence, option) {
  return sentence.replace('___', option)
}

// One judged sentence, one independent conversation — never sees the other options, so it can't
// reason "well it's not X or Y so it must be Z." `targetMeaning` is the item's own `translation`
// (always present — see lib/practiceValidation.js), given explicitly so `matches_meaning` never has
// to guess which reading was intended (see the module-level comment above). `onUsage`, if given,
// fires once with { model, usage, stopReason, latencyMs } after the call — lets a DB-backed caller
// (api/practice.js, via generatePracticeItem's onCheckUsage) log every check to llm_api_call without
// this function itself depending on Supabase (this file is also driven by the DB-free practice test
// suites).
export async function checkSentence({ anthropic, model, lang, sentence, targetMeaning, onUsage }) {
  const system = checkSystemPrompt(lang)
  const messages = [{ role: 'user', content: `Target meaning (English): ${targetMeaning}\n\nSentence: ${sentence}` }]
  const request = { model, system, messages }
  const startedAt = Date.now()
  const message = await anthropic.messages.create({
    model,
    max_tokens: 256,
    system,
    messages,
    tools: [CHECK_TOOL],
    tool_choice: { type: 'tool', name: CHECK_TOOL.name },
  })
  onUsage?.({ model, usage: message.usage, stopReason: message.stop_reason, latencyMs: Date.now() - startedAt })
  const toolUse = message.content.find(b => b.type === 'tool_use')
  const response = toolUse?.input ?? null
  const grammatical = response?.grammatical === true
  const sensible = response?.sensible === true
  const matchesMeaning = response?.matches_meaning === true
  const rawReason = typeof response?.reason === 'string' ? response.reason.trim() : ''
  // `reason` is required (and minLength: 1'd) in the schema, but that only forces the model to
  // include a non-empty-looking key — it can still slip through with whitespace-only content. On a
  // failing verdict specifically, an empty reason is exactly the confusing "why was this flagged?"
  // gap this whole field exists to close, so fall back to a placeholder that says so explicitly
  // rather than silently logging null. On a passing verdict, null is fine — nothing to explain.
  const reason = rawReason || (!grammatical || !sensible || !matchesMeaning ? '(checker flagged a problem but gave no explanation)' : null)
  return { request, response, grammatical, sensible, matchesMeaning, reason }
}

// Runs checkSentence for every option of an mc_cloze item (each judged against the item's own
// `translation` as the target meaning — see checkSentence), then applies the pass condition above.
// Returns:
//   - passed: overall pass/fail
//   - checks: one row per option (in item.options order), each with its own request/response/reason
//   - reason: human-readable summary of what failed, doubling as the retry-prompt note (same
//     convention as PracticeValidationError messages elsewhere)
//   - offendingSentences / reasons: PARALLEL arrays, one entry per problem sentence (the answer's
//     sentence if it failed, then any distractor wrongly judged grammatical AND sensible AND a match
//     for the target meaning) — this is what the caller logs (lib/mcClozeCheckLog.js) rather than the
//     full checks array. Each entry's reason is the checker's own `reason` verbatim — for the
//     answer-failure case that's a real explanation of what's wrong; for a bad-distractor entry it's
//     the checker's pass confirmation (e.g. "Correct.") rather than a "why is this wrong"
//     explanation, since the checker itself saw nothing wrong with that sentence — the problem is
//     that it's TOO fine, not that it's broken — but it's still logged rather than discarded, so the
//     audit trail always shows the checker's actual verdict instead of a bare null.
export async function verifyMcClozeItem({ anthropic, model = DEFAULT_CHECK_MODEL, lang, item, onUsage }) {
  const checks = await Promise.all(item.options.map(async (option) => {
    const isAnswer = option === item.answer
    const sentence = fillBlank(item.sentence, option)
    const result = await checkSentence({ anthropic, model, lang, sentence, targetMeaning: item.translation, onUsage })
    return { option, isAnswer, sentence, ...result }
  }))

  const answerCheck = checks.find(c => c.isAnswer)
  // A distractor is only a real uniqueness problem if it's grammatical AND sensible AND a match for
  // the target meaning, all at once — a genuine alternative a fluent speaker would give as CORRECT
  // for the stated meaning. Failing on any one dimension ("wrong somehow") is fine and expected —
  // that's the normal shape of a distractor: an ungrammatical form, a grammatical-but-nonsensical
  // word/form, or (the case matches_meaning exists for) a fully natural sentence that simply means
  // something else than what was asked for (e.g. a near-synonym preposition/conjunction cluster).
  const badDistractors = checks.filter(c => !c.isAnswer && c.grammatical && c.sensible && c.matchesMeaning)

  const problems = []
  const offendingSentences = []
  const reasons = []

  const answerFailed = !answerCheck || !answerCheck.grammatical || !answerCheck.sensible || !answerCheck.matchesMeaning
  if (answerFailed) {
    const why = [!answerCheck?.grammatical && 'ungrammatical', !answerCheck?.sensible && 'nonsensical', !answerCheck?.matchesMeaning && "not a match for the item's own translation"].filter(Boolean).join(' and ')
    problems.push(`the correct answer "${item.answer}" was judged ${why} in context (${answerCheck?.reason ?? 'no reason given'}) — rewrite the sentence so the correct answer is unambiguously right`)
    offendingSentences.push(answerCheck?.sentence ?? fillBlank(item.sentence, item.answer))
    reasons.push(answerCheck?.reason ?? null)
  }
  if (badDistractors.length > 0) {
    const words = badDistractors.map(c => `"${c.option}"`).join(', ')
    const plural = badDistractors.length > 1
    // Deliberately prescriptive rather than offering a choice of fixes ("tighten the sentence OR
    // swap the distractor") — that phrasing let the retry drift into changing unrelated wording
    // while leaving the actual flagged option(s) untouched. Naming the exact option(s) to replace,
    // and explicitly ruling out touching anything else, is what makes the "fix only this" retry
    // turn (lib/practiceGenerate.js) land on a real fix instead of a same-problem reshuffle.
    problems.push(`distractor${plural ? 's' : ''} ${words} ${plural ? 'were' : 'was'} also judged grammatically correct, sensible, AND a match for the item's own translation ("${item.translation}") in this sentence, so the answer isn't unique. Replace ONLY ${plural ? 'these options' : 'this option'} (${words}) with ${plural ? 'different distractors' : 'a different distractor'} that is clearly wrong in this exact sentence — do not change the sentence itself, the answer, or any other option.`)
    for (const c of badDistractors) {
      offendingSentences.push(c.sentence)
      reasons.push(c.reason)
    }
  }

  return { passed: problems.length === 0, checks, reason: problems.join('; ') || null, offendingSentences, reasons }
}
