// German language pack — the config that lib/skillTypes.js and lib/practiceRules.js hardcoded
// before plan-language-packs.md, extracted verbatim as data. scripts/seed-language-pack.js writes
// these as skill_type_def / drill_rule rows for a project so the switch to pack-driven code
// (phase 2) produces NO observable behavior change on the real German project.
//
// Provenance, field by field:
//   skill_types[].{key,kind,label,display_order}  ← lib/skillTypes.js SKILL_TYPES
//   skill_types[].applies_when                    ← lib/skillTypes.js VOCAB_TAG_RULES (+ the
//                                                    unconditional grammar/expression lists)
//   skill_types[].gate                            ← lib/skillTypes.js SKILL_GATES
//   skill_types[].importance_default              ← lib/skillTypes.js DEFAULT_SKILL_IMPORTANCE
//   drill_rules[]                                 ← lib/practiceRules.js SKILL_PROBLEM_TYPES
//   drill_rules[].require_frame                   ← lib/practiceValidation.js production `frame` throws;
//                                                    also what api/practice.js reads to decide whether
//                                                    to reveal `translation` to the learner before they
//                                                    answer (see the two "production-which-*" rules
//                                                    below) — a drill that forces a governing frame is,
//                                                    by construction, one where several options can be
//                                                    independently natural and only differ in meaning.
//   meta.sense_exempt_tags                        ← lib/skillTypes.js SENSE_EXEMPT_TAGS
//   meta.vocabulary_policy                        ← lib/prompts/registry.js vocabularyPolicy() (body only;
//                                                    core re-adds the "## Vocabulary policy" header)
//
// Prompt strings are copied CHARACTER-FOR-CHARACTER from the old SKILL_PROBLEM_TYPES functions,
// including their existing typos ("Distractions", "deminine", "sentnece", "determins") and the
// trailing space after "blank." in the gender rule — this is a faithful extraction, not a cleanup
// pass. `${cardName}` became the literal placeholder {cardName}; `${cardName.replace(/^-|-$/g,'')}`
// became {cardStem}. Core substitutes both at compose() time.

const GATE_AFTER_MEANING = { requires: 'meaning', min_level: 3, state: 'stable' }

// ── vocabulary: meaning / mc_cloze ────────────────────────────────────────────
const MEANING_MC_CLOZE = `\
Self-check before answering: would someone who knows every other word here, but not "{cardName}", still land on the right option? If so, start over.

- Near-synonyms are the most common way this self-check silently fails — words close enough in sense (Ferien/Urlaub/Freizeit, gleich/bald/manchmal, Garten/Zimmer/Keller, neu/alt/blau) that a generic frame ("Die Kinder freuen sich auf die ___") leaves several of them equally acceptable. Before finalizing, name IN THE SENTENCE one concrete, checkable detail — a specific consequence, a number/duration, a named contrast, a cause that only follows from THIS word's precise sense — that a fluent speaker would use to rule out every distractor individually. If you can't point to that detail in the sentence you wrote, add it or pick a less generic frame.
- "{cardName}" need not fill the blank itself — the blank can be a different word whose one correct choice hinges on what "{cardName}" means (e.g. testing "Wasser": "Ich habe seit Stunden nichts getrunken, ich muss dringend etwas ___" — trinken vs essen vs schlafen — only answerable by knowing water is for drinking).
- If "{cardName}" is a prefix/suffix/word-formation pattern (e.g. "-bar", "un-", "-los") rather than a full word: hold the base stem fixed across every option and vary only the pattern (e.g. "-bar" on "trink-": trinkbar vs getrunken vs trinkend vs trinklich), or work "{cardStem}" itself into the sentence as running text so the blank turns on understanding it. Never let every option carry the pattern on a different stem (trinkbar/essbar/sichtbar/hörbar) — that tests the stems, not "{cardName}".
- Distractors must be grammatically sound but wrong specifically because of "{cardName}"'s sense — not for an unrelated reason (different stem, tense, case).
- Every added clause must be logically consistent with the rest of the sentence, not just individually plausible — don't bolt on a causal/temporal clause purely to add complexity if it ends up contradicting the main clause (e.g. giving a reason that couldn't actually cause the stated result).`

// ── vocabulary: gender / mc_cloze ─────────────────────────────────────────────
const GENDER_MC_CLOZE = `\
This question tests the user knows the Gender of this noun. The noun itself must never be in the blank.

- Instead, blank out the case-marked part of speech that is forced by this noun.`

