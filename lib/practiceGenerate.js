// Practice item generation — composes the prompt, calls Anthropic with a forced tool_choice so
// the response is schema-conformant by construction, validates the result, retries once with the
// validation error appended to the prompt. Used by api/practice.js (with real Supabase-sourced
// promptContext) and by the practice test suite (with fixture promptContext) — both call this
// exact function so tests exercise the real generation logic, not a re-implementation of it.

import { compose } from './prompts/registry.js'
import { validatePracticeItem, PracticeValidationError } from './practiceValidation.js'
import { stripMarkers } from './annotationMarkers.js'
import { languageName } from './prompts/fragments.js'
import { verifyMcClozeItem, DEFAULT_CHECK_MODEL } from './mcClozeCheck.js'

export const DEFAULT_PRACTICE_MODEL = 'claude-sonnet-4-6'

const PROMPT_IDS = { mc_cloze: 'practice.mc_cloze', spelling: 'practice.spelling', exemplar: 'practice.exemplar' }

// Composes the exact system prompt generatePracticeItem() would send for this (mode, promptContext)
// pair, without calling Anthropic — used by scripts/prompt-run.js to show the user what's actually
// being sent before generating against it. Never includes the "Previous attempt was rejected" retry
// note, since that only exists after a real validation failure.
export function composePracticePrompt(mode, promptContext) {
  const promptId = PROMPT_IDS[mode]
  if (!promptId) throw new Error(`Unknown mode: ${mode}`)
  return compose(promptId, promptContext)
}

// Every FORMAT constraint on the generated item — blank markers, option count, how `answer` must
// match, marker placement, etc. — lives here in the tool's own schema (name/description/property
// descriptions), not in the composed prompt prose (lib/prompts/registry.js). The tool definition
// is sent to the model alongside the prompt either way, so this is the single place format rules
// are stated — registry.js's task text is left to say only what makes a GOOD item (content/quality
// guidance), never what SHAPE the output must take.
const TOOLS = {
  mc_cloze: {
    name: 'emit_mc_cloze_item',
    description: 'Emit a single multiple-choice cloze exercise: one sentence with exactly one blank, and 3-4 answer options exactly one of which is correct.',
    input_schema: {
      type: 'object',
      properties: {
        sentence: { type: 'string', description: 'The sentence, containing exactly one blank marked "___" (three underscores, exactly once — nowhere else in the sentence).' },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 3,
          maxItems: 4,
          description: '3-4 distinct answer options for the blank. Exactly one must be correct; every other must be a plausible-but-wrong distractor.',
        },
        answer: { type: 'string', description: 'The correct option. Must exactly match one of the strings in `options`, copied verbatim.' },
        translation: { type: 'string', description: 'Full English translation of the complete sentence, with the blank filled in by `answer`.' },
        frame: {
          type: 'string',
          description: 'Only when the "## Target skill" instructions ask for a frame (the drill sets require_frame): the specific governing choice you made FIRST, before writing the sentence — e.g. the exact verb/adjective/construction that genuinely, idiomatically governs the target form in this use-case ("sich erinnern an", not just any verb that could loosely take "an"), or the one-line relationship between two clauses that only the target word expresses ("a single past occasion, not habitual — rules out wenn"). Omit entirely when the instructions do not ask for it.',
        },
        distractor_reasons: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              option: { type: 'string', description: 'One of the strings in `options` — every option except `answer`, one entry each, copied verbatim.' },
              reason: { type: 'string', minLength: 1, description: "One sentence stating exactly what makes this option false, odd, or ungrammatical when it fills the blank in THIS sentence. If you cannot state a genuine problem with an option, it is not a valid distractor — go back and replace it in `options` before answering; never write a reason you don't actually believe." },
            },
            required: ['option', 'reason'],
          },
          description: 'Required self-check: one entry per distractor (every option in `options` other than `answer`), each with a reason it is wrong.',
        },
        option_meanings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only when this card tests word meaning (a vocabulary card): one short English gloss per option, same order and same length as `options`. Omit entirely for grammar/expression cards.',
        },
        used_seed_words: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which entries from the "Other vocabulary already known" list (if given) you actually wove into the sentence or options, copied verbatim from that list. Omit or leave empty if none were used.',
        },
      },
      required: ['sentence', 'options', 'answer', 'translation', 'distractor_reasons'],
    },
  },
  spelling: {
    name: 'emit_spelling_item',
    description: 'Emit a single fill-in-the-blank spelling exercise: one sentence with exactly one blank, plus the English meaning of the word/form that belongs there. The learner types the exact spelling from memory — no options shown.',
    input_schema: {
      type: 'object',
      properties: {
        sentence: { type: 'string', description: 'The sentence, containing exactly one blank marked "___" (three underscores, exactly once — nowhere else in the sentence).' },
        answer: { type: 'string', description: 'The exact string that belongs in the blank, spelled exactly as the learner must type it — correct capitalization, umlauts/diacritics, and internal spacing. Graded as an exact match after trimming only leading/trailing whitespace.' },
        meaning: { type: 'string', description: "A short English gloss of the word/form that belongs in the blank — precise enough to pin down the one correct answer (sense, and grammatical role/tense/person where relevant) without revealing its spelling." },
        translation: { type: 'string', description: 'Full English translation of the complete sentence, with the blank filled in by `answer`.' },
        used_seed_words: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which entries from the "Other vocabulary already known" list (if given) you actually wove into the sentence, copied verbatim from that list. Omit or leave empty if none were used.',
        },
      },
      required: ['sentence', 'answer', 'meaning', 'translation'],
    },
  },
  exemplar: {
    name: 'emit_exemplar_item',
    description: 'Emit a single example-sentence exercise: one sentence using the target word, inflected as needed, with the inflected surface form marked.',
    input_schema: {
      type: 'object',
      properties: {
        sentence: {
          type: 'string',
          description: 'The sentence, with the inflected target word wrapped in a single ⟦⟧ marker pair (U+27E6 / U+27E7) — exactly one marker pair, around the inflected surface form of the TARGET word named in "## Target card" only, never a seed word or other noun, and not the whole clause. e.g. for target "gehen": "Er ⟦geht⟧ jeden Tag ins Büro."',
        },
        translation: { type: 'string', description: 'Full English translation of the complete sentence, with the ⟦⟧ markers stripped.' },
        used_seed_words: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which entries from the "Other vocabulary already known" list (if given) you actually wove into the sentence, copied verbatim from that list. Omit or leave empty if none were used.',
        },
      },
      required: ['sentence', 'translation'],
    },
  },
}

