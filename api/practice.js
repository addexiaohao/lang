import Anthropic from '@anthropic-ai/sdk'
import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { generatePracticeItem, PracticeGenerationFailedError, DEFAULT_PRACTICE_MODEL, toRawToolInput } from '../lib/practiceGenerate.js'
import { getPracticeRule, resolvePracticeRule, practiceableSkillTypes, MAX_EASIER_SENTENCE_ATTEMPTS } from '../lib/practiceRules.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = process.env.PRACTICE_MODEL || DEFAULT_PRACTICE_MODEL

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Picks a random different skill (card + type + level) that DOES have a problem type configured
// (lib/practiceRules.js's SKILL_PROBLEM_TYPES) — used when the originally requested skill_type has
// none. Keeps a practice session from hard-erroring on an unconfigured skill type; the caller
// substitutes this skill in and generates for it instead, silently.
async function pickSubstituteSkill(projectId) {
  const types = practiceableSkillTypes()
  if (types.length === 0) return null
  // Retired (level = 10, plan.md §5) skills are never auto-selected, substitution included.
  const { data } = await supabase
    .from('skill')
    .select('card_id, type, level, knowledge_cards!inner(id, name, kind, tags, details, project_id)')
    .eq('knowledge_cards.project_id', projectId)
    .in('type', types)
    .or('level.is.null,level.neq.10')
    .limit(200)
  if (!data || data.length === 0) return null
  const row = data[Math.floor(Math.random() * data.length)]
  return { card: row.knowledge_cards, skillType: row.type, level: row.level ?? 1 }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let user
  try {
    user = await requireUser(req)
  } catch (e) {
    if (e instanceof AuthError) return res.status(401).json({ error: e.message })
    throw e
  }

  const { project_id, card_id, skill_type, history, problem_type } = req.body ?? {}
  if (!project_id) return res.status(400).json({ error: 'project_id required' })
  if (!card_id) return res.status(400).json({ error: 'card_id required' })
  if (typeof skill_type !== 'string' || !skill_type.trim()) {
    return res.status(400).json({ error: 'skill_type required' })
  }
  // `history`: the ordered list of items (server's own previous response shape) this same
  // "Easier sentence" chain has already produced for this skill — see
  // lib/practiceGenerate.js's `history` param for how it's replayed as real conversation turns.
  // Client caps chain length at MAX_EASIER_SENTENCE_ATTEMPTS too (PracticePanel.jsx hides the
  // button past it) — clamped again here since the client's cap isn't a trust boundary.
  const rawHistory = Array.isArray(history) ? history.slice(0, MAX_EASIER_SENTENCE_ATTEMPTS) : []

  try {
    await requireProjectAccess(user.id, project_id)
  } catch (e) {
    if (e instanceof AuthError) return res.status(403).json({ error: e.message })
    throw e
  }

  const [{ data: project }, { data: card, error: cardError }, { data: skillRow }] = await Promise.all([
    supabase.from('projects').select('tts_locale').eq('id', project_id).single(),
    supabase.from('knowledge_cards').select('id, name, kind, tags, details').eq('project_id', project_id).eq('id', card_id).single(),
    supabase.from('skill').select('level').eq('card_id', card_id).eq('type', skill_type).maybeSingle(),
  ])
  if (cardError || !card) return res.status(404).json({ error: 'Card not found' })

  let effectiveCard = card
  let effectiveSkillType = skill_type
  let effectiveLevel = skillRow?.level ?? 1

  // Continuing an existing "Easier sentence" chain: reuse the EXACT problemType that chain
  // already committed to (from its first turn's response, round-tripped back by the client as
  // `problem_type`) via resolvePracticeRule's deterministic lookup, rather than re-rolling
  // getPracticeRule's weighted random pick — which could legitimately return a different
  // problemType (and therefore a different tool schema/mode) than the conversation already has
  // turns for. Only trusted when it resolves; otherwise falls through to a fresh pick below and
  // the stale history is discarded (see effectiveHistory).
  let rule = rawHistory.length > 0 && typeof problem_type === 'string'
    ? resolvePracticeRule(effectiveSkillType, problem_type, { cardName: effectiveCard.name })
    : null
  const continuingHistory = rule != null

  if (!rule) {
    rule = getPracticeRule(effectiveSkillType, effectiveLevel, { cardName: effectiveCard.name })
  }
  if (!rule) {
    // The requested skill_type has no problem type configured for its current level
    // (lib/practiceRules.js) — silently swap in a different, practiceable skill rather than
    // erroring the session out.
    const substitute = await pickSubstituteSkill(project_id)
    if (!substitute) return res.status(422).json({ error: 'No practiceable skill types configured for this project' })
    effectiveCard = substitute.card
    effectiveSkillType = substitute.skillType
    effectiveLevel = substitute.level
    rule = getPracticeRule(effectiveSkillType, effectiveLevel, { cardName: effectiveCard.name })
    if (!rule) return res.status(422).json({ error: 'No practiceable skill types configured for this project' })
  }

  const { questionType: mode, problemType, extraPrompt } = rule
  // Only replay history when we're actually continuing the same (skillType, problemType) it was
  // generated under — a substitution or a fresh random pick above means this is a different
  // conversation and the old turns don't belong in it.
  const effectiveHistory = continuingHistory ? rawHistory.map(item => toRawToolInput(mode, item)) : []

  // Sampled fresh (and shuffled) on every request, not just the fixed top-15-by-importance list —
  // otherwise every generated sentence in a session leans on the same handful of words. Vocabulary
  // only — grammar/expression cards aren't standalone words to "weave into" a sentence.
  const { data: seedPool } = await supabase.from('knowledge_cards').select('name').eq('project_id', project_id).eq('kind', 'vocabulary').neq('id', effectiveCard.id).limit(300)
  const seedCardNames = shuffle(seedPool ?? []).slice(0, 15).map(c => c.name)

  const promptContext = { ttsLocale: project?.tts_locale, card: effectiveCard, skillType: effectiveSkillType, problemType, extraPrompt, seedCardNames }

  let request = null
  try {
    const item = await generatePracticeItem({
      anthropic, model: MODEL, mode, promptContext, history: effectiveHistory,
      onRequest: r => { request = r },
    })
    // card/skill_type reflect what was ACTUALLY generated for — may differ from the request's
    // card_id/skill_type when a silent substitution happened above. The client uses these, not
    // its own request values, for anything downstream of this item (result recording, Explain,
    // View card) — see PracticePanel.jsx's requestItem(). seed_card_names is the pool offered to
    // the model as "other vocabulary already known" (lib/prompts/registry.js's seedSection) — the
    // client pairs it with item.used_seed_words to show what was offered vs. what was actually used.
    // problem_type is round-tripped back so a subsequent "Easier sentence" click can pin the same
    // problemType via resolvePracticeRule above, instead of re-rolling it.
    return res.status(200).json({ item, mode, request, card: effectiveCard, skill_type: effectiveSkillType, seed_card_names: seedCardNames, problem_type: problemType })
  } catch (e) {
    if (e instanceof PracticeGenerationFailedError) {
      return res.status(422).json({ error: e.message, detail: e.detail })
    }
    throw e
  }
}
