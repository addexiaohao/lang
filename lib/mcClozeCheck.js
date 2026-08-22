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
// isolated judgment call and the same criterion for both — "grammatical AND sensible" — nothing
// about the "correct" option is assumed or skipped:
//   - the correct answer's sentence must independently come back grammatical AND sensible — it is
//     judged exactly like every distractor, not waved through because the generator labeled it correct
//   - every distractor's sentence must NOT come back grammatical-AND-sensible at once — it's fine
//     for a distractor to be wrong for either reason (ungrammatical, or grammatical-but-nonsensical
//     in context — the normal shape of a vocabulary-meaning distractor, e.g. swapping in a
//     different, equally grammatical but contextually implausible word) as long as it's wrong
//     SOMEHOW. A distractor only fails the check if a fluent speaker would find it BOTH
//     grammatically fine AND a genuinely sensible fit — i.e. it's a real alternative answer, which
//     means the "correct" answer isn't actually unique.
// Used by lib/practiceGenerate.js, which retries generation (same as any other
// PracticeValidationError) when either direction fails.

export const DEFAULT_CHECK_MODEL = 'claude-sonnet-4-6'

const CHECK_TOOL = {
  name: 'emit_sentence_check',
  description: 'Judge one sentence for grammatical correctness and whether it makes sense.',
  input_schema: {
    type: 'object',
    properties: {
      grammatical: { type: 'boolean', description: 'True only if the sentence is fully grammatically correct as written (case, gender, agreement, word order, conjugation, etc.) — any error, however small, makes this false.' },
      sensible: { type: 'boolean', description: 'True only if the sentence is fully coherent: plausible, logically consistent, AND internally consistent in its own timeline/tense reference (not just each clause plausible in isolation). False for a sentence that is individually well-formed per clause but contradicts itself as a whole — e.g. describing a repeated past event with a present-perfect-style framing ("I have already seen X three times") and then, in the same breath, treating "the next occurrence" as if it too already happened and was evaluated, which only a stricter, temporally-consistent phrasing would properly support. Judge this independently of grammatical — a grammatically broken sentence can still be sensible, and vice versa.' },
      reason: { type: 'string', minLength: 1, description: 'Always required and NEVER empty, in ENGLISH. If grammatical and sensible are BOTH true: a brief confirmation only, e.g. "Correct." — do not justify or elaborate on a pass. If grammatical or sensible is false: one short sentence pinpointing exactly what is wrong (e.g. "wrong case: should be dative \'dem\' not accusative \'den\'") — quote the offending word/phrase from the sentence verbatim, but write the explanation itself in English regardless of the sentence\'s language. Commit to a final verdict — do not think out loud or second-guess yourself in this field; if you reconsider mid-explanation, make sure `grammatical`/`sensible` reflect your FINAL judgment, not an earlier one.' },
    },
    required: ['grammatical', 'sensible', 'reason'],
  },
}

function checkSystemPrompt(lang) {
  return `You are a strict ${lang} grammar and coherence checker. You will be given one ${lang} sentence. Judge it on two independent dimensions and respond ONLY by calling the emit_sentence_check tool — no other text. Be strict on \`sensible\`: read the whole sentence as one coherent statement, not clause-by-clause — a sentence whose individual clauses are each plausible but which contradicts itself as a whole (e.g. mixed/inconsistent tense reference implying impossible timeline) is NOT sensible. Always include a \`reason\`, written in English (you may quote the ${lang} sentence/words it refers to verbatim) — never write the reason itself in ${lang}. Do your reasoning BEFORE deciding \`grammatical\`/\`sensible\`, not after: \`reason\` must state your final verdict, not an in-progress deliberation that ends up disagreeing with the booleans you report.`
}

// Fills the sentence's single "___" blank with one option — same blank convention mc_cloze items
// use (validatePracticeItem enforces exactly one).
export function fillBlank(sentence, option) {
  return sentence.replace('___', option)
}