// The model marks the target word inline (⟦⟧) instead of computing character offsets itself —
// offset math is exactly the kind of thing LLMs get wrong, especially with German umlauts.
// Deriving target_span server-side from the marker makes it correct by construction.
function resolveExemplarMarkers(rawItem) {
  let text, positions
  try {
    ;({ text, positions } = stripMarkers(rawItem.sentence))
  } catch (e) {
    throw new PracticeValidationError(e.message)
  }
  if (positions.length !== 1) {
    throw new PracticeValidationError(`sentence must contain exactly one ⟦⟧ marker pair around the target word, found ${positions.length}`)
  }
  return { sentence: text, target_span: [positions[0].start, positions[0].end], translation: rawItem.translation, used_seed_words: rawItem.used_seed_words }
}

// Inverse of resolveExemplarMarkers — reinserts a ⟦⟧ pair at target_span so a previously-returned
// exemplar item can be replayed as an earlier assistant turn's tool_use input (see
// generatePracticeItem's `history` param below). mc_cloze/spelling items need no such reversal —
// they're returned in exactly their raw tool-input shape already, no server-side transform is
// ever applied to them — so this is a passthrough for both.
export function toRawToolInput(mode, item) {
  if (mode !== 'exemplar') return item
  const [start, end] = item.target_span
  return {
    sentence: item.sentence.slice(0, start) + '⟦' + item.sentence.slice(start, end) + '⟧' + item.sentence.slice(end),
    translation: item.translation,
    used_seed_words: item.used_seed_words,
  }
}