// ── vocabulary: case / mc_cloze ──────────────────────────────────────────────
const CASE_MC_CLOZE = `\
This question tests which grammatical case this preposition governs in context — it is NEVER a test of which preposition to use.

- Before writing the sentence, pick a verb/noun/scenario where THIS EXACT preposition is the obviously correct, idiomatic choice — not one where a different preposition would actually fit better or equally well (e.g. "bei" names presence alongside someone/something static; it is NOT how German expresses a sound's source (use "von") or the topic of speech (use "über"/"mit")). If you can't confidently defend that this preposition, and no other, belongs here, pick a different noun/scenario before proceeding — a wrong-preposition sentence fails this check even when the case-marking itself is perfect.
- Keep this exact preposition fixed as ordinary running text in the sentence: it must not be the blank, and it must not appear as (or vary across) the answer options.
- Instead, blank out the case-marked article/pronoun/possessive/adjective ending of the preposition's complement.
- Every option must be a different case-marked form of that SAME complement (e.g. "den" vs. "dem" for the same masculine noun) — never a different noun, never a different preposition.
- If this is a two-way preposition (accusative for motion/direction/change of state, dative for static location/position), the sentence must unambiguously signal which one applies (e.g. a verb of movement into/onto something vs. a verb of being/remaining somewhere) so only one case-marked option is grammatical.
- If this preposition forces a case, make the correct choice as counter-intuitive as possible, while still having one unambiguous correct answer.
- Distractions must have the same meaning as the correct answer, but genuinely indicate the wrong case
- In the English translation you provide, do not indicate which answer is correct, and do not tell the user the case of options (e.g. translate "die" as "the
- instead of "the (deminine)) However, in the translation of the sentnece, do indicate the gender of the noun that also determins the answer`

// ── grammar: production / mc_cloze — preposition variant (card tagged production-which-preposition) ──
const PRODUCTION_PREPOSITION_MC_CLOZE = `\
This question tests PRODUCTION of the preposition named at the start of "{cardName}" (the lemma before " + ") — which preposition a specific verb/construction genuinely governs in that exact use-case — not recognition, and not which case it takes (a separate skill, "case").

Build the item in this order, not sentence-first:
1. Pick ONE specific, concrete use-case for this preposition — either a verb/adjective/fixed construction that genuinely, idiomatically governs it (e.g. for "an": denken an, sich erinnern an, sich lehnen an — real, dictionary-attested pairings, never one you're merely guessing could take it), OR, if it isn't governed by any particular verb at all (a free adjunct that could attach to many different sentences — e.g. a bare time or place phrase), the SPECIFIC real-world relation it expresses here, stated precisely enough to distinguish it from what every other candidate preposition would mean in that same slot.
2. State that choice, verbatim as it will appear in the sentence, in \`frame\` — BEFORE writing the sentence. A frame that just restates the card's own name or definition back at you is not specific enough — state the actual concrete use-case or relation in your own words.
3. Build the sentence around that frame, adding whatever concrete detail — a real-world fact, an explicit reference point, a tense/aspect signal — makes THIS relation the only one that fits. Never write the sentence first and bolt a preposition onto it afterward.

- Blank out ONLY the preposition. The rest of the frame (the verb/construction named in \`frame\`, if any) stays fixed as ordinary running text in the sentence.
- The recurring failure here is a context general enough that more than one preposition would produce an equally natural, standalone sentence — whether because a verb genuinely tolerates several of them (e.g. "abfahren" accepts both "von" and "aus" for a departure city) or because, with no verb narrowing anything down, a bare phrase (e.g. a time or place expression) is just as compatible with a different preposition's relation as with the one you meant. Either way it's the same test: pick a use-case where dictionaries/grammar references — or, for a free adjunct, the concrete detail you added in step 3 — mark exactly ONE candidate as correct and every other one as outright wrong, not just less common.
- Before finalizing, literally substitute EACH candidate distractor preposition into your exact finished sentence and ask: does this still read as an equally natural, plausible, standalone thing to say? If yes for any of them, your context is too generic — add a concrete detail that rules it out, or discard this frame for a narrower one. Per the base task's self-check: if you can't state why this frame rules out a candidate preposition, it isn't a valid distractor for this item.
- \`translation\` is shown to the learner BEFORE they answer, as the meaning they must produce — the exercise is "which preposition says this," not "which sentence sounds fine." Write it in precise, idiomatic English that states the SPECIFIC relation from step 1 and could not equally describe what any distractor would produce if substituted in (a literal, word-for-word gloss is not enough if it carries the same ambiguity the German does — rephrase until only your intended relation fits it).`

