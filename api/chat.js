import Anthropic from '@anthropic-ai/sdk'
import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { getProjectConfig } from '../lib/projectConfig.js'
import { findDuplicateSource } from '../lib/normalizeSourceText.js'
import { compose } from '../lib/prompts/registry.js'
import { runChatLoop } from '../lib/chatLoop.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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

  const systemPrompt = compose('chat.distill', { config: projectConfig, userPrompt: project?.system_prompt, tags })

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

  async function executeTool(name, input) {
    if (name === 'search_sources') return executeSearchSources(input.original_text)
    if (name === 'search_knowledge_cards') return executeSearchKnowledgeCards(input.query)
    if (name === 'search_tables') return executeSearchTables(input.query)
    if (name === 'search_table_cells') return executeSearchTableCells(input.table_id, input.axis_values)
    return []
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Transfer-Encoding', 'chunked')
  res.setHeader('Cache-Control', 'no-cache')
  // Suppress Vercel's default response buffering
  res.setHeader('X-Accel-Buffering', 'no')

  await runChatLoop({
    anthropic,
    systemPrompt,
    messages,
    executeTool,
    onText: text => res.write(text),
  })

  res.end()
}