// Per-mode addition to the "easier vocabulary" turn text (see easierTurnText below) — deliberately
// keyed by `mode` (the tool schema / questionType), not skillType or problemType, since the thing
// that must stay fixed is a property of the SHAPE of the answer, which is fixed per mode. Kept as
// its own small map rather than folded into one shared paragraph so each mode only ever sees the
// instruction that actually applies to its own schema — mc_cloze's "same options" constraint would
// be meaningless noise injected into a spelling or exemplar conversation, and vice versa.
const EASIER_MODE_CONSTRAINT = {
  mc_cloze: ' Your new `options` array and `answer` must be EXACTLY the same as what you just produced (same strings, same one correct answer, order doesn\'t matter) — only the surrounding sentence text changes.',
  spelling: ' Your new `answer` must be EXACTLY the same as what you just produced — only the surrounding sentence text changes.',
  exemplar: '',
}

// The user-turn text sent when continuing an existing conversation to ask for an easier version —
// this is a live conversational turn now (see generatePracticeItem's `history`/buildMessages
// below), not a system-prompt section, precisely so the model can react to what it ACTUALLY wrote
// last turn (already sitting right above this message as its own prior tool_use) instead of being
// told about a "previous attempt" it has no memory of. `level` is this turn's position in the
// chain (1 on the first "Easier sentence" click, 2 on the second, ...).
function easierTurnText(mode, level) {
  const base = 'The sentence you just produced was too hard for the learner — its surrounding vocabulary, not the word/form being tested. Generate a new sentence drilling the exact same target skill: it may stay just as structurally/grammatically complex, but use simpler, more common, higher-frequency everyday vocabulary for every word other than the one being tested.'
  const constraint = EASIER_MODE_CONSTRAINT[mode] ?? ''
  const again = level > 1 ? ` This is regeneration #${level} — go noticeably simpler still than your last attempt.` : ''
  return `${base}${constraint}${again}`
}

// Thrown when generation fails validation twice in a row — the caller (route or test) decides
// how to surface it (422 response, or a hard test failure).
export class PracticeGenerationFailedError extends Error {
  constructor(detail) {
    super("Couldn't generate a valid item — skip or retry.")
    this.name = 'PracticeGenerationFailedError'
    this.detail = detail
  }
}

