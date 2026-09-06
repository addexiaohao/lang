import Anthropic from '@anthropic-ai/sdk'
import { requireUser, requireProjectAccess, AuthError } from '../lib/auth.js'
import { supabase } from '../lib/supabaseAdmin.js'
import { generatePracticeItem, PracticeGenerationFailedError, DEFAULT_PRACTICE_MODEL, toRawToolInput } from '../lib/practiceGenerate.js'
import { buildDiscriminationRule, MAX_EASIER_SENTENCE_ATTEMPTS } from '../lib/practiceRules.js'
import { resolveLanguagePack } from '../lib/resolveLanguagePack.js'
import { EXCLUDE_RECENT_DAYS, RETIRED_LEVEL } from '../lib/practiceSelection.js'
import { hasSenseAxis, senseValues, axisValueKey, axisValueGloss, skillDbColumns, resolveSkillType } from '../lib/skillTypes.js'
import { DEFAULT_CHECK_MODEL } from '../lib/mcClozeCheck.js'
import { logMcClozeCheck } from '../lib/mcClozeCheckLog.js'
import { logLlmApiCall } from '../lib/llmUsageLog.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = process.env.PRACTICE_MODEL || DEFAULT_PRACTICE_MODEL
const CHECK_MODEL = process.env.PRACTICE_CHECK_MODEL || DEFAULT_CHECK_MODEL

// Returns the gloss for `skillType` if `card` has a sense axis and `skillType` is one of its
// values' keys, else null (an ordinary card, or a skill type that isn't a sense of this card).
function senseGlossFor(card, skillType) {
  if (!hasSenseAxis(card)) return null
  const v = senseValues(card).find(sv => axisValueKey(sv) === skillType)
  return v ? axisValueGloss(v) : null
}

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
async function pickSubstituteSkill(projectId, pack) {
  const types = pack.practiceableSkillTypes()
  if (types.length === 0) return null
  // Retired (level = 10, plan.md §5) and recently-correct skills are never auto-selected,
  // substitution included — same rule lib/practiceSelection.js's quick-start weighted sample
  // uses, so a substitution can't reintroduce a skill quick-start deliberately excluded. Filtered
  // in SQL (not in memory after the fact) so the `.limit(200)` cap still samples from the full
  // eligible pool rather than being applied before eligibility is known.
  const cutoff = new Date(Date.now() - EXCLUDE_RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data } = await supabase
    .from('skill')
    .select('id, card_id, type, sense_type, level, knowledge_cards!inner(id, name, kind, tags, details, project_id)')
    .eq('knowledge_cards.project_id', projectId)
    .in('type', types)
    .or(`level.is.null,level.neq.${RETIRED_LEVEL}`)
    .or(`last_correct.is.null,last_correct.lt.${cutoff}`)
    .limit(200)
  if (!data || data.length === 0) return null
  const row = data[Math.floor(Math.random() * data.length)]
  // resolveSkillType, not row.type directly — a sense skill's DB type is always literally 'meaning'
  // (see lib/skillTypes.js), and `.in('type', types)` above matches those rows too since 'meaning'
  // is itself a practiceable type; the external identity is its sense_type.
  return { card: row.knowledge_cards, skillType: resolveSkillType(row), level: row.level ?? 1, skillId: row.id }
}

