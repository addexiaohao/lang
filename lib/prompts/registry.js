// Prompt registry — prompts identified by string id, each with a version and a compose(context) fn.
// compose() assembles shared fragments (lib/prompts/fragments.js) + a task-specific body +,
// for chat.distill only, the project's user-editable system_prompt layer (DB-backed).
//
// Practice prompts (practice.mc_cloze, practice.exemplar) are code-only — they have no
// user-editable layer, since that would require a DB change (see CLAUDE.md).

import { langProject, taxonomyCards, tagsCatalog, languageName } from './fragments.js'

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
  "skill": 1,
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
  "skill": 1,
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

- \`skill\` (1–10): set to 1 for anything new. Not used for \`table\` kind.
- \`importance\` (1–10): common core 8–10, rare edge cases 1–3

## Tags

See the **Tag catalog** section below for existing tags and instructions on proposing new ones.

## Details

Emit \`"details": {}\` when no extra fields are needed (which is true most of the time).

## Tables

Some knowledge is a grid of forms sharing axes, where each cell only makes sense in relation to the others (e.g. adjective declension by case × gender × article_type). This is NOT a \`save:knowledge_card\` — use \`save:table\` once to define the grid, then \`save:table_cell\` for each cell encountered.

Decision test: do the items share axes and only make sense together?
- Yes → table + cells
- No → individual cards linked by a shared tag (e.g. nach/zu/in/auf/an are five independent cards tagged "destination-prepositions", NOT a table)

\`\`\`save:table
{
  "ref": "t1",
  "name": "Adjective declension",
  "axes": ["case", "gender", "article_type"],
  "axis_values": {
    "case": ["nominative", "accusative", "dative", "genitive"],
    "gender": ["masculine", "feminine", "neuter", "plural"],
    "article_type": ["strong", "mixed", "weak"]
  },
  "tags": ["adjectives", "declension"],
  "notes": "strong = no preceding article; weak = definite article present"
}
\`\`\`

\`\`\`save:table_cell
{
  "table_ref": "t1",
  "axis_values": { "case": "accusative", "gender": "masculine", "article_type": "strong" },
  "skill": 1
}
\`\`\`

When a source contains a specific inflected form belonging to a table cell, use \`save:link_table_cell\` targeting that ONE cell. Never link a source to the table as a whole.

\`\`\`save:link_table_cell
{
  "source_ref": 1,
  "table_ref": "t1",
  "axis_values": { "case": "accusative", "gender": "masculine", "article_type": "strong" },
  "excerpt": "den",
  "note": ""
}
\`\`\`

Rules:
- \`ref\` on \`save:table\` follows the same conversation-wide counter as \`save:source\` refs — continue from the highest integer already used.
- \`table_ref\` in \`save:table_cell\` and \`save:link_table_cell\` matches the \`ref\` of its parent \`save:table\` block.
- \`skill\` on cells is optional; omit if just registering that the cell was discussed.
- If an existing table is found via \`search_tables\`, include \`"existing_id": "<uuid>"\` on the \`save:table\` block and continue emitting cells normally.
- Before creating a table, call \`search_tables\`. Before creating/updating a cell, call \`search_table_cells\`.

## Before saving sources

Call \`search_sources\` with the \`original_text\` before emitting any \`save:source\` block.
- No match → emit \`save:source\` as normal.
- Match → emit \`save:source\` with \`"existing_id"\` set to the matched source's id.

## Before saving knowledge cards

Call \`search_knowledge_cards\` with the card name before emitting any \`save:knowledge_card\` block.
- No match → emit \`save:knowledge_card\` as normal.
- Match → emit \`save:link_card\` instead (include \`existing_id\`, \`name\`, \`kind\`, \`tags\`, \`skill\`, \`importance\` from the search result).

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

function avoidSection(avoid) {
  if (!avoid.length) return ''
  return `## Avoid these sense_keys — this request must use a different one\n${avoid.join(', ')}`
}

function seedSection(seedCardNames) {
  if (!seedCardNames.length) return ''
  return `## Other vocabulary already known in this project\nWeave these in naturally where they fit — do not force them: ${seedCardNames.join(', ')}`
}

const registry = {
  'chat.distill': {
    version: '1',
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
    version: '3',
    compose({ ttsLocale, card, avoid, seedCardNames }) {
      const lang = languageName(ttsLocale) ?? 'the target language'
      const isVocab = card.kind === 'vocabulary'
      const sections = [
        `Generate a single multiple-choice cloze exercise to drill one specific ${card.kind} card in ${lang}. Respond only by calling the emit_mc_cloze_item tool — no other text.`,
        practiceCardContext(card),
        `## Task
Write ONE novel ${lang} sentence testing this card, with exactly one blank marked \`___\`, and 3–4 answer options where exactly one is correct.

- The sentence must be novel, natural, and complex enough that surrounding context supports comprehension — not a textbook stub.
- Every distractor must be genuinely plausible in the frame: wrong only along the dimension this card tests, never ungrammatical for a reason unrelated to the target card.
- \`answer\` must exactly match one of the strings in \`options\`, copied verbatim.
- \`sense_key\`: a short slug for the specific sense/frame tested (e.g. "motion.physical.place").
- \`translation\`: a full, natural English translation of the complete sentence, with the blank filled in by \`answer\`.${isVocab ? `
- This card tests word meaning, so also fill in \`option_meanings\`: one short English gloss per entry in \`options\`, same order, same length. Each gloss is what makes that option right or wrong in this specific blank — not just a dictionary definition of the word in isolation.` : ''}`,
        avoidSection(avoid),
        seedSection(seedCardNames),
      ]
      return sections.filter(Boolean).join('\n\n')
    },
  },

  // Used only by the Practice "Why?"/"Explain" button (api/practice-explain.js) — a plain
  // Q&A teacher persona, deliberately with none of chat.distill's save-block instructions,
  // so its responses are never parsed for save blocks on the frontend.
  'practice.explain': {
    version: '1',
    compose({ ttsLocale }) {
      const lang = languageName(ttsLocale) ?? 'the target language'
      return `You are a ${lang} teacher. Answer the learner's question about the practice item below concisely and clearly, in English unless quoting or writing target-language examples. Don't ask follow-up questions.`
    },
  },

  'practice.exemplar': {
    version: '3',
    compose({ ttsLocale, card, avoid, seedCardNames }) {
      const lang = languageName(ttsLocale) ?? 'the target language'
      const sections = [
        `Generate a single example-sentence exercise to drill one specific vocabulary card in ${lang}. Respond only by calling the emit_exemplar_item tool — no other text.`,
        practiceCardContext(card),
        `## Task
Write ONE novel ${lang} sentence using the target word/lemma above, inflected as needed.

- The target word must be load-bearing: apply this test explicitly before answering — if it were removed or swapped for a plausible alternative, the sentence must become false, odd, or ambiguous.
- The sentence must be novel, natural, and complex enough that surrounding context supports comprehension — not a textbook stub.
- In \`sentence\`, wrap the inflected target word itself in ⟦⟧ markers (U+27E6 / U+27E7) — e.g. "Er ⟦geht⟧ jeden Tag ins Büro." Exactly one marker pair, around the inflected surface form only, not the whole clause.
- \`sense_key\`: a short slug for the specific sense/context used.
- \`translation\`: a full, natural English translation of the complete sentence (markers stripped).${avoid.length ? `\n- This is a follow-up request — the learner already saw ${avoid.length} sentence${avoid.length > 1 ? 's' : ''} for this card. The new sentence must be MORE constraining than those (narrower context, fewer possible readings) and must use a different sense_key.` : ''}`,
        avoidSection(avoid),
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
