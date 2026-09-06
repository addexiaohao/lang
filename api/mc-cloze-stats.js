import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'

// GET ?project_id=&limit= -> { total_attempted, succeeded_one_pass, failed_once_recovered,
// failed_twice_unserved, limit } — a raw breakdown of the mc_cloze answer-uniqueness check
// (CLAUDE.md's "Practice generation") over the last `limit` mc_cloze practice_attempt rows,
// counting every generation ATTEMPTED (served or not) as the denominator, not just served ones.
//
// generatePracticeItem() (lib/practiceGenerate.js) checks an mc_cloze item, and on a failed check
// retries exactly once — so any one generation logs 0, 1, or 2 rows to mc_cloze_check_failure:
//   0 rows -> passed clean, served                    -> "succeeded in one pass"
//   1 row  -> initial check failed, retry passed, served -> "failed once (recovered)"
//   2 rows -> both checks failed, PracticeGenerationFailedError thrown, NEVER served (no
//             practice_attempt row at all for it)         -> "failed twice (unserved)"
// That's deterministic given the retry-once cap, so there's no need to match a specific failure
// row to a specific practice_attempt row (no cross-table join/attribution): just two independent
// counts — how many mc_cloze items were actually served (practice_attempt), and how failure rows
// in the same time window cluster into 1- vs 2-row generation events (mc_cloze_check_failure
// alone) — then succeeded_one_pass = served_total - failed_once_recovered, and
// total_attempted = served_total + failed_twice_unserved (the unserved ones have no
// practice_attempt row, so they'd otherwise be invisible to a denominator built from that table
// alone).
//
// Clustering a project's failure rows into "one generation's checks" uses only proximity: rows
// for the same skill within CORRELATION_GAP_MS of each other are the initial+retry pair of one
// generation. Safe because a skill is never served twice within COOLDOWN_MINUTES (15 min,
// lib/practiceScheduling.js) of itself, so anything closer together than that can only be one
// generation's own checks, never two separate practice rounds colliding.
const CORRELATION_GAP_MS = 10 * 60 * 1000
const WINDOW_BUFFER_MS = 10 * 60 * 1000
const CANDIDATE_CAP = 2000

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, limit = '50' } = req.query
  if (!project_id) return res.status(400).json({ error: 'project_id required' })

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500)
  const candidateCap = Math.min(Math.max(lim * 4, 200), CANDIDATE_CAP)

  const { data: attemptRows, error: attemptErr } = await supabase
    .from('practice_attempt')
    .select('created_at, conversation, skill!inner(knowledge_cards!inner(project_id))')
    .eq('skill.knowledge_cards.project_id', project_id)
    .order('created_at', { ascending: false })
    .limit(candidateCap)
  if (attemptErr) return res.status(500).json({ error: attemptErr.message })

  // mc_cloze items are the only ones with an `options` array (spelling has `meaning`+`answer`,
  // exemplar has `target_span`) — see lib/practiceGenerate.js's per-mode item shapes.
  const recent = (attemptRows ?? [])
    .filter(a => Array.isArray(a.conversation?.response?.options))
    .slice(0, lim)

  const servedTotal = recent.length
  if (servedTotal === 0) {
    return res.status(200).json({ served_total: 0, succeeded_one_pass: 0, failed_once_recovered: 0, failed_twice_unserved: 0, limit: lim })
  }

  const oldestServedAt = recent[recent.length - 1].created_at
  const windowStart = new Date(new Date(oldestServedAt).getTime() - WINDOW_BUFFER_MS).toISOString()

  const { data: failureRows, error: failureErr } = await supabase
    .from('mc_cloze_check_failure')
    .select('skill_id, card_id, created_at, knowledge_cards!inner(project_id)')
    .eq('knowledge_cards.project_id', project_id)
    .gte('created_at', windowStart)
    .order('created_at', { ascending: true })
  if (failureErr) return res.status(500).json({ error: failureErr.message })

  // Group by skill (falling back to card_id for the rare row with no skill_id — see the
  // mc_cloze_check_failure schema comment on why that column is nullable), then split each
  // group's rows into events wherever consecutive rows are more than CORRELATION_GAP_MS apart.
  const byKey = new Map()
  for (const f of failureRows ?? []) {
    const key = f.skill_id ?? `card:${f.card_id}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(new Date(f.created_at).getTime())
  }

  let failedOnceRecovered = 0
  let failedTwiceUnserved = 0
  for (const times of byKey.values()) {
    times.sort((a, b) => a - b)
    let eventSize = 1
    for (let i = 1; i <= times.length; i++) {
      const gapEndsEvent = i === times.length || times[i] - times[i - 1] > CORRELATION_GAP_MS
      if (gapEndsEvent) {
        if (eventSize === 1) failedOnceRecovered++
        else failedTwiceUnserved++
        eventSize = 1
      } else {
        eventSize++
      }
    }
  }

  const succeededOnePass = Math.max(servedTotal - failedOnceRecovered, 0)
  // Every generation attempted, served or not: the served ones (0- and 1-failure events) plus the
  // 2-failure events that never produced an item at all.
  const totalAttempted = servedTotal + failedTwiceUnserved

  return res.status(200).json({
    total_attempted: totalAttempted,
    succeeded_one_pass: succeededOnePass,
    failed_once_recovered: failedOnceRecovered,
    failed_twice_unserved: failedTwiceUnserved,
    limit: lim,
  })
}