// One judged sentence, one independent conversation — never sees the other options, so it can't
// reason "well it's not X or Y so it must be Z."
export async function checkSentence({ anthropic, model, lang, sentence }) {
  const system = checkSystemPrompt(lang)
  const messages = [{ role: 'user', content: sentence }]
  const request = { model, system, messages }
  const message = await anthropic.messages.create({
    model,
    max_tokens: 256,
    system,
    messages,
    tools: [CHECK_TOOL],
    tool_choice: { type: 'tool', name: CHECK_TOOL.name },
  })
  const toolUse = message.content.find(b => b.type === 'tool_use')
  const response = toolUse?.input ?? null
  const grammatical = response?.grammatical === true
  const sensible = response?.sensible === true
  const rawReason = typeof response?.reason === 'string' ? response.reason.trim() : ''
  // `reason` is required (and minLength: 1'd) in the schema, but that only forces the model to
  // include a non-empty-looking key — it can still slip through with whitespace-only content. On a
  // failing verdict specifically, an empty reason is exactly the confusing "why was this flagged?"
  // gap this whole field exists to close, so fall back to a placeholder that says so explicitly
  // rather than silently logging null. On a passing verdict, null is fine — nothing to explain.
  const reason = rawReason || (!grammatical || !sensible ? '(checker flagged a problem but gave no explanation)' : null)
  return { request, response, grammatical, sensible, reason }
}

// Runs checkSentence for every option of an mc_cloze item, then applies the pass condition above.
// Returns:
//   - passed: overall pass/fail
//   - checks: one row per option (in item.options order), each with its own request/response/reason
//   - reason: human-readable summary of what failed, doubling as the retry-prompt note (same
//     convention as PracticeValidationError messages elsewhere)
//   - offendingSentences / reasons: PARALLEL arrays, one entry per problem sentence (the answer's
//     sentence if it failed, then any distractor wrongly judged BOTH grammatical and sensible) —
//     this is what the caller logs (lib/mcClozeCheckLog.js) rather than the full checks array. Each
//     entry's reason is the checker's own `reason` verbatim — for the answer-failure case that's a
//     real explanation of what's wrong; for a bad-distractor entry it's the checker's pass
//     confirmation (e.g. "Correct.") rather than a "why is this wrong" explanation, since the
//     checker itself saw nothing wrong with that sentence — the problem is that it's TOO fine, not
//     that it's broken — but it's still logged rather than discarded, so the audit trail always
//     shows the checker's actual verdict instead of a bare null.
export async function verifyMcClozeItem({ anthropic, model = DEFAULT_CHECK_MODEL, lang, item }) {
  const checks = await Promise.all(item.options.map(async (option) => {
    const isAnswer = option === item.answer
    const sentence = fillBlank(item.sentence, option)
    const result = await checkSentence({ anthropic, model, lang, sentence })
    return { option, isAnswer, sentence, ...result }
  }))

  const answerCheck = checks.find(c => c.isAnswer)
  // A distractor is only a real uniqueness problem if it's grammatical AND sensible at once — a
  // genuine alternative a fluent speaker could pick. Failing on either dimension alone ("wrong
  // somehow") is fine and expected — that's the normal shape of a distractor (an ungrammatical
  // form, or a different-but-grammatical word/form that doesn't fit the sentence's meaning).
  const badDistractors = checks.filter(c => !c.isAnswer && c.grammatical && c.sensible)

  const problems = []
  const offendingSentences = []
  const reasons = []

  const answerFailed = !answerCheck || !answerCheck.grammatical || !answerCheck.sensible
  if (answerFailed) {
    const why = [!answerCheck?.grammatical && 'ungrammatical', !answerCheck?.sensible && 'nonsensical'].filter(Boolean).join(' and ')
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
    problems.push(`distractor${plural ? 's' : ''} ${words} ${plural ? 'were' : 'was'} also judged grammatically correct AND a sensible fit in this sentence, so the answer isn't unique. Replace ONLY ${plural ? 'these options' : 'this option'} (${words}) with ${plural ? 'different distractors' : 'a different distractor'} that is clearly wrong in this exact sentence — do not change the sentence itself, the answer, or any other option.`)
    for (const c of badDistractors) {
      offendingSentences.push(c.sentence)
      reasons.push(c.reason)
    }
  }

  return { passed: problems.length === 0, checks, reason: problems.join('; ') || null, offendingSentences, reasons }
}
