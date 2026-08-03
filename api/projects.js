import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

const PLACEHOLDER_PROMPT = 'You are a language learning assistant. Edit this prompt to configure the agent.'

export default async function handler(req, res) {
  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  if (req.method === 'GET') {
    const [{ data: projects, error }, { data: settings }] = await Promise.all([
      supabase
        .from('projects')
        .select('id, name, config, system_prompt, tts_locale, context_required')
        .eq('user_id', user.id)
        .order('created_at'),
      supabase
        .from('user_settings')
        .select('default_project_id')
        .eq('user_id', user.id)
        .single(),
    ])

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({
      projects: projects ?? [],
      default_project_id: settings?.default_project_id ?? null,
    })
  }

  if (req.method === 'POST') {
    const { name, config, tts_locale, context_required } = req.body ?? {}
    if (!name?.trim()) return res.status(400).json({ error: 'name required' })

    const { data: project, error } = await supabase
      .from('projects')
      .insert({
        name: name.trim(),
        config: config ?? {},
        user_id: user.id,
        system_prompt: PLACEHOLDER_PROMPT,
        tts_locale: tts_locale ?? null,
        context_required: context_required ?? null,
      })
      .select('id, name, config, system_prompt, tts_locale, context_required')
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ project })
  }

  if (req.method === 'PATCH') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id required' })

    try {
      await requireProjectAccess(user.id, id)
    } catch (e) {
      if (e instanceof AuthError) return res.status(403).json({ error: e.message })
      throw e
    }

    const { system_prompt, config, tts_locale, context_required } = req.body ?? {}
    const updates = {}

    if (system_prompt !== undefined || config !== undefined) {
      const { data: current } = await supabase
        .from('projects')
        .select('config, system_prompt')
        .eq('id', id)
        .single()

      if (system_prompt !== undefined) {
        if (current?.system_prompt) {
          await supabase
            .from('system_prompt_history')
            .insert({ project_id: id, prompt: current.system_prompt })
        }
        updates.system_prompt = system_prompt
      }

      if (config !== undefined) {
        updates.config = { ...(current?.config ?? {}), ...config }
      }
    }

    if (tts_locale !== undefined) updates.tts_locale = tts_locale
    if (context_required !== undefined) updates.context_required = context_required

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' })
    }

    const { data: project, error } = await supabase
      .from('projects')
      .update(updates)
      .eq('id', id)
      .select('id, name, config, system_prompt, tts_locale, context_required')
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ project })
  }

  if (req.method === 'PUT') {
    const { default_project_id } = req.body ?? {}
    if (!default_project_id) return res.status(400).json({ error: 'default_project_id required' })

    try {
      await requireProjectAccess(user.id, default_project_id)
    } catch (e) {
      if (e instanceof AuthError) return res.status(403).json({ error: e.message })
      throw e
    }

    const { error } = await supabase
      .from('user_settings')
      .upsert({ user_id: user.id, default_project_id, updated_at: new Date().toISOString() })

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ default_project_id })
  }

  return res.status(405).end()
}
