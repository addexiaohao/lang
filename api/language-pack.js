import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { LanguagePack, LanguagePackError } from '../lib/languagePack.js'
import { resolveSkillType } from '../lib/skillTypes.js'

// The in-app editor for a project's language pack (plan-language-packs.md phases 3-4): the
// skill_type_def / drill_rule rows and projects.config.language_meta that lib/languagePack.js
// resolves. Lives next to the system prompt in SettingsModal.
//
//   GET    ?project_id=            -> { skill_types, drill_rules, meta, used_keys, question_types, weight_curves }
//   POST   ?project_id=  { target: 'skill_type'|'drill_rule', row }        -> { row }
//   PATCH  ?project_id=&id=  { target, patch }                            -> { row }
//   PATCH  ?project_id=  { meta: { vocabulary_policy?, sense_exempt_tags? } } -> { meta }
//   DELETE ?project_id=&id=&target=                                        -> 204
//
// skill_type_def.key / .kind are immutable once any `skill` row uses the key (used_keys); the
// server rejects such edits and deletes with 409. Every skill_type/drill_rule write is validated
// by building the prospective LanguagePack in memory first — a change that would break resolution
// (e.g. a gate pointing at a non-existent skill type) is refused with 400 before it's persisted.

const QUESTION_TYPES = ['mc_cloze', 'spelling', 'exemplar', 'discrimination_cloze']
const WEIGHT_CURVES = ['flat', 'rising', 'falling']

const SKILL_TYPE_COLS = ['key', 'kind', 'label', 'applies_when', 'gate', 'importance_default', 'display_order']
const DRILL_RULE_COLS = ['kind', 'skill_type_key', 'question_type', 'applies_when', 'priority', 'enabled', 'weight_curve', 'level_floor', 'level_ceiling', 'require_frame', 'prompt']

function pick(obj, cols) {
  const out = {}
  for (const c of cols) if (obj[c] !== undefined) out[c] = obj[c]
  return out
}

async function fetchPackRows(projectId) {
  const [{ data: skillTypes }, { data: drillRules }, { data: project }, { data: usedRows }] = await Promise.all([
    supabase.from('skill_type_def').select('*').eq('project_id', projectId).order('kind').order('display_order'),
    supabase.from('drill_rule').select('*').eq('project_id', projectId).order('kind').order('skill_type_key').order('priority', { ascending: false }),
    supabase.from('projects').select('config').eq('id', projectId).single(),
    supabase.from('skill').select('type, sense_type, knowledge_cards!inner(project_id)').eq('knowledge_cards.project_id', projectId),
  ])
  const used_keys = [...new Set((usedRows ?? []).map(resolveSkillType))]
  const meta = project?.config?.language_meta ?? { vocabulary_policy: '', sense_exempt_tags: [] }
  return { skill_types: skillTypes ?? [], drill_rules: drillRules ?? [], meta, used_keys }
}

// Throws LanguagePackError if the rows wouldn't resolve — same construction the runtime uses.
function assertResolvable(skillTypes, drillRules, meta) {
  new LanguagePack({ skillTypes, drillRules, meta })
}