// ── grammar: production / mc_cloze — conjunction variant (card tagged production-which-conjunction) ──
const PRODUCTION_CONJUNCTION_MC_CLOZE = `\
This question tests PRODUCTION of the conjunction named by "{cardName}" — which conjunction a specific relationship between two clauses genuinely calls for — not recognition of its meaning in isolation.

Build the item in this order, not sentence-first:
1. Pick ONE specific temporal/causal/concessive/conditional relationship between two concrete events that ONLY "{cardName}" expresses correctly (e.g. for "als": one single, specific past occasion — never a repeated or habitual one, which needs "wenn"; for "nachdem": a completed event strictly before another, usually forcing a tense shift (Plusquamperfekt → Präteritum/Perfekt) between the two clauses — that tense shift is itself evidence nothing else fits; for "obwohl": a real, stated conflict where the expected outcome does NOT happen).
2. State that relationship, in one line, in \`frame\` — BEFORE writing the sentence (e.g. "a single past occasion, not habitual — rules out wenn").
3. Build the sentence around that relationship, choosing tenses and details that make it concrete and singular (a specific date, an unrepeatable event, an explicit result) — vague, generic clauses ("Es regnete, ___ ich nach Hause kam") are exactly what makes als/wenn/während/nachdem/weil/obwohl all sound equally fine; a story-like connector sentence with no such anchor is not acceptable here.
- Every distractor conjunction must be one that a fluent speaker would reject outright for the relationship you named in \`frame\`, not just consider less elegant. Temporal conjunctions (als/wenn/während/nachdem/bevor) and causal/concessive ones (weil/obwohl/da) are notoriously interchangeable in underspecified sentences — if you can't point to the specific word/tense/detail in your sentence that rules a candidate out, it isn't a valid distractor.
- \`translation\` is shown to the learner BEFORE they answer, as the relationship they must produce — the exercise is "which conjunction says this," not "which sentence sounds fine." Write it in precise, idiomatic English that makes the relationship from step 1 explicit (e.g. "even though," "once," "the moment that") and could not equally describe what a distractor conjunction would produce if substituted in.`

const VOCABULARY_POLICY = `\
Every word in the sentence other than the target word/form itself must be simple, common, everyday vocabulary — the kind a learner meets in their first year or two, not anything rare, technical, archaic, or literary. If the natural way to say something needs a rarer word, do not use it — write a shorter, plainer sentence instead. A simple sentence is always the right choice over a more sophisticated one.`

// A verb-irregular-* tag that maps onto a *-spelling skill type; keeps the vocabulary spelling
// block below terse. `extraTags` handles plural-spelling's two triggers (noun-irregular AND
// verb-irregular-plural, per VOCAB_TAG_RULES).
function spellingType(key, label, order, triggerTag, extraTags = []) {
  return {
    key, kind: 'vocabulary', label, display_order: order,
    applies_when: { any_tag: [triggerTag, ...extraTags] },
    gate: GATE_AFTER_MEANING,
    importance_default: 2,
  }
}