// promptContext: { ttsLocale, card, seedCardNames, skillType?, problemType?, extraPrompt? } — see
// lib/prompts/registry.js's practice.mc_cloze / practice.exemplar compose() for the exact shape.
// skillType/problemType/extraPrompt/requireFrame come from the resolved LanguagePack's
// drillRuleFor()/resolveDrillRule() (lib/languagePack.js; api/practice.js resolves the rule and
// picks `mode` from it before calling this function). vocabularyPolicy is the project's own policy
// text (pack meta). All optional so existing callers that pass a bare card (e.g. the test suites)
// keep working unchanged, falling back to that questionType's own base problem type + the default
// vocabulary policy (registry.js's compose()).
// `history`, if given, is the ordered list of raw tool-input items (oldest first) this exact
// conversation has already produced for this skill — api/practice.js's "Easier sentence" flow
// (PracticePanel.jsx). It's genuinely replayed as prior assistant tool_use turns (each followed by
// a synthetic tool_result + the next easierTurnText ask), NOT summarized into the system prompt —
// this is a real Anthropic conversation, resent in full on every call the same way
// api/practice-explain.js/PracticeExplain.jsx already do it (these functions are stateless
// serverless calls, so "multi-turn" only ever means "replay the whole thing every time"). The
// system prompt itself never changes turn to turn — only the conversation grows.
// `onRequest`, if given, is called with { model, system, messages } right before each Anthropic
// call (including retries) — lets the caller surface the exact text sent to the model (see
// api/practice.js, which forwards the final attempt's request back to the client for the
// browser-console "[LLM request]" log, since the client only ever sends a card_id/mode).
// `checkModel`, mc_cloze only: the model used to verify the generated item's answer is unique
// (lib/mcClozeCheck.js) — every option is filled into the blank and judged in its own conversation;
// the correct answer must come back grammatical+sensible and no distractor may come back BOTH
// grammatical and sensible at once (a distractor is fine as long as it's wrong somehow — either
// dimension failing is enough), or this counts as a validation failure and feeds the normal
// retry-once path below. `onCheck`, if given, is called with { item, verification } after each
// mc_cloze check (including a failed one that's about to trigger a retry) — api/practice.js uses
// this to log every FAILED check attempt to the mc_cloze_check_failure table.
// `onUsage`, if given, fires once per raw generation call (the initial attempt and, if it retries,
// the retry — up to twice) with { model, usage, stopReason, latencyMs, isRetry }. `onCheckUsage` is
// the mc_cloze-only sibling, forwarded into verifyMcClozeItem — fires once per judged option (see
// lib/mcClozeCheck.js). Both are optional and this function stays DB-free either way (same
// reasoning as onRequest/onCheck above) so the practice test suites keep working unchanged.
export async function generatePracticeItem({ anthropic, model = DEFAULT_PRACTICE_MODEL, checkModel = DEFAULT_CHECK_MODEL, mode, promptContext, history = [], onRequest, onCheck, onUsage, onCheckUsage }) {
  const promptId = PROMPT_IDS[mode]
  const tool = TOOLS[mode]

  function buildMessages() {
    const messages = [{ role: 'user', content: 'Generate the item now.' }]
    history.forEach((rawItem, i) => {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `toolu_easier_${i}`, name: tool.name, input: rawItem }] })
      messages.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `toolu_easier_${i}`, content: 'Generated.' },
          { type: 'text', text: easierTurnText(mode, i + 1) },
        ],
      })
    })
    return messages
  }

  // On retry (retryNote set), the previous attempt's own tool call is replayed as a real
  // assistant turn — same conversational-continuation shape buildMessages() already uses for the
  // "Easier sentence" chain (assistant tool_use, then a synthetic tool_result + a user turn asking
  // for a change) — followed by a user turn naming the SPECIFIC problem and asking the model to
  // fix only that, not regenerate from scratch. This gives the model something concrete to edit
  // instead of just a prose description of the rule it broke, which (per the system prompt alone)
  // invited it to throw away everything that was already fine along with the one broken part.
  // `previousItem` can be missing (generate() itself threw before producing an item, e.g. "Model
  // did not return a tool call") — falls back to a bare text retry ask with nothing to replay.
  async function generate(retryNote, previousItem) {
    const systemPrompt = compose(promptId, promptContext)
    const messages = buildMessages()
    if (retryNote) {
      if (previousItem) {
        const rawPrev = toRawToolInput(mode, previousItem)
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fix_0', name: tool.name, input: rawPrev }] })
        messages.push({
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_fix_0', content: 'Generated.' },
            { type: 'text', text: `That attempt has a specific problem: ${retryNote}\n\nCall the tool again to fix ONLY this problem. Keep the sentence, options, wording, translation, etc. exactly as they were, changing only the minimum necessary to fix exactly what's described above — do not regenerate the item from scratch.` },
          ],
        })
      } else {
        messages.push({ role: 'user', content: `Your previous attempt was rejected: ${retryNote}\nTry again.` })
      }
    }
    onRequest?.({ model, system: systemPrompt, messages })
    const startedAt = Date.now()
    const message = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
    })
    onUsage?.({ model, usage: message.usage, stopReason: message.stop_reason, latencyMs: Date.now() - startedAt, isRetry: !!retryNote })
    const toolUse = message.content.find(b => b.type === 'tool_use')
    if (!toolUse) throw new PracticeValidationError('Model did not return a tool call')
    return mode === 'exemplar' ? resolveExemplarMarkers(toolUse.input) : toolUse.input
  }

  const validationContext = { cardKind: promptContext.card?.kind, cardTags: promptContext.card?.tags, skillType: promptContext.skillType, requireFrame: promptContext.requireFrame }
  const lang = languageName(promptContext.ttsLocale) ?? 'the target language'

  async function attempt(retryNote, previousItem) {
    const item = await generate(retryNote, previousItem)
    try {
      validatePracticeItem(mode, item, validationContext)
    } catch (e) {
      if (e instanceof PracticeValidationError) e.item = item
      throw e
    }
    if (mode === 'mc_cloze') {
      const verification = await verifyMcClozeItem({ anthropic, model: checkModel, lang, item, onUsage: onCheckUsage })
      onCheck?.({ item, verification })
      if (!verification.passed) {
        const err = new PracticeValidationError(verification.reason)
        err.item = item
        throw err
      }
    }
    return item
  }

  try {
    return await attempt()
  } catch (e) {
    if (!(e instanceof PracticeValidationError)) throw e
    try {
      return await attempt(e.message, e.item)
    } catch (e2) {
      throw new PracticeGenerationFailedError(e2 instanceof PracticeValidationError ? e2.message : String(e2))
    }
  }
}

