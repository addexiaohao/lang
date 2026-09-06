// Prompt registry — prompts identified by string id, each with a version and a compose(context) fn.
// compose() assembles shared fragments (lib/prompts/fragments.js) + a task-specific body +,
// for chat.distill only, the project's user-editable system_prompt layer (DB-backed).
//
// Practice prompts (practice.mc_cloze, practice.exemplar) are code-only — they have no
// user-editable layer, since that would require a DB change (see CLAUDE.md).

import { langProject, taxonomyCards, tagsCatalog, languageName } from './fragments.js'
import { PROBLEM_TYPES } from '../practiceRules.js'
import { DEFAULT_VOCABULARY_POLICY } from '../languagePack.js'

// chat.distill body, split around the taxonomy.cards fragment so it can be shared.
const CHAT_DISTILL_PRE = `\
## Tag pre-flight (run before writing any prose)

1. Identify every tag you plan to use in any \`save:knowledge_card\` block.
2. Look up each one in the **Tag catalog** at the end of this prompt.
3. If ANY tag is not in the catalog, your response MUST begin with this block — before any prose, before anything else:

\`\`\`save:proposed_tags
["new-tag-1", "new-tag-2"]
\`\`\`

Never use an undeclared tag. Never start with prose if new tags are needed.

## Save blocks

Whenever you encounter foreign-language text or produce it yourself, you MUST emit save blocks. It costs nothing to propose too many — the user discards what they don't want. Never skip them.

**Required for any message containing target-language text:**
1. One \`save:source\` block per sentence — always, no exceptions
2. One or more \`save:knowledge_card\` blocks for vocabulary, grammar, or expressions worth noting — err heavily toward saving

Give a brief overall translation first. Then follow this exact interleaved structure — do NOT explain all items first and emit cards at the end:
1. \`save:source\` block
2. For each knowledge item, tightly alternating:
   a. One or two sentences explaining that specific item
   b. The \`save:knowledge_card\` block immediately after — before moving to the next item

## Source refs

Every \`save:source\` block must include a \`"ref"\` integer — a conversation-wide counter.
Start at 1 for the first source in the conversation. In every subsequent message, look at the highest \`ref\` already used in the conversation history and continue counting from there.

Every \`save:knowledge_card\` block must include \`"source_ref"\` set to the \`ref\` of its source. This applies even when the card is in a different message than the source.

Each source must cover exactly one sentence. Multiple sentences → separate \`save:source\` blocks, each with its own \`ref\`.

## Save block formats

\`\`\`save:source
{
  "ref": 1,
  "original_text": "raw foreign text, corrected for typos"
}
\`\`\`

\`\`\`save:knowledge_card
{
  "source_ref": 1,
  "kind": "vocabulary",
  "name": "aufmachen",
  "tags": ["verb", "verb-separable"],
  "details": {},
  "importance": 7,
  "annotated_sentence": "Er ⟦macht⟧ das Fenster ⟦auf⟧."
}
\`\`\`

\`\`\`save:knowledge_card
{
  "source_ref": 1,
  "kind": "expression",
  "name": "auf jeden Fall",
  "tags": [],
  "details": {},
  "importance": 8,
  "annotated_sentence": "Das machen wir ⟦auf jeden Fall⟧."
}
\`\`\`

If an existing card is found via \`search_knowledge_cards\`, emit a link block instead:

\`\`\`save:link_card
{
  "source_ref": 1,
  "existing_id": "uuid-from-search-result",
  "name": "aufmachen",
  "kind": "vocabulary",
  "tags": ["verb", "verb-separable"],
  "annotated_sentence": "Er ⟦macht⟧ das Fenster ⟦auf⟧."
}
\`\`\`

## Annotated sentence

Every \`save:knowledge_card\` and \`save:link_card\` block MUST include \`"annotated_sentence"\`.

Rules:
- Copy the **single sentence** that contains the relevant span, **character-for-character verbatim** — no paraphrasing, no typo-fixing, no whitespace changes.
- Wrap the relevant span(s) in ⟦⟧ markers (U+27E6 / U+27E7).
- Discontinuous spans (separable verbs, correlatives, Perfekt): use multiple marker pairs in the same sentence. Example: \`"Er ⟦kauft⟧ heute ein Buch ⟦ein⟧."\`
- Compound components: markers go around just the relevant substring, not the whole word. Example: \`"Haus⟦aufgabe⟧"\`
- Once markers are stripped, the sentence must match the source text exactly.

## Block ordering

Keep each source and its knowledge cards together. Emit all knowledge cards for a source immediately after its \`save:source\` block, before starting the next source.

## Card design rules

DO store: name (lemma/pattern/expression), kind, structural flags in tags
DO NOT store: translations, explanations, grammar rules, example sentences, conjugated/declined forms`

