// The streaming tool-call loop shared by api/chat.js (real Supabase-backed tool execution) and
// the chat prompt test suite (fixture-based tool execution, see tests/helpers/fixture-tools.js).
// Both call runChatLoop() directly so tests exercise the real generation logic against the real
// Anthropic API, not a re-implementation of it — only the tool *execution* (a thin data lookup)
// differs between production and tests.

export const CHAT_MODEL = 'claude-sonnet-4-6'

export const tools = [
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
    description: 'Search for existing knowledge cards by name. Call this before emitting a save:knowledge_card block. If results are returned, reference the existing card instead of emitting a save block. For a vocabulary word, always pass `excerpt` (the exact sentence it appears in here) — a match on a vocabulary card runs a sense check comparing this excerpt against the card\'s existing sense(s), returned as `senses`/`sense_check` on the result.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or concept to search for' },
        excerpt: { type: 'string', description: 'The exact sentence where this word appears in the current source. Required for vocabulary lookups so a sense check can run against any match.' },
      },
      required: ['query'],
    },
  },
]

function addConvCache(msgs) {
  if (!msgs.length) return msgs
  const last = msgs[msgs.length - 1]
  const content = Array.isArray(last.content)
    ? [...last.content.slice(0, -1), { ...last.content.at(-1), cache_control: { type: 'ephemeral' } }]
    : [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }]
  return [...msgs.slice(0, -1), { ...last, content }]
}

// Runs the multi-turn stream -> tool_use -> tool_result loop until the model stops without
// requesting a tool call. `executeTool(name, input)` resolves one tool call to its result value
// (JSON-stringified internally); `onText(chunk)` is called for each streamed text delta, in
// order, across every turn — the caller decides what to do with it (write to an HTTP response,
// or nothing, since the full text is also returned at the end).
//
// Returns { text, message } — `text` is the full concatenated text across all turns, `message`
// is the final Anthropic Message (stop_reason something other than 'tool_use').
// `onUsage`, if given, fires once per Anthropic call (every turn of the tool loop, not just the
// last) with { model, usage, stopReason, latencyMs } — lets a DB-backed caller (api/chat.js) log
// each turn to llm_api_call without this function itself depending on Supabase, which would break
// the DB-free test suites (tests/helpers/prompt-suite.js) that call runChatLoop directly.
export async function runChatLoop({ anthropic, model = CHAT_MODEL, systemPrompt, messages, executeTool, onText, onUsage }) {
  let currentMessages = messages
  let fullText = ''

  while (true) {
    const startedAt = Date.now()
    const stream = anthropic.messages.stream({
      model,
      max_tokens: 8192,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: addConvCache(currentMessages),
      tools,
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullText += event.delta.text
        onText?.(event.delta.text)
      }
    }

    const message = await stream.finalMessage()
    onUsage?.({ model, usage: message.usage, stopReason: message.stop_reason, latencyMs: Date.now() - startedAt })
    if (message.stop_reason !== 'tool_use') return { text: fullText, message }

    const toolResults = await Promise.all(
      message.content
        .filter(b => b.type === 'tool_use')
        .map(async b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: JSON.stringify((await executeTool(b.name, b.input)) ?? []),
        }))
    )

    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: message.content },
      { role: 'user', content: toolResults },
    ]
  }
}
