import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { selectScheduledPracticeSkills, RETIRED_LEVEL } from '../lib/practiceSelection.js'
import { FAILURE_CAP } from '../lib/practiceScheduling.js'
import { PRACTICE_STATES } from '../lib/practiceStates.js'
import { resolveSkillType } from '../lib/skillTypes.js'

// A sense skill's DB `type` is always literally 'meaning' (see lib/skillTypes.js's sense_type
// column comment) — every raw `skill` row read below resolves it to the ONE external skill_type
// string every consumer (CardsPanel, PracticeStart, lib/practiceSelection.js's gating) expects,
// same as schema.sql's skill_practice_state() already does for the browse_skills/browse_cards path.
// `dbType` is kept alongside (not stripped) — lib/skillTypes.js's isGateSatisfied() needs the
// literal DB type (e.g. every sense of a sense-split card is still DB type 'meaning') to match a
// gate's prereqType, which the resolved external type (a sense key) can't do.
function resolveRow(row) {
  const { sense_type, ...s } = row
  return { ...s, type: resolveSkillType(row), dbType: row.type }
}

// Lists `skill` rows project-wide, each with its owning card embedded — skills are the practice
// unit now (see lib/practiceRules.js), so the practice pickers need them as first-class rows
// rather than deriving them from a card client-side:
//   ?card_ids=a,b,c        -> every skill row for those cards, unordered (CardsPanel's "select a
//                              card, practice all its skills")
//   ?sort=recent&limit=N   -> the N most-recently-created skill rows project-wide
//   ?sort=weighted&limit=N -> quick-start: every card in the project is loaded ONCE, each with its
//                              full skill set (including its scheduling fields and last-attempt
//                              timestamp), then N skills are selected via
//                              lib/practiceSelection.js's selectScheduledPracticeSkills —
//                              plan.md ("Practice Scheduling")'s bucketing (relearning > overdue
//                              stable > never), importance/staleness weighting, gating, cooldown,
//                              and same-card/same-type interleaving. The response also carries
//                              `relearning_count`/`failure_cap`/`cap_hit` (plan.md §4) so the
//                              client can surface "no new words until this shrinks".
//   ?limit=1&offset=N      -> single row at offset N, for uniform random sampling (random-start),
//                              same pattern api/knowledge-cards.js uses for cards
//   ?browse=1&...          -> Skills page (plan.md): filtered/sorted/paginated rows with derived
//                              practice state, via schema.sql's browse_skills RPC — see below.
//                              `schedule_state` (never/learning/relearning/stable/retired) filters
//                              on the same column the summary strip below counts — clicking a
//                              strip badge sets this, same interaction as clicking a histogram bar
//                              sets level_min/level_max
//   ?histogram=1&...       -> Skills page's level histogram, via skill_level_histogram RPC — also
//                              respects `schedule_state` (only level itself is its own excluded axis)
//   ?state_counts=1&...    -> Skills page's schedule-state summary strip (never/learning/
//                              relearning/stable/retired counts), via skill_schedule_state_counts
//                              RPC — same full filter set as ?browse=1 (including level), MINUS
//                              schedule_state itself — same "exclude your own axis" reasoning as
//                              the histogram excluding level, so every badge's count stays visible
//                              for clicking regardless of which one is currently active
//   ?history_for=id        -> every practice_attempt row for one skill, most recent first (row
//                              expansion, plan.md §6) — the only path that returns `conversation`,
//                              since list queries deliberately omit that large blob (plan.md §8)
//
// Both the weighted quick-start pool and the plain (random-start) listing exclude retired skills
// (scheduling `state = 'retired'`, i.e. level = 10 — plan.md §1/§5: never selected by practice).
// This only applies to these two auto-selection paths, not to `card_ids` (CardsPanel's own
// browsing/selection, where a retired skill should still be visible and manually pickable).
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const {
    project_id, card_ids, sort, limit = '20', offset = '0',
    browse, histogram, state_counts, history_for,
    skill_type, level_min, level_max, state, kind, tags, q, sort_dir, schedule_state,
  } = req.query
  if (!project_id) return res.status(400).json({ error: 'project_id required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  // Row expansion (plan.md §6): every practice_attempt for a single skill, most recent first,
  // including its `conversation` blob — the only place this endpoint returns that (list queries
  // omit it, plan.md §8). Ownership verified in a separate step (skill -> knowledge_cards.project_id,
  // same pattern api/practice-attempt.js uses) rather than a double-nested embedded filter.
  if (history_for) {
    const { data: skillRow, error: skillErr } = await supabase
      .from('skill')
      .select('id, knowledge_cards!inner(project_id)')
      .eq('id', history_for)
      .eq('knowledge_cards.project_id', project_id)
      .maybeSingle()
    if (skillErr) return res.status(500).json({ error: skillErr.message })
    if (!skillRow) return res.status(404).json({ error: 'Skill not found' })

    const { data, error } = await supabase
      .from('practice_attempt')
      .select('id, encounter_id, outcome, model, conversation, created_at')
      .eq('skill_id', history_for)
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data ?? [])
  }

  if (histogram) {
    const { data, error } = await supabase.rpc('skill_level_histogram', {
      p_project_id: project_id,
      p_skill_type: skill_type || null,
      p_states: state ? String(state).split(',').filter(Boolean) : null,
      p_kind: kind || null,
      p_tags: tags ? String(tags).split(',').filter(Boolean) : null,
      p_search: q || null,
      p_schedule_state: schedule_state || null,
    })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ histogram: data.map(r => ({ level: r.level, count: Number(r.count) })) })
  }

  if (state_counts) {
    const { data, error } = await supabase.rpc('skill_schedule_state_counts', {
      p_project_id: project_id,
      p_skill_type: skill_type || null,
      p_level_min: level_min ? Number(level_min) : null,
      p_level_max: level_max ? Number(level_max) : null,
      p_states: state ? String(state).split(',').filter(Boolean) : null,
      p_kind: kind || null,
      p_tags: tags ? String(tags).split(',').filter(Boolean) : null,
      p_search: q || null,
    })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ counts: data.map(r => ({ state: r.schedule_state, count: Number(r.count) })) })
  }

  if (browse) {
    const states = state ? String(state).split(',').filter(Boolean) : null
    if (states && states.some(s => !PRACTICE_STATES.includes(s))) {
      return res.status(400).json({ error: `state must be one of ${PRACTICE_STATES.join(', ')}` })
    }
    const { data, error } = await supabase.rpc('browse_skills', {
      p_project_id: project_id,
      p_skill_type: skill_type || null,
      p_level_min: level_min ? Number(level_min) : null,
      p_level_max: level_max ? Number(level_max) : null,
      p_states: states,
      p_kind: kind || null,
      p_tags: tags ? String(tags).split(',').filter(Boolean) : null,
      p_search: q || null,
      p_sort: sort || 'level',
      p_sort_dir: sort_dir || 'asc',
      p_limit: Number(limit),
      p_offset: Number(offset),
      p_schedule_state: schedule_state || null,
    })
    if (error) return res.status(500).json({ error: error.message })
    const total = data[0]?.total_count ?? 0
    const skills = data.map(({ total_count, card_id, card_name, card_kind, card_tags, card_importance, card_details, card_created_at, skill_id, skill_created_at, ...row }) => ({
      ...row,
      id: skill_id,
      created_at: skill_created_at,
      card: { id: card_id, name: card_name, kind: card_kind, tags: card_tags, importance: card_importance, details: card_details, created_at: card_created_at },
    }))
    return res.status(200).json({ skills, total: Number(total) })
  }

  if (sort === 'weighted') {
    // Two round trips for the whole candidate pool — cards with their full skill sets attached,
    // plus each skill's most recent practice_attempt timestamp (for the cooldown check) — so
    // lib/practiceSelection.js can re-select as many times as it needs (a card with nothing
    // practiceable right now just gets dropped in memory) without going back to the DB.
    const [{ data, error, count }, { data: lastAttempts, error: lastAttemptsErr }] = await Promise.all([
      supabase
        .from('knowledge_cards')
        .select('id, name, kind, tags, details, importance, skill(id, type, sense_type, level, importance, last_correct, state, interval_days, due_at)', { count: 'exact' })
        .eq('project_id', project_id),
      supabase.rpc('skill_last_attempt', { p_project_id: project_id }),
    ])
    if (error) return res.status(500).json({ error: error.message })
    if (lastAttemptsErr) return res.status(500).json({ error: lastAttemptsErr.message })

    const lastAttemptById = new Map((lastAttempts ?? []).map((r) => [r.skill_id, r.last_attempt_at]))
    const cards = data.map(({ skill, ...card }) => ({
      ...card,
      skills: skill.map((row) => ({ ...resolveRow(row), last_attempt_at: lastAttemptById.get(row.id) ?? null })),
    }))
    const { picks, relearningCount, capHit } = selectScheduledPracticeSkills(cards, Number(limit))
    const skills = picks.map(({ card: { skills: _skills, ...card }, skill }) => ({ ...skill, card }))
    return res.status(200).json({
      skills,
      total: count,
      relearning_count: relearningCount,
      failure_cap: FAILURE_CAP,
      cap_hit: capHit,
    })
  }

  let query = supabase
    .from('skill')
    .select('id, type, sense_type, level, importance, last_correct, knowledge_cards!inner(id, name, kind, tags, details, project_id)', { count: 'exact' })
    .eq('knowledge_cards.project_id', project_id)

  if (card_ids) {
    const ids = String(card_ids).split(',').map(s => s.trim()).filter(Boolean)
    if (ids.length === 0) return res.status(200).json({ skills: [], total: 0 })
    query = query.in('card_id', ids)
  } else {
    // Plain (unpaginated-filter) listing — only ever used for random-start's uniform sampling
    // (PracticeStart.jsx), so retired skills are excluded here too, same as the weighted pool above.
    query = query
      .or(`level.is.null,level.neq.${RETIRED_LEVEL}`)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)
  }

  const { data, error, count } = await query
  if (error) return res.status(500).json({ error: error.message })
  const skills = data.map(({ knowledge_cards, ...s }) => ({ ...resolveRow(s), card: knowledge_cards }))
  return res.status(200).json({ skills, total: count })
}