const CHAT_DISTILL_POST = `\
## Card-level fields

- \`importance\` (1–10): common core 8–10, rare edge cases 1–3

## Tags

See the **Tag catalog** section below for existing tags and instructions on proposing new ones.

## Details

Emit \`"details": {}\` when no extra fields are needed (which is true most of the time). See "Paradigm cards (axes)" below for the one case where \`details\` is required.

## Paradigm cards (axes)

Some knowledge is a grid of forms sharing axes, where each cell only makes sense in relation to the others (e.g. adjective declension by case × gender × article_type) — not "how much of the concept is covered." This is still a single \`save:knowledge_card\`, just with \`details.axes\` set — do NOT invent a separate block type for it.

Decision test: do the forms share axes and only make sense together?
- Yes → this card, with axes (below)
- No → an ordinary flat card, or several individual cards linked by a shared tag (e.g. nach/zu/in/auf/an are five independent cards tagged "destination-prepositions", not a paradigm)

\`\`\`save:knowledge_card
{
  "source_ref": 1,
  "kind": "grammar",
  "name": "Adjective declension",
  "tags": ["adjectives", "declension"],
  "details": {
    "axes": [
      { "name": "case", "values": ["nominative", "accusative", "dative", "genitive"] },
      { "name": "gender", "values": ["masculine", "feminine", "neuter", "plural"] },
      { "name": "article_type", "values": ["strong", "mixed", "weak"] }
    ]
  },
  "importance": 7,
  "annotated_sentence": "Ich sehe ⟦den⟧ großen Hund."
}
\`\`\`

Rules:
- State every axis's full, legal value list explicitly. **This cannot be edited after the card is saved** — a wrong value list (e.g. 3 vs 4 article_types) can only be fixed by deleting and recreating the card, so get it right the first time.
- Axis order matters — it's the same order used to key each specific cell later, so pick an order and keep it consistent within the card.
- Still call \`search_knowledge_cards\` first, same as any other card — if a matching paradigm card already exists, emit \`save:link_card\` instead rather than creating a duplicate.

## Before saving sources

Call \`search_sources\` with the \`original_text\` before emitting any \`save:source\` block.
- No match → emit \`save:source\` as normal.
- Match → emit \`save:source\` with \`"existing_id"\` set to the matched source's id.

## Before saving knowledge cards

Call \`search_knowledge_cards\` with the card name before emitting any \`save:knowledge_card\` block. For a vocabulary word, ALWAYS also pass \`excerpt\` — the exact sentence it appears in here — so a sense check can run against any match.
- No match → emit \`save:knowledge_card\` as normal.
- Match, and it's genuinely the same word → emit \`save:link_card\` instead (include \`existing_id\`, \`name\`, \`kind\`, \`tags\`, \`importance\` from the search result; see "Word senses" below for vocabulary).
- Match by spelling, but genuinely a different word (a true homonym — different gender, different origin, e.g. \`der Band\` / \`das Band\` / \`die Band\`) → this is NOT a sense of the matched card. Emit a fresh \`save:knowledge_card\` as normal, ignore the match.

## Word senses

Some vocabulary words have senses distinct enough that knowing one actively misleads you about the other (*Bank* the bench vs. *Bank* the financial institution — even the plurals differ). This is different from a homonym (a different word that happens to be spelled the same) and different from a word merely being used flexibly (*Rand* meaning "edge" in several contexts — still one sense, just applied broadly).

When \`search_knowledge_cards\` matches a vocabulary card, its result carries:
- \`senses\`: the card's existing sense(s) on file, each \`{ key, gloss, example }\` — \`null\` if the card hasn't been split into senses yet (still one plain \`meaning\` skill).
- \`sense_check\`: \`{ verdict, reasoning }\` from a dedicated sense-distinctness check comparing your \`excerpt\` against this word — \`verdict\` is \`"single"\` (one sense), \`"distinct"\` (senses a learner must keep apart), or \`"stretched"\` (related/extended use of one core sense — not distinct). Absent when the word is exempt (function words, prepositions, particles, separable prefixes — their variation is grammatical, not lexical) or the card is a non-sense paradigm.

What to do with it, on the \`save:link_card\` block:
- No \`sense_check\`, or \`verdict: "single"\` → emit the link exactly as before. No sense fields needed.
- \`verdict: "stretched"\` → still just an ordinary link (do not fork), but add \`"sense_flag": "stretched"\` so the user can see this was a borderline call and override it if they disagree.
- \`verdict: "distinct"\` → compare your excerpt's actual usage against each entry in \`senses\` (or, if \`senses\` is \`null\`, against what you already know this word to mean from context):
  - Same as one of the senses already on file → add \`"sense_key": "<that sense's key>"\`.
  - A genuinely new sense not on file → add:
    \`\`\`json
    "new_sense": { "key": "financial", "gloss": "a bank, financial institution", "example": "<this excerpt, verbatim>" }
    \`\`\`
    If \`senses\` was \`null\` (this is the word's first split), you must ALSO describe the sense already implicitly on the card, from what you know of it (its name, tags, any excerpt \`search_knowledge_cards\` gave you) — the app has never stored an explicit gloss for a plain \`meaning\` skill, so you're the only source for it at the moment of the split:
    \`\`\`json
    "existing_sense": { "key": "seating", "gloss": "a bench, a seat", "example": "<a plausible or previously-seen sentence for this sense>" }
    \`\`\`
  State your reasoning briefly in the visible prose right before the block — "you already know *Bank* as a bench; this is the financial sense" — so the user sees the comparison, not just its result.

Sense keys are short lowercase slugs (\`financial\`, \`seating\`), never free text — they become skill types, so keep them terse and stable.

## Tool calls

Don't narrate tool calls to the user — just execute them and report the result.
`

