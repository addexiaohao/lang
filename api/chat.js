import Anthropic from '@anthropic-ai/sdk'
import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { getProjectConfig } from '../lib/projectConfig.js'
import { findDuplicateSource } from '../lib/normalizeSourceText.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Part 1: universal structure — formats, tools, card rules. Same for every project and user.
const PART1 = `\
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
DO NOT store: translations, explanations, grammar rules, example sentences, conjugated/declined forms

## Kind values

- **vocabulary** — any single word or lemma
- **grammar** — a productive pattern (e.g. "Perfekt with haben")
- **expression** — fixed chunk learned whole; \`details: { register }\`

Do NOT use \`save:knowledge_card\` for paradigm tables — see the **Tables** section below.

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

// Part 2: assembled from project columns — context_required and tts_locale.
function buildPart2(config) {
  const { ttsLocale, contextsRequired } = config
  const sections = []

  if (contextsRequired) {
    sections.push(`## Context\nEach source represents text encountered in a specific context (e.g. a TV show episode, a book chapter, a conversation partner). The user selects the context for each source card before it can be saved.`)
  }

  if (ttsLocale) {
    const langTag = ttsLocale.split('-')[0]
    sections.push(`## Inline target-language text\n\nWhenever you write a target-language word or phrase in your prose (NOT inside save blocks), wrap it in <${langTag}>…</${langTag}> tags so the user can click each word to hear pronunciation.\n\nDo NOT use <${langTag}> tags inside save blocks — only in prose.`)
  }

  return sections.join('\n\n')
}

function buildSystemPrompt(config, userPrompt, tags) {
  const part2 = buildPart2(config)
  const part3 = userPrompt?.trim() ?? ''

  let prompt = [PART1, part2, part3].filter(Boolean).join('\n\n')

  const tagNames = tags.length > 0 ? tags.map(t => t.name).join(', ') : '(none yet)'
  prompt += `\n\n## Tag catalog\n\nExisting tags — use these verbatim, exact spelling. Do NOT invent variations (e.g. if the catalog has \`verb-irregular\`, do not use \`irregular\`):\n\n${tagNames}\n\nIf you need tags not listed above, you MUST declare them in a \`save:proposed_tags\` block at the **very beginning** of your response, before any prose:\n\n\`\`\`save:proposed_tags\n["new-tag-1", "new-tag-2"]\n\`\`\`\n\nThen use those names in \`tags\` arrays normally. Omit the block if all tags you need are already in the catalog.`

  return prompt
}

const tools = [
  {
    name: 'search_sources',
    description: 'Check if a source with the same original_text has already been saved. Call this before emitting a save:source block.',
    input_schema: {
      type: 'object',
      properties: {
        original_text: { type: 'string', description: 'The original text to check for duplicates (matching ignores case, punctuation, and whitespace differences)' },
      },
      required: ['original_text'],
    },
  },
  {
    name: 'search_knowledge_cards',
    description: 'Search for existing knowledge cards by name. Call this before emitting a save:knowledge_card block. If results are returned, reference the existing card instead of emitting a save block.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or concept to search for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_tables',
    description: 'Search for existing tables by name. Call this before emitting a save:table block. If a match is found, include existing_id on the save:table block instead of creating a duplicate.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Table name or concept to search for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_table_cells',
    description: 'Check if a specific cell already exists in a table. Call this before emitting a save:table_cell block. Returns existing cell data (including id and skill) if the cell has been recorded before.',
    input_schema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'UUID of the table to search in' },
        axis_values: { type: 'object', description: 'The axis values for the specific cell, e.g. {"case": "accusative", "gender": "masculine"}' },
      },
      required: ['table_id', 'axis_values'],
    },
  },
]

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, messages } = req.body

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' })
  }

  const [{ data: project }, { data: tagsData }] = await Promise.all([
    supabase.from('projects').select('system_prompt, config, tts_locale, context_required').eq('id', project_id).single(),
    supabase.from('tags').select('name').eq('project_id', project_id).order('name'),
  ])
  const tags = tagsData ?? []

  const projectConfig = getProjectConfig(project ?? {})
  if (projectConfig.contextsRequired === null) {
    return res.status(500).json({ error: 'Project is missing context_required — set it before using chat.' })
  }

  const systemPrompt = buildSystemPrompt(projectConfig, project?.system_prompt, tags)

  async function executeSearchSources(originalText) {
    const { data, error } = await supabase
      .from('sources')
      .select('id, original_text')
      .eq('project_id', project_id)
    if (error) return []
    const match = findDuplicateSource(data ?? [], originalText)
    return match ? [match] : []
  }

  async function executeSearchKnowledgeCards(query) {
    const { data, error } = await supabase
      .from('knowledge_cards')
      .select('id, name, kind, tags, skill, importance')
      .ilike('name', `%${query}%`)
      .eq('project_id', project_id)
      .limit(5)
    return error ? [] : data
  }

  async function executeSearchTables(query) {
    const { data, error } = await supabase
      .from('tables')
      .select('id, name, axes, axis_values, tags')
      .ilike('name', `%${query}%`)
      .eq('project_id', project_id)
      .limit(5)
    return error ? [] : data
  }

  async function executeSearchTableCells(tableId, axisValues) {
    const cellKey = Object.keys(axisValues)
      .sort()
      .map(k => String(axisValues[k]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
      .join('-')
    const { data, error } = await supabase
      .from('table_cells')
      .select('id, cell_key, axis_values, skill')
      .eq('table_id', tableId)
      .eq('cell_key', cellKey)
      .limit(1)
    return error ? [] : data
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Transfer-Encoding', 'chunked')
  res.setHeader('Cache-Control', 'no-cache')
  // Suppress Vercel's default response buffering
  res.setHeader('X-Accel-Buffering', 'no')

  let currentMessages = messages

  function addConvCache(msgs) {
    if (!msgs.length) return msgs
    const last = msgs[msgs.length - 1]
    const content = Array.isArray(last.content)
      ? [...last.content.slice(0, -1), { ...last.content.at(-1), cache_control: { type: 'ephemeral' } }]
      : [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }]
    return [...msgs.slice(0, -1), { ...last, content }]
  }

  while (true) {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: addConvCache(currentMessages),
      tools,
    })

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        res.write(event.delta.text)
      }
    }

    const message = await stream.finalMessage()
    if (message.stop_reason !== 'tool_use') break

    const toolResults = await Promise.all(
      message.content
        .filter(b => b.type === 'tool_use')
        .map(async b => {
          let result
          if (b.name === 'search_sources') {
            result = await executeSearchSources(b.input.original_text)
          } else if (b.name === 'search_knowledge_cards') {
            result = await executeSearchKnowledgeCards(b.input.query)
          } else if (b.name === 'search_tables') {
            result = await executeSearchTables(b.input.query)
          } else if (b.name === 'search_table_cells') {
            result = await executeSearchTableCells(b.input.table_id, b.input.axis_values)
          }
          return {
            type: 'tool_result',
            tool_use_id: b.id,
            content: JSON.stringify(result ?? []),
          }
        })
    )

    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: message.content },
      { role: 'user', content: toolResults },
    ]
  }

  res.end()
}