// Card Groups (plan.md) — picks one of this card's groups at random, among those with at least one
// OTHER member, for a discrimination cloze (see lib/practiceRules.js's buildDiscriminationRule).
// Two round trips rather than one nested query: membership rows for this card, then every member
// row across those groups in one batched IN query — fine at this app's personal scale (same
// N-queries-are-fine spirit as lib/mcClozeCheck.js's per-option checks).
async function pickDiscriminationGroup(cardId) {
  const { data: memberships } = await supabase
    .from('card_group_member')
    .select('group_id, card_group(note)')
    .eq('card_id', cardId)
  if (!memberships || memberships.length === 0) return null
  const groupIds = memberships.map(m => m.group_id)
  const { data: allMembers } = await supabase
    .from('card_group_member')
    .select('group_id, card_id, note, knowledge_cards(name)')
    .in('group_id', groupIds)
  const byGroup = new Map()
  for (const row of allMembers ?? []) {
    if (!byGroup.has(row.group_id)) byGroup.set(row.group_id, [])
    byGroup.get(row.group_id).push(row)
  }
  const candidates = memberships
    .map(m => ({
      groupNote: m.card_group?.note ?? null,
      others: (byGroup.get(m.group_id) ?? [])
        .filter(r => r.card_id !== cardId && r.knowledge_cards)
        .map(r => ({ name: r.knowledge_cards.name, note: r.note })),
    }))
    .filter(c => c.others.length > 0)
  if (candidates.length === 0) return null
  return candidates[Math.floor(Math.random() * candidates.length)]
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

  const [{ data: project }, { data: card, error: cardError }, pack] = await Promise.all([
    supabase.from('projects').select('tts_locale').eq('id', project_id).single(),
    supabase.from('knowledge_cards').select('id, name, kind, tags, details').eq('project_id', project_id).eq('id', card_id).single(),
    resolveLanguagePack(project_id),
  ])
  if (cardError || !card) return res.status(404).json({ error: 'Card not found' })

  // The requested skill_type's actual DB row (id, level) — its row is keyed by (type, sense_type),
  // not skill_type directly, once `card` tells us whether skill_type is a sense of this card (see
  // lib/skillTypes.js's skillDbColumns).
  const { type: requestedDbType, sense_type: requestedDbSenseType } = skillDbColumns(card, skill_type)
  const { data: skillRow } = await supabase
    .from('skill')
    .select('id, level')
    .eq('card_id', card_id)
    .eq('type', requestedDbType)
    .eq('sense_type', requestedDbSenseType)
    .maybeSingle()

  let effectiveCard = card
  let effectiveSkillType = skill_type
  let effectiveLevel = skillRow?.level ?? 1
  let effectiveSkillId = skillRow?.id ?? null

  // A sense skill's type (e.g. "financial") isn't a literal skill_type_def key — it's drilled
  // exactly like an ordinary vocabulary `meaning` skill, just with its own gloss threaded into
  // extraPrompt below so generation targets the right sense, not just any sense (plan.md — "Word
  // Senses" §4 calls this "the single most likely thing to be missed"). ruleLookupType is only used
  // to pick/resolve the drill rule; effectiveSkillType stays the real dotted-path type everywhere
  // else (DB writes, the response, Explain, etc).
  const senseGloss = senseGlossFor(effectiveCard, effectiveSkillType)
  const ruleLookupType = senseGloss != null ? 'meaning' : effectiveSkillType

  // Continuing an existing "Easier sentence" chain: reuse the EXACT problemType that chain
  // already committed to (from its first turn's response, round-tripped back by the client as
  // `problem_type`) via resolvePracticeRule's deterministic lookup, rather than re-rolling
  // getPracticeRule's weighted random pick — which could legitimately return a different
  // problemType (and therefore a different tool schema/mode) than the conversation already has
  // turns for. Only trusted when it resolves; otherwise falls through to a fresh pick below and
  // the stale history is discarded (see effectiveHistory).
  //
  // discrimination_cloze (Card Groups, plan.md) is a special case: it has no drill_rule row for
  // resolveDrillRule to find (its extraPrompt is built from the card's live group membership, not
  // fixed prompt text), so continuing one means re-fetching that membership and rebuilding the rule
  // rather than a table lookup. Falls through to a fresh pick (like any other unresolvable
  // problem_type) if the card is no longer grouped.
  let rule = null
  if (rawHistory.length > 0 && problem_type === 'discrimination_cloze') {
    const discriminationGroup = await pickDiscriminationGroup(effectiveCard.id)
    if (discriminationGroup) {
      rule = buildDiscriminationRule({ cardName: effectiveCard.name, groupNote: discriminationGroup.groupNote, otherMembers: discriminationGroup.others })
    }
  } else if (rawHistory.length > 0 && typeof problem_type === 'string') {
    rule = pack.resolveDrillRule(effectiveCard, ruleLookupType, problem_type)
  }
  const continuingHistory = rule != null

  if (!rule) {
    rule = pack.drillRuleFor(effectiveCard, ruleLookupType, effectiveLevel)
  }
  let substituted = false
  if (!rule) {
    // The requested skill_type has no enabled drill rule for its current level (the project's
    // language pack) — silently swap in a different, practiceable skill rather than erroring the
    // session out.
    const substitute = await pickSubstituteSkill(project_id, pack)
    if (!substitute) return res.status(422).json({ error: 'No practiceable skill types configured for this project' })
    effectiveCard = substitute.card
    effectiveSkillType = substitute.skillType
    effectiveLevel = substitute.level
    effectiveSkillId = substitute.skillId
    substituted = true
    rule = pack.drillRuleFor(effectiveCard, effectiveSkillType, effectiveLevel)
    if (!rule) return res.status(422).json({ error: 'No practiceable skill types configured for this project' })
  }

  // senseGloss was derived from the ORIGINALLY requested skill — never valid after a substitution
  // swapped in a different skill entirely.
  if (senseGloss != null && !substituted) {
    const senseNote = `This word has multiple senses; drill specifically the sense glossed as "${senseGloss}" — do not test any other sense of this word.`
    rule = { ...rule, extraPrompt: rule.extraPrompt ? `${rule.extraPrompt}\n\n${senseNote}` : senseNote }
  }

  // Card Groups (plan.md) — "prefer a discrimination item over a plain one" for a grouped card's
  // plain `meaning` skill. "Prefer" here means "always, when eligible": discrimination's entire
  // value is a guaranteed-plausible distractor (the group's real other members, not something
  // invented), so once a group is available there's no reason to fall back to the ordinary
  // meaning rule's weighted pool. Skipped when continuing an "Easier sentence" chain (must keep
  // whatever problemType it already committed to), after a substitution (a different card/skill
  // entirely — its own group eligibility, if any, is a fresh check this request never makes), or
  // for a sense skill (group membership is card-level; cross-sense confusion isn't handled here).
  if (!continuingHistory && !substituted && senseGloss == null && effectiveSkillType === 'meaning') {
    const discriminationGroup = await pickDiscriminationGroup(effectiveCard.id)
    if (discriminationGroup) {
      const discriminationRule = buildDiscriminationRule({
        cardName: effectiveCard.name,
        groupNote: discriminationGroup.groupNote,
        otherMembers: discriminationGroup.others,
      })
      if (discriminationRule) rule = discriminationRule
    }
  }

  const { questionType: mode, problemType, extraPrompt, requireFrame } = rule
  // Only replay history when we're actually continuing the same (skillType, problemType) it was
  // generated under — a substitution or a fresh random pick above means this is a different
  // conversation and the old turns don't belong in it.
  const effectiveHistory = continuingHistory ? rawHistory.map(item => toRawToolInput(mode, item)) : []

  // Sampled fresh (and shuffled) on every request, not just the fixed top-15-by-importance list —
  // otherwise every generated sentence in a session leans on the same handful of words. Vocabulary
  // only — grammar/expression cards aren't standalone words to "weave into" a sentence. A polysemous
  // card's name alone doesn't say which sense is known, so it's only offered once at least one of
  // its senses is well-known (plan.md — "Word Senses" §4: knowing "Bank" as a bench doesn't make the
  // financial sense readable) — ordinary (non-sense) cards keep the prior unrestricted behavior.
  const { data: seedPool } = await supabase
    .from('knowledge_cards')
    .select('id, name, details, skill(type, level)')
    .eq('project_id', project_id).eq('kind', 'vocabulary').neq('id', effectiveCard.id).limit(300)
  const eligibleSeeds = (seedPool ?? []).filter(c => !hasSenseAxis(c) || (c.skill ?? []).some(s => (s.level ?? 0) >= 5))
  const seedCards = shuffle(eligibleSeeds).slice(0, 15).map(c => ({ id: c.id, name: c.name }))
  const seedCardNames = seedCards.map(c => c.name)

  const promptContext = { ttsLocale: project?.tts_locale, card: effectiveCard, skillType: effectiveSkillType, problemType, extraPrompt, requireFrame, seedCardNames, vocabularyPolicy: pack.vocabularyPolicyText() }

  let request = null
  // The full raw Anthropic response (all content blocks — for mc_cloze this includes the model's
  // `thinking` block, its sentence-drafting reasoning ahead of the tool call, see
  // lib/practiceRules.js) for whichever attempt's item was actually returned. Round-tripped back to
  // the client purely for conversation-history logging (practice_attempt.conversation) — the UI
  // itself only ever renders `item`, never this.
  let response = null
  // Every mc_cloze answer-uniqueness check (lib/mcClozeCheck.js) generatePracticeItem runs — the
  // initial attempt and, if it failed, the retry — gets logged here, pass or fail, via
  // onCheck. Awaited alongside the outcome below so a failed generation still gets its check
  // attempt(s) recorded, not just a successful one.
  const checkLogs = []
  // Every raw Anthropic call generatePracticeItem makes — the item-generation call(s) via onUsage,
  // and (mc_cloze only) each per-option answer-uniqueness check via onCheckUsage — logged to
  // llm_api_call regardless of whether generation ultimately succeeds, same reasoning as checkLogs.
  const usageLogs = []
  try {
    const item = await generatePracticeItem({
      anthropic, model: MODEL, checkModel: CHECK_MODEL, mode, promptContext, history: effectiveHistory,
      onRequest: r => { request = r },
      // Fires on every attempt, thinking blocks included — logged server-side (not sent to the
      // browser, and never shown in the practice UI) purely so the model's reasoning for mc_cloze
      // is actually visible somewhere during development, since it's otherwise only ever persisted
      // inside practice_attempt.conversation once an item is answered.
      onResponse: r => {
        response = r
        const thinkingBlock = r.find(b => b.type === 'thinking')
        if (thinkingBlock?.thinking) console.log(`[practice] mc_cloze thinking (${effectiveCard.name}/${effectiveSkillType}):`, thinkingBlock.thinking)
      },
      onCheck: ({ item: checkedItem, verification }) => {
        checkLogs.push(logMcClozeCheck({
          skillId: effectiveSkillId, cardId: effectiveCard.id, skillType: effectiveSkillType,
          model: CHECK_MODEL, item: checkedItem, verification,
          // `request`/`response` are set by onRequest/onResponse around each generation call (and
          // again on a retry), so they hold the exact prompt + raw model output that produced
          // `checkedItem`. verification.checks carries every per-option checker conversation — the
          // whole trail behind this failure lands in the row's `conversation` jsonb.
          generationRequest: request,
          generationResponse: response,
        }))
      },
      onUsage: ({ model: usedModel, usage, stopReason, latencyMs, isRetry }) => {
        usageLogs.push(logLlmApiCall({
          projectId: project_id, userId: user.id,
          purpose: isRetry ? 'practice_retry' : 'practice_generate',
          model: usedModel, usage, stopReason, latencyMs,
          cardId: effectiveCard.id, skillId: effectiveSkillId,
          metadata: { skill_type: effectiveSkillType, problem_type: problemType, substituted },
        }))
      },
      onCheckUsage: ({ model: usedModel, usage, stopReason, latencyMs }) => {
        usageLogs.push(logLlmApiCall({
          projectId: project_id, userId: user.id, purpose: 'mc_cloze_check',
          model: usedModel, usage, stopReason, latencyMs,
          cardId: effectiveCard.id, skillId: effectiveSkillId,
          metadata: { skill_type: effectiveSkillType },
        }))
      },
    })
    await Promise.all([...checkLogs, ...usageLogs])
    // card/skill_type reflect what was ACTUALLY generated for — may differ from the request's
    // card_id/skill_type when a silent substitution happened above. The client uses these, not
    // its own request values, for anything downstream of this item (result recording, Explain,
    // View card) — see PracticePanel.jsx's requestItem(). seed_card_names is the pool offered to
    // the model as "other vocabulary already known" (lib/prompts/registry.js's seedSection) — the
    // client pairs it with item.used_seed_words to show what was offered vs. what was actually used.
    // seed_cards carries each offered word's card id (name-only seed_card_names above is what the
    // prompt itself sees) so the client can render "Suggested vocabulary" as links to those cards.
    // problem_type is round-tripped back so a subsequent "Easier sentence" click can pin the same
    // problemType via resolvePracticeRule above, instead of re-rolling it. reveal_translation tells
    // the client (PracticeMcCloze.jsx) to show `item.translation` before the learner answers rather
    // than only after — reusing `requireFrame` rather than a dedicated column, since a drill that
    // forces the model to commit to a governing frame first (lib/languagePacks/germanSeed.js's
    // production-which-preposition/conjunction rules) is, by construction, exactly a drill where
    // several options can be independently natural and only differ in which meaning they produce.
    return res.status(200).json({ item, mode, request, response, card: effectiveCard, skill_type: effectiveSkillType, seed_card_names: seedCardNames, seed_cards: seedCards, problem_type: problemType, reveal_translation: !!requireFrame })
  } catch (e) {
    await Promise.all([...checkLogs, ...usageLogs])
    if (e instanceof PracticeGenerationFailedError) {
      return res.status(422).json({ error: e.message, detail: e.detail })
    }
    throw e
  }
}