export default async function handler(req, res) {
  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, id, target } = req.query
  if (!project_id) return res.status(400).json({ error: 'project_id required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  if (req.method === 'GET') {
    const rows = await fetchPackRows(project_id)
    return res.status(200).json({ ...rows, question_types: QUESTION_TYPES, weight_curves: WEIGHT_CURVES })
  }

  if (req.method === 'POST') {
    const { target: t, row } = req.body ?? {}
    if (t !== 'skill_type' && t !== 'drill_rule') return res.status(400).json({ error: "target must be 'skill_type' or 'drill_rule'" })
    if (!row || typeof row !== 'object') return res.status(400).json({ error: 'row required' })

    const table = t === 'skill_type' ? 'skill_type_def' : 'drill_rule'
    const cols = t === 'skill_type' ? SKILL_TYPE_COLS : DRILL_RULE_COLS
    const record = { ...pick(row, cols), project_id }
    if (t === 'skill_type' && (!record.key?.trim() || !record.kind || !record.label?.trim())) {
      return res.status(400).json({ error: 'key, kind, label required' })
    }
    if (t === 'drill_rule' && (!record.kind || !record.skill_type_key?.trim() || !record.question_type)) {
      return res.status(400).json({ error: 'kind, skill_type_key, question_type required' })
    }

    const current = await fetchPackRows(project_id)
    const prospective = t === 'skill_type'
      ? { st: [...current.skill_types, record], dr: current.drill_rules }
      : { st: current.skill_types, dr: [...current.drill_rules, record] }
    try {
      assertResolvable(prospective.st, prospective.dr, current.meta)
    } catch (e) {
      if (e instanceof LanguagePackError) return res.status(400).json({ error: e.message })
      throw e
    }

    const { data, error } = await supabase.from(table).insert(record).select('*').single()
    if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.message })
    return res.status(201).json({ row: data })
  }

  if (req.method === 'PATCH') {
    // Whole-pack meta edit (no row id).
    if (!id && req.body?.meta !== undefined) {
      const { vocabulary_policy, sense_exempt_tags } = req.body.meta
      const { data: proj } = await supabase.from('projects').select('config').eq('id', project_id).single()
      const language_meta = { ...(proj?.config?.language_meta ?? {}) }
      if (vocabulary_policy !== undefined) language_meta.vocabulary_policy = String(vocabulary_policy)
      if (sense_exempt_tags !== undefined) {
        if (!Array.isArray(sense_exempt_tags)) return res.status(400).json({ error: 'sense_exempt_tags must be an array' })
        language_meta.sense_exempt_tags = sense_exempt_tags.map(String).map(s => s.trim()).filter(Boolean)
      }
      const nextConfig = { ...(proj?.config ?? {}), language_meta }
      const { error } = await supabase.from('projects').update({ config: nextConfig }).eq('id', project_id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ meta: language_meta })
    }

    const { target: t, patch } = req.body ?? {}
    if (!id) return res.status(400).json({ error: 'id required' })
    if (t !== 'skill_type' && t !== 'drill_rule') return res.status(400).json({ error: "target must be 'skill_type' or 'drill_rule'" })
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'patch required' })

    const table = t === 'skill_type' ? 'skill_type_def' : 'drill_rule'
    const cols = t === 'skill_type' ? SKILL_TYPE_COLS : DRILL_RULE_COLS
    const current = await fetchPackRows(project_id)
    const list = t === 'skill_type' ? current.skill_types : current.drill_rules
    const existing = list.find(r => r.id === id)
    if (!existing) return res.status(404).json({ error: 'row not found' })

    const update = pick(patch, cols)
    // key/kind are frozen once the key is referenced by a skill row.
    if (t === 'skill_type' && current.used_keys.includes(existing.key)) {
      if ((update.key !== undefined && update.key !== existing.key) || (update.kind !== undefined && update.kind !== existing.kind)) {
        return res.status(409).json({ error: `"${existing.key}" is in use by existing skills — its key and kind can't change (label and rules still can)` })
      }
    }

    const merged = { ...existing, ...update }
    const nextList = list.map(r => (r.id === id ? merged : r))
    try {
      assertResolvable(
        t === 'skill_type' ? nextList : current.skill_types,
        t === 'drill_rule' ? nextList : current.drill_rules,
        current.meta,
      )
    } catch (e) {
      if (e instanceof LanguagePackError) return res.status(400).json({ error: e.message })
      throw e
    }

    const { data, error } = await supabase.from(table).update(update).eq('id', id).eq('project_id', project_id).select('*').single()
    if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.message })
    return res.status(200).json({ row: data })
  }

  if (req.method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'id required' })
    if (target !== 'skill_type' && target !== 'drill_rule') return res.status(400).json({ error: "target must be 'skill_type' or 'drill_rule'" })

    if (target === 'skill_type') {
      const current = await fetchPackRows(project_id)
      const existing = current.skill_types.find(r => r.id === id)
      if (!existing) return res.status(404).json({ error: 'row not found' })
      if (current.used_keys.includes(existing.key)) {
        return res.status(409).json({ error: `"${existing.key}" is in use by existing skills — disable its drill rules instead of deleting it` })
      }
    }

    const table = target === 'skill_type' ? 'skill_type_def' : 'drill_rule'
    const { error } = await supabase.from(table).delete().eq('id', id).eq('project_id', project_id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(204).end()
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