const GERMAN_SEED = {
  meta: {
    label: 'German',
    vocabulary_policy: VOCABULARY_POLICY,
    // lib/skillTypes.js SENSE_EXEMPT_TAGS
    sense_exempt_tags: [
      'preposition', 'particle', 'separable-prefix', 'affix', 'article',
      'pronoun', 'conjunction', 'auxiliary', 'modal-verb',
    ],
  },

  skill_types: [
    // vocabulary
    { key: 'meaning', kind: 'vocabulary', label: 'Meaning', display_order: 10,
      applies_when: null, gate: null, importance_default: 'inherit' },
    { key: 'gender', kind: 'vocabulary', label: 'Gender', display_order: 20,
      applies_when: { any_tag: ['noun'] }, gate: GATE_AFTER_MEANING, importance_default: 'inherit' },
    spellingType('plural-spelling', 'Plural spelling', 30, 'noun-irregular', ['verb-irregular-plural']),
    { key: 'case', kind: 'vocabulary', label: 'Case governed', display_order: 40,
      applies_when: { any_tag: ['preposition'] }, gate: GATE_AFTER_MEANING, importance_default: 'inherit' },
    spellingType('imperative-spelling', 'Imperative spelling', 50, 'verb-irregular-imperative'),
    spellingType('past-participle-spelling', 'Past participle spelling', 60, 'verb-irregular-past-participle'),
    spellingType('present-spelling', 'Present-tense spelling', 70, 'verb-irregular-present'),
    spellingType('simple-past-spelling', 'Simple-past spelling', 80, 'verb-irregular-simple-past'),
    spellingType('subjunctive-1-spelling', 'Subjunctive I spelling', 90, 'verb-irregular-subjunctive-1'),
    spellingType('subjunctive-2-spelling', 'Subjunctive II spelling', 100, 'verb-irregular-subjunctive-2'),
    { key: 'separated-form-understanding/recognition', kind: 'vocabulary',
      label: 'Separated form', display_order: 110,
      applies_when: { any_tag: ['verb-separable'] }, gate: GATE_AFTER_MEANING, importance_default: 2 },

    // grammar — SKILL_TYPES.grammar was unconditionally ['production']
    { key: 'production', kind: 'grammar', label: 'Production', display_order: 10,
      applies_when: null, gate: null, importance_default: 'inherit' },

    // expression — SKILL_TYPES.expression was unconditionally ['meaning']
    { key: 'meaning', kind: 'expression', label: 'Meaning', display_order: 10,
      applies_when: null, gate: null, importance_default: 'inherit' },
  ],

  // Every SKILL_PROBLEM_TYPES row was weight `() => 1` → weight_curve 'flat'. Pairs of rows for
  // one skill type (meaning: mc_cloze + exemplar) reproduce the old 50/50 weighted pick.
  drill_rules: [
    // vocabulary: meaning
    { kind: 'vocabulary', skill_type_key: 'meaning', question_type: 'mc_cloze', prompt: MEANING_MC_CLOZE },
    { kind: 'vocabulary', skill_type_key: 'meaning', question_type: 'exemplar', prompt: '' },
    // vocabulary: gender
    { kind: 'vocabulary', skill_type_key: 'gender', question_type: 'mc_cloze', prompt: GENDER_MC_CLOZE },
    // vocabulary: case
    { kind: 'vocabulary', skill_type_key: 'case', question_type: 'mc_cloze', prompt: CASE_MC_CLOZE },
    // vocabulary: the *-spelling family (all bare `spelling`, empty prompt)
    { kind: 'vocabulary', skill_type_key: 'plural-spelling', question_type: 'spelling', prompt: '' },
    { kind: 'vocabulary', skill_type_key: 'imperative-spelling', question_type: 'spelling', prompt: '' },
    { kind: 'vocabulary', skill_type_key: 'past-participle-spelling', question_type: 'spelling', prompt: '' },
    { kind: 'vocabulary', skill_type_key: 'present-spelling', question_type: 'spelling', prompt: '' },
    { kind: 'vocabulary', skill_type_key: 'simple-past-spelling', question_type: 'spelling', prompt: '' },
    { kind: 'vocabulary', skill_type_key: 'subjunctive-1-spelling', question_type: 'spelling', prompt: '' },
    { kind: 'vocabulary', skill_type_key: 'subjunctive-2-spelling', question_type: 'spelling', prompt: '' },
    // vocabulary: separated form
    { kind: 'vocabulary', skill_type_key: 'separated-form-understanding/recognition', question_type: 'exemplar', prompt: '' },

    // grammar: production — one skill type, three tag-selected prompts (was a cardTags branch in
    // the old prompt function + duplicated tag checks in practiceValidation.js).
    { kind: 'grammar', skill_type_key: 'production', question_type: 'mc_cloze', priority: 10,
      applies_when: { all_tags: ['production-which-preposition'] },
      require_frame: true, prompt: PRODUCTION_PREPOSITION_MC_CLOZE },
    { kind: 'grammar', skill_type_key: 'production', question_type: 'mc_cloze', priority: 10,
      applies_when: { all_tags: ['production-which-conjunction'] },
      require_frame: true, prompt: PRODUCTION_CONJUNCTION_MC_CLOZE },
    { kind: 'grammar', skill_type_key: 'production', question_type: 'mc_cloze', priority: 0,
      applies_when: null, require_frame: false, prompt: '' },

    // expression: meaning — mirrors vocabulary meaning (getPracticeRule keyed on skillType
    // 'meaning' regardless of kind, so an expression card's meaning skill drilled identically).
    { kind: 'expression', skill_type_key: 'meaning', question_type: 'mc_cloze', prompt: MEANING_MC_CLOZE },
    { kind: 'expression', skill_type_key: 'meaning', question_type: 'exemplar', prompt: '' },
  ],
}

export default GERMAN_SEED