// Turn text asking for another item in the SAME conversation as every item already produced —
// unlike independent one-shot calls (which can't see each other and, at any temperature, tend to
// converge on the same handful of highest-probability "safe" sentences), a model extending its own
// conversation can be told directly not to repeat itself. Used by generatePracticeBatch below.
function diversifyTurnText() {
  return "Generate another one drilling the exact same target skill — but it must have a genuinely different scenario/topic, different everyday vocabulary (other than the word/form being tested), and a different grammatical structure than every sentence you've already produced in this conversation. Do not reuse a sentence shape, subject, or setting from above."
}

// Generates `batchSize` items from ONE conversation instead of `batchSize` independent one-shot
// calls — scripts/prompt-run.js's --batch flag, aimed at the mode-collapse problem: raising
// temperature doesn't help once it's already at the API default (1.0, unset here), because the
// repetition isn't a low-temperature artifact — it's that parallel calls can't see each other's
// output and each independently lands on the same likely completion. Chaining requests within one
// conversation instead, each turn explicitly told to differ from everything above (diversifyTurnText),
// lets the model actually avoid repeating itself.
//
// Deliberately simpler than generatePracticeItem: no retry-on-validation-failure per turn, since a
// retry would have to inject a "previous attempt was rejected" system-prompt note into a
// conversation that already has other turns depending on the original prompt — instead a failed
// turn just ends the batch early. Returns an array of { ok: true, item } | { ok: false, error } in
// generation order (shorter than batchSize if a turn failed).
export async function generatePracticeBatch({ anthropic, model = DEFAULT_PRACTICE_MODEL, mode, promptContext, batchSize, onRequest }) {
  const promptId = PROMPT_IDS[mode]
  const tool = TOOLS[mode]
  const systemPrompt = compose(promptId, promptContext)
  const validationContext = { cardKind: promptContext.card?.kind, cardTags: promptContext.card?.tags, skillType: promptContext.skillType }

  const messages = [{ role: 'user', content: 'Generate the item now.' }]
  const results = []

  for (let i = 0; i < batchSize; i++) {
    onRequest?.({ model, system: systemPrompt, messages: messages.map(m => ({ ...m })) })
    let message
    try {
      message = await anthropic.messages.create({
        model, max_tokens: 1024, system: systemPrompt, messages,
        tools: [tool], tool_choice: { type: 'tool', name: tool.name },
      })
    } catch (e) {
      results.push({ ok: false, error: e.message })
      break
    }
    const toolUse = message.content.find(b => b.type === 'tool_use')
    if (!toolUse) {
      results.push({ ok: false, error: 'Model did not return a tool call' })
      break
    }
    let item
    try {
      item = mode === 'exemplar' ? resolveExemplarMarkers(toolUse.input) : toolUse.input
      validatePracticeItem(mode, item, validationContext)
    } catch (e) {
      results.push({ ok: false, error: e instanceof PracticeValidationError ? e.message : String(e) })
      break
    }
    results.push({ ok: true, item })

    if (i < batchSize - 1) {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `toolu_batch_${i}`, name: tool.name, input: toolUse.input }] })
      messages.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `toolu_batch_${i}`, content: 'Generated.' },
          { type: 'text', text: diversifyTurnText() },
        ],
      })
    }
  }
  return results
}
