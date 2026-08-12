// Unified library view: merges knowledge_cards and tables into one tagged-union list so the
// frontend (CardsPanel) can render one search/scroll/filter surface without knowing they're two
// SQL tables underneath. See plan.md §7.1 — "the frontend must never need to know tables and
// knowledge_cards are different relations."
import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

const PAGE_SIZE = 25
const CARD_KINDS = new Set(['vocabulary', 'grammar', 'expression'])

function cellCount(axisValues) {
  return Object.values(axisValues ?? {}).reduce((acc, values) => acc * (Array.isArray(values) ? values.length : 1), 1)
}

async function fetchCards(project_id, { q, tag, kind }) {
  let query = supabase
    .from('knowledge_cards')
    .select('id, name, kind, tags, skill, importance, created_at, source_knowledge(count)')
    .eq('project_id', project_id)
  if (q) query = query.ilike('name', `%${q}%`)
  if (tag) query = query.contains('tags', [tag])
  if (kind) query = query.eq('kind', kind)
  const { data, error } = await query
  if (error) return []
  return data.map(({ source_knowledge, ...c }) => ({
    type: 'card',
    ...c,
    link_count: source_knowledge?.[0]?.count ?? 0,
  }))
}

async function fetchTables(project_id, { q, tag }) {
  let query = supabase
    .from('tables')
    .select('id, name, axes, axis_values, tags, notes, created_at, table_cells(count)')
    .eq('project_id', project_id)
  if (q) query = query.ilike('name', `%${q}%`)
  if (tag) query = query.contains('tags', [tag])
  const { data, error } = await query
  if (error) return []
  return data.map(({ table_cells, ...t }) => ({
    type: 'table',
    ...t,
    cell_count: cellCount(t.axis_values),
    filled_count: table_cells?.[0]?.count ?? 0,
  }))
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, q, tag, kind, limit = String(PAGE_SIZE), offset = '0' } = req.query
  if (!project_id) return res.status(400).json({ error: 'project_id required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  // `kind` doubles as the pseudo-type filter: a card kind restricts to cards only,
  // 'table' restricts to tables only, absent means both.
  const wantTables = !kind || kind === 'table'
  const wantCards = !kind || CARD_KINDS.has(kind)

  const [cardItems, tableItems] = await Promise.all([
    wantCards ? fetchCards(project_id, { q, tag, kind: CARD_KINDS.has(kind) ? kind : undefined }) : [],
    wantTables ? fetchTables(project_id, { q, tag }) : [],
  ])

  const merged = [...cardItems, ...tableItems].sort((a, b) => a.name.localeCompare(b.name))
  const total = merged.length
  const off = Math.max(parseInt(offset) || 0, 0)
  const lim = Math.min(parseInt(limit) || PAGE_SIZE, 500)
  const items = merged.slice(off, off + lim)

  // cardTotal is surfaced separately so the frontend's "select all" (practice can only target
  // cards) can compare against the right denominator, not the combined card+table total.
  return res.status(200).json({ items, total, cardTotal: cardItems.length })
}
