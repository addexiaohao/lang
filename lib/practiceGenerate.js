// Practice item generation — composes the prompt, calls Anthropic with a forced tool_choice so
// the response is schema-conformant by construction, validates the result, retries once with the
// validation error appended to the prompt. Used by api/practice.js (with real Supabase-sourced
// promptContext) and by the practice test suite (with fixture promptContext) — both call this
// exact function so tests exercise the real generation logic, not a re-implementation of it.

import { compose } from './prompts/registry.js'
import { validatePracticeItem, PracticeValidationError } from './practiceValidation.js'
import { stripMarkers } from './annotationMarkers.js'

export const DEFAULT_PRACTICE_MODEL = 'claude-sonnet-4-6'

const PROMPT_IDS = { mc_cloze: 'practice.mc_cloze', spelling: 'practice.spelling', exemplar: 'practice.exemplar' }

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
      required: ['sentence', 'options', 'answer', 'translation'],
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
          description: 'The sentence, with the inflected target word wrapped in a single ⟦⟧ marker pair (U+27E6 / U+27E7) — exactly one marker pair, around the inflected surface form only, not the whole clause. e.g. "Er ⟦geht⟧ jeden Tag ins Büro."',
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
// skillType/problemType/extraPrompt come from lib/practiceRules.js's getPracticeRule()
// (api/practice.js resolves the rule and picks `mode` from it before calling this function) — all
// optional so existing callers that pass a bare card (e.g. the test suites) keep working
// unchanged, falling back to that questionType's own base problem type (registry.js's compose()
// defaults problemType to 'mc_cloze'/'exemplar' respectively).
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
export async function generatePracticeItem({ anthropic, model = DEFAULT_PRACTICE_MODEL, mode, promptContext, history = [], onRequest }) {
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

  async function generate(retryNote) {
    let systemPrompt = compose(promptId, promptContext)
    if (retryNote) {
      systemPrompt += `\n\n## Previous attempt was rejected\n${retryNote}\nFix this and try again.`
    }
    const messages = buildMessages()
    onRequest?.({ model, system: systemPrompt, messages })
    const message = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
    })
    const toolUse = message.content.find(b => b.type === 'tool_use')
    if (!toolUse) throw new PracticeValidationError('Model did not return a tool call')
    return mode === 'exemplar' ? resolveExemplarMarkers(toolUse.input) : toolUse.input
  }

  const validationContext = { cardKind: promptContext.card?.kind }

  try {
    const item = await generate()
    validatePracticeItem(mode, item, validationContext)
    return item
  } catch (e) {
    if (!(e instanceof PracticeValidationError)) throw e
    try {
      const item = await generate(e.message)
      validatePracticeItem(mode, item, validationContext)
      return item
    } catch (e2) {
      throw new PracticeGenerationFailedError(e2 instanceof PracticeValidationError ? e2.message : String(e2))
    }
  }
}
