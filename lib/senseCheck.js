// Sense checker (plan.md — "Word Senses" §1): a dedicated, single-purpose call answering "does this
// word have senses a learner must keep apart" — kept separate from the chat.distill prompt on
// purpose, since that call already juggles kind/tags/spans/dedup and would answer this question
// badly as an afterthought. Three-state, not binary (see checkSense's tool schema) — the interesting
// cases are the ones a binary forces a guess on.
//
// Cached per (project, lemma) via the sense_check_cache table (schema.sql) — this is a property of
// the language, not of the encounter, so it's asked once and never again, same justification as
// caching any other stochastic judgment. Callers should go through getSenseVerdict(), not
// checkSense() directly, so the cache is never bypassed.

import { supabase } from './supabaseAdmin.js'

export const DEFAULT_SENSE_CHECK_MODEL = 'claude-sonnet-4-6'

const TOOL = {
  name: 'emit_sense_verdict',
  description: 'Report whether this word has learner-relevant distinct senses.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['single', 'distinct', 'stretched'],
        description: '"single": one sense. "distinct": senses a learner must actively keep separate (knowing one would mislead you about the other). "stretched": related/extended uses of one core sense — NOT distinct, just flag it.',
      },
      reasoning: {
        type: 'string',
        minLength: 1,
        description: 'One or two sentences justifying the verdict. Always required, even for "single".',
      },
    },
    required: ['verdict', 'reasoning'],
  },
}

const SYSTEM_PROMPT = `You judge whether a word, as used in a specific excerpt, belongs to a family of senses a language learner must actively keep apart — not whether it is polysemous in a dictionary sense. Nearly every word is polysemous to a lexicographer; that is not the question.

The operative question: would knowing one sense actively mislead you about the other, or does one reach the other by ordinary, unremarkable extension?

Examples (German, but the calibration is language-general):
- "Bank" (bench / financial institution) — distinct; even the plurals differ (Bänke / Banken)
- "Schloss" (castle / lock) — distinct
- "Gericht" (court of law / dish of food) — distinct
- "Rand" (edge of a table / edge of a village / page margin) — one sense stretched, NOT distinct
- "laufen" (run / walk / function / be valid) — genuinely borderline, lean toward the verdict that best serves a learner
- "Zug" (train / draft of air / move in a game) — genuinely borderline; some of these are extension, some are not

Calibration: this should fire "distinct" on roughly 10% of ordinary vocabulary, not much more. When in doubt between "distinct" and "stretched", prefer "stretched" — forking a card's meaning skill is a real cost, so the bar for "distinct" is "this would actively mislead a learner", not "a dictionary lists two senses".

Always call emit_sense_verdict exactly once. Always give a real, specific reasoning — never a placeholder.`

// Calls the model fresh — no cache lookup. Use getSenseVerdict() instead unless you specifically
// need to bypass the cache (e.g. re-checking a lemma the cache already has a stale verdict for).
export async function checkSense({ anthropic, model = DEFAULT_SENSE_CHECK_MODEL, lemma, excerpt, languageName }) {
  const lang = languageName ?? 'the target language'
  const message = await anthropic.messages.create({
    model,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Language: ${lang}\nWord: ${lemma}\nExcerpt where it was encountered: ${excerpt}`,
    }],
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
  })
  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse) throw new Error('Sense checker did not return a tool call')
  const { verdict, reasoning } = toolUse.input
  return { verdict, reasoning: reasoning?.trim() || '(checker gave no explanation)' }
}

export function normalizeLemma(lemma) {
  return lemma.trim().toLowerCase()
}

// Cache-aware entry point. Returns { verdict, reasoning, cached }. `reasoning` is null for a cache
// hit (not stored on repeat lookups' return value beyond what was cached at write time — the row's
// own `reasoning` column is returned as-is).
export async function getSenseVerdict({ anthropic, model, projectId, lemma, excerpt, languageName }) {
  const lemmaNorm = normalizeLemma(lemma)

  const { data: cached } = await supabase
    .from('sense_check_cache')
    .select('verdict, reasoning')
    .eq('project_id', projectId)
    .eq('lemma_norm', lemmaNorm)
    .maybeSingle()
  if (cached) return { ...cached, cached: true }

  const result = await checkSense({ anthropic, model, lemma, excerpt, languageName })

  // Best-effort: a losing race on the unique (project_id, lemma_norm) constraint just means another
  // request cached it first — not worth failing the caller over.
  await supabase
    .from('sense_check_cache')
    .upsert({ project_id: projectId, lemma_norm: lemmaNorm, verdict: result.verdict, reasoning: result.reasoning }, { onConflict: 'project_id,lemma_norm' })

  return { ...result, cached: false }
}

// ── Sense suggestion (CardDetailPanel's "+ Add sense") ─────────────────────────────────────────
// Distinct from the checker above: this doesn't ask "does this word have distinct senses" — it asks
// "given this word and how it's actually been used, propose a key+gloss for its current meaning".
// Used to pre-fill AddSenseForm.jsx's "name this card's sense" fields so a user isn't asked to
// invent a slug and a precise gloss from scratch — the agent has real material to work from (the
// card's own name/tags and the source sentences it's already linked to in the DB), so it should
// draft this, not leave it blank. Never asked to invent a SECOND sense — the agent has no signal at
// all for a sense the user hasn't described yet, so that stays user-authored.
const SUGGEST_TOOL = {
  name: 'emit_sense_suggestion',
  description: "Propose a short slug key and a concise gloss for this word's current (single, on-file) meaning.",
  input_schema: {
    type: 'object',
    properties: {
      key: { type: 'string', minLength: 1, description: 'A short lowercase slug identifying this sense, e.g. "seating", "financial" — no spaces, no punctuation.' },
      gloss: { type: 'string', minLength: 1, description: 'A short English gloss precise enough that it could later be told apart from a hypothetical second sense of the same word, e.g. "a bench, a seat".' },
    },
    required: ['key', 'gloss'],
  },
}

// card: { name, kind, tags }. excerpts: source sentences already linked to this card in the DB
// (api/suggest-sense.js pulls these via source_knowledge -> sources), the only real evidence of how
// the word has actually been used — may be empty for a card with no linked sources yet, in which
// case the suggestion falls back to the bare name/tags.
export async function suggestSense({ anthropic, model = DEFAULT_SENSE_CHECK_MODEL, card, excerpts = [], languageName }) {
  const lang = languageName ?? 'the target language'
  const context = [
    `Language: ${lang}`,
    `Word: ${card.name}`,
    card.tags?.length ? `Tags: ${card.tags.join(', ')}` : null,
    excerpts.length
      ? `Sentence(s) this word has actually been encountered in:\n${excerpts.map(e => `- ${e}`).join('\n')}`
      : '(No linked source sentences yet — go by the word and its tags alone.)',
  ].filter(Boolean).join('\n')

  const message = await anthropic.messages.create({
    model,
    max_tokens: 256,
    system: "Propose a short slug key and a concise English gloss for this word's current, single meaning, grounded in the example sentence(s) given — precise enough that it could later be told apart from a hypothetical second sense. Always call emit_sense_suggestion exactly once.",
    messages: [{ role: 'user', content: context }],
    tools: [SUGGEST_TOOL],
    tool_choice: { type: 'tool', name: SUGGEST_TOOL.name },
  })
  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse) throw new Error('Sense suggestion did not return a tool call')
  return { key: toolUse.input.key, gloss: toolUse.input.gloss }
}
