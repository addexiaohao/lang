import Anthropic from '@anthropic-ai/sdk'
import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function buildSystemPrompt(basePrompt, tags) {
  if (!tags || tags.length === 0) return basePrompt

  const tagLines = tags.map(t => {
    const label = t.display_name && t.display_name !== t.name ? `"${t.name}" [${t.display_name}]` : `"${t.name}"`
    return `- ${label}${t.description ? ` — ${t.description}` : ''}`
  }).join('\n')
  return basePrompt + `
## Tag catalog
Use these tags (exact spelling). The bracket shows the short display label the user sees.
You may propose a new tag if none fit — add it to \`tags\` and include a \`new_tags\` entry with \`name\` + \`display_name\`.

${tagLines}
`
}

const tools = [
  {
    name: 'search_sources',
    description: 'Check if a source with the same original_text has already been saved. Call this before emitting a save:source block.',
    input_schema: {
      type: 'object',
      properties: {
        original_text: { type: 'string', description: 'The exact original text to check for duplicates' },
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

  const [{ data: project }, { data: tags = [] }] = await Promise.all([
    supabase.from('projects').select('system_prompt, config').eq('id', project_id).single(),
    supabase.from('tags').select('name, display_name, description').eq('project_id', project_id).order('name'),
  ])

  const systemPrompt = buildSystemPrompt(project?.system_prompt ?? '', tags)

  async function executeSearchSources(originalText) {
    const { data, error } = await supabase
      .from('sources')
      .select('id, original_text')
      .eq('original_text', originalText)
      .eq('project_id', project_id)
      .limit(1)
    return error ? [] : data
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
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
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