// ── Practice prompts (code-only — no user-editable layer, see CLAUDE.md) ────────────────────

function practiceCardContext(card) {
  const lines = [
    `- name: ${card.name}`,
    `- kind: ${card.kind}`,
    `- tags: ${card.tags?.length ? card.tags.join(', ') : '(none)'}`,
  ]
  if (card.details && Object.keys(card.details).length > 0) {
    lines.push(`- details: ${JSON.stringify(card.details)}`)
  }
  return `## Target card\n${lines.join('\n')}`
}

// Practice task templates (PROBLEM_TYPES) live in lib/practiceRules.js; the per-skill extra prose
// is the resolved drill rule's `extraPrompt`, authored per project (drill_rule.prompt, resolved by
// lib/languagePack.js's drillRuleFor/resolveDrillRule with {cardName}/{cardStem} already
// substituted). This file only assembles them. skillSection() wraps that extraPrompt under a fixed
// header; no enumeration/validation needed here since drillRuleFor already returns null for
// anything unrecognized (api/practice.js substitutes a different skill in that case).
function skillSection(skillType, extraPrompt) {
  if (!skillType) return ''
  // `extraPrompt` was previously dropped entirely here — silently discarding the "meaning" drill's
  // self-check bullets, the sense-drilling note (api/practice.js's senseGloss branch), and Card
  // Groups' discrimination instructions alike. All three depend on this text reaching the model, so
  // it's included the same way the non-"meaning" branch below already does.
  if (skillType == "meaning") {
    const lines = ['Only test the `meaning` of this card']
    if (extraPrompt) lines.push(extraPrompt)
    return lines.join('\n\n')
  }
  const lines = [`## Target skill\nThis request drills specifically the "${skillType}" skill of the card above — do not test a different facet of it.`]
  if (extraPrompt) lines.push(extraPrompt)
  return lines.join('\n\n')
}

function seedSection(seedCardNames) {
  if (!seedCardNames.length) return ''
  return `## These are other words the user is also trying to learn\n If possible, include any number of them in the sentence. They have to fit naturally — do not force them, and it's okay to not use any: ${seedCardNames.join(', ')}\n\nReport whichever of these you actually used (verbatim, from the list above) in \`used_seed_words\`.`
}

// Closed-vocabulary policy — a hard constraint on the sentence's vocabulary (not just the seed
// list the model MAY use). `text` is the project's own policy (pack meta.vocabulary_policy, passed
// through promptContext by api/practice.js); callers with no pack (the test suites' bare-card
// compose()) omit it and get DEFAULT_VOCABULARY_POLICY, which is identical wording, so behavior is
// unchanged. See plan-language-packs.md.
function vocabularyPolicySection(text) {
  return `## Vocabulary policy\n${text || DEFAULT_VOCABULARY_POLICY}`
}

