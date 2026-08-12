import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

const PAGE_SIZE = 25

// Total possible cells = product of each axis's value-list length.
function cellCount(axisValues) {
  return Object.values(axisValues ?? {}).reduce((acc, values) => acc * (Array.isArray(values) ? values.length : 1), 1)
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, id, cell_id, q, tag, limit = String(PAGE_SIZE), offset = '0' } = req.query
  if (!project_id) return res.status(400).json({ error: 'project_id required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  if (req.method === 'PATCH') {
    if (!cell_id) return res.status(400).json({ error: 'cell_id required' })

    const { skill } = req.body ?? {}
    if (skill === undefined) return res.status(400).json({ error: 'skill required' })
    if (skill !== null && (!Number.isInteger(skill) || skill < 0 || skill > 10)) {
      return res.status(400).json({ error: 'skill must be an integer between 0 and 10, or null' })
    }

    // Scope the update to a cell belonging to a table in this project.
    const { data: cell, error: cellErr } = await supabase
      .from('table_cells')
      .select('id, table_id, tables!inner(project_id)')
      .eq('id', cell_id)
      .eq('tables.project_id', project_id)
      .single()
    if (cellErr || !cell) return res.status(404).json({ error: 'Cell not found' })

    const { data, error } = await supabase
      .from('table_cells')
      .update({ skill, updated_at: new Date().toISOString() })
      .eq('id', cell_id)
      .select('id, cell_key, axis_values, skill')
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  if (id) {
    const { data, error } = await supabase
      .from('tables')
      .select(`
        id, name, axes, axis_values, tags, notes, created_at,
        table_cells(
          id, cell_key, axis_values, skill,
          source_table_cells(
            source_id, excerpt, note,
            sources(id, original_text, created_at, contexts(id, name))
          )
        )
      `)
      .eq('project_id', project_id)
      .eq('id', id)
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  let query = supabase
    .from('tables')
    .select('id, name, axes, axis_values, tags, notes, created_at, table_cells(count)', { count: 'exact' })
    .eq('project_id', project_id)
    .order('name', { ascending: true })
    .range(Number(offset), Number(offset) + Number(limit) - 1)

  if (q) query = query.ilike('name', `%${q}%`)
  if (tag) query = query.contains('tags', [tag])

  const { data, error, count } = await query
  if (error) return res.status(500).json({ error: error.message })
  const tables = data.map(({ table_cells, ...t }) => ({
    ...t,
    cell_count: cellCount(t.axis_values),
    filled_count: table_cells?.[0]?.count ?? 0,
  }))
  return res.status(200).json({ tables, total: count })
}
