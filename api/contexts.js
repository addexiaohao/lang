import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

export default async function handler(req, res) {
  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  if (req.method === 'GET') {
    const { project_id } = req.query
    try {
      await requireProjectAccess(user.id, project_id)
    } catch (e) {
      if (e instanceof AuthError) return res.status(403).json({ error: e.message })
      throw e
    }

    const { data, error } = await supabase
      .from('contexts')
      .select('id, name, description')
      .eq('project_id', project_id)
      .order('created_at', { ascending: true })

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  if (req.method === 'POST') {
    const { project_id, name } = req.body ?? {}
    if (!name) return res.status(400).json({ error: 'name is required' })

    try {
      await requireProjectAccess(user.id, project_id)
    } catch (e) {
      if (e instanceof AuthError) return res.status(403).json({ error: e.message })
      throw e
    }

    const { data, error } = await supabase
      .from('contexts')
      .insert({ project_id, name })
      .select('id, name, description')
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