const registry = {
  'chat.distill': {
    version: '2',
    compose({ config, userPrompt, tags }) {
      const part1 = [CHAT_DISTILL_PRE, taxonomyCards(), CHAT_DISTILL_POST].join('\n\n')
      const part2 = langProject(config)
      const part3 = userPrompt?.trim() ?? ''

      let prompt = [part1, part2, part3].filter(Boolean).join('\n\n')
      prompt += '\n\n' + tagsCatalog(tags)
      return prompt
    },
  },

  'practice.mc_cloze': {
    version: '15',
    // problemType defaults to 'mc_cloze' (its own base template) for callers that don't target a
    // specific skill at all (e.g. the practice test suites calling compose() with a bare card) —
    // see lib/practiceGenerate.js's promptContext comment.
    compose({ ttsLocale, card, seedCardNames, skillType, problemType = 'mc_cloze', extraPrompt, vocabularyPolicy }) {
      const lang = languageName(ttsLocale) ?? 'the target language'
      const isVocab = card.kind === 'vocabulary'
      const sections = [
        `Generate a single multiple-choice cloze exercise to drill one specific skill in ${lang}. Follow the "## Task" steps below, then call the emit_mc_cloze_item tool.`,
        practiceCardContext(card),
        PROBLEM_TYPES[problemType].task({ lang, isVocab }),
        vocabularyPolicySection(vocabularyPolicy),
        skillSection(skillType, extraPrompt),
        seedSection(seedCardNames),
      ]
      return sections.filter(Boolean).join('\n\n')
    },
  },

  'practice.spelling': {
    version: '4',
    // problemType defaults to 'spelling' (its own base template) for callers that don't target a
    // specific skill at all — see lib/practiceGenerate.js's promptContext comment.
    compose({ ttsLocale, card, seedCardNames, skillType, problemType = 'spelling', extraPrompt, vocabularyPolicy }) {
      const lang = languageName(ttsLocale) ?? 'the target language'
      const isVocab = card.kind === 'vocabulary'
      const sections = [
        `Generate a single fill-in-the-blank spelling exercise to drill one specific skill in ${lang}. Respond only by calling the emit_spelling_item tool — no other text.`,
        practiceCardContext(card),
        PROBLEM_TYPES[problemType].task({ lang, isVocab }),
        vocabularyPolicySection(vocabularyPolicy),
        skillSection(skillType, extraPrompt),
        seedSection(seedCardNames),
      ]
      return sections.filter(Boolean).join('\n\n')
    },
  },

  // Used only by the Practice "Ask" button (api/practice-explain.js) — a plain
  // Q&A teacher persona, deliberately with none of chat.distill's save-block instructions,
  // so its responses are never parsed for save blocks on the frontend.
  'practice.explain': {
    version: '3',
    compose({ ttsLocale }) {
      const lang = languageName(ttsLocale) ?? 'the target language'
      return `You are a ${lang} teacher. Answer only the exact question the learner asked below, concisely and clearly, in English unless quoting or writing target-language examples. Don't ask follow-up questions, and don't volunteer anything beyond what was asked — in particular, don't explain why the labeled "correct" answer is correct unless the learner's question actually asks that.

This practice item was auto-generated and may itself be flawed — the labeled "correct" answer could be wrong, a distractor could be an equally valid alternative, or the sentence itself could be awkward, ambiguous, or not actually make sense. Don't assume the item is correct by default. If the learner's confusion traces back to a real problem with the item rather than a gap in their knowledge, say so plainly and explain what's actually wrong with it, rather than forcing a justification for a flawed "correct" answer or talking the learner out of a correct observation.`
    },
  },

  'practice.exemplar': {
    version: '11',
    // problemType defaults to 'exemplar' (its own base template) for callers that don't target a
    // specific skill at all — see lib/practiceGenerate.js's promptContext comment.
    compose({ ttsLocale, card, seedCardNames, skillType, problemType = 'exemplar', extraPrompt, vocabularyPolicy }) {
      const lang = languageName(ttsLocale) ?? 'the target language'
      const sections = [
        `Generate a single example-sentence exercise to drill one specific vocabulary card in ${lang}. Respond only by calling the emit_exemplar_item tool — no other text.`,
        practiceCardContext(card),
        PROBLEM_TYPES[problemType].task({ lang, cardName: card.name }),
        vocabularyPolicySection(vocabularyPolicy),
        skillSection(skillType, extraPrompt),
        seedSection(seedCardNames),
      ]
      return sections.filter(Boolean).join('\n\n')
    },
  },
}

export function compose(promptId, context) {
  const entry = registry[promptId]
  if (!entry) throw new Error(`Unknown prompt id: ${promptId}`)
  return entry.compose(context)
}

export function getPromptVersion(promptId) {
  const entry = registry[promptId]
  if (!entry) throw new Error(`Unknown prompt id: ${promptId}`)
  return entry.version
}
