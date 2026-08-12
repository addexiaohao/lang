// Practice item generation — composes the prompt, calls Anthropic with a forced tool_choice so
// the response is schema-conformant by construction, validates the result, retries once with the
// validation error appended to the prompt. Used by api/practice.js (with real Supabase-sourced
// promptContext) and by the practice test suite (with fixture promptContext) — both call this
// exact function so tests exercise the real generation logic, not a re-implementation of it.

import { compose } from './prompts/registry.js'
import { validatePracticeItem, PracticeValidationError } from './practiceValidation.js'
import { stripMarkers } from './annotationMarkers.js'

export const DEFAULT_PRACTICE_MODEL = 'claude-sonnet-4-6'

const PROMPT_IDS = { mc_cloze: 'practice.mc_cloze', exemplar: 'practice.exemplar' }

const TOOLS = {
  mc_cloze: {
    name: 'emit_mc_cloze_item',
    description: 'Emit the generated multiple-choice cloze exercise.',
    input_schema: {
      type: 'object',
      properties: {
        sentence: { type: 'string', description: 'The sentence with exactly one blank marked "___"' },
        options: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 4 },
        answer: { type: 'string', description: 'Must exactly match one of the options' },
        sense_key: { type: 'string', description: 'Short slug for the sense/frame tested, e.g. "motion.physical.place"' },
        translation: { type: 'string', description: 'Full English translation of the complete sentence, blank filled in by answer' },
        option_meanings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only when this card tests word meaning (a vocabulary card): one short English gloss per option, same order/length as options. Omit entirely for grammar/expression cards.',
        },
      },
      required: ['sentence', 'options', 'answer', 'sense_key', 'translation'],
    },
  },
  exemplar: {
    name: 'emit_exemplar_item',
    description: 'Emit the generated example-sentence exercise.',
    input_schema: {
      type: 'object',
      properties: {
        sentence: {
          type: 'string',
          description: 'The sentence, with the inflected target word wrapped in a single ⟦⟧ marker pair (U+27E6 / U+27E7), e.g. "Er ⟦geht⟧ jeden Tag ins Büro."',
        },
        sense_key: { type: 'string', description: 'Short slug for the sense/context used' },
        translation: { type: 'string', description: 'Full English translation of the complete sentence, markers stripped' },
      },
      required: ['sentence', 'sense_key', 'translation'],
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
  return { sentence: text, target_span: [positions[0].start, positions[0].end], sense_key: rawItem.sense_key, translation: rawItem.translation }
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

// promptContext: { ttsLocale, card, avoid, seedCardNames } — see lib/prompts/registry.js's
// practice.mc_cloze / practice.exemplar compose() for the exact shape.
// `onRequest`, if given, is called with { model, system, messages } right before each Anthropic
// call (including retries) — lets the caller surface the exact text sent to the model (see
// api/practice.js, which forwards the final attempt's request back to the client for the
// browser-console "[LLM request]" log, since the client only ever sends a card_id/mode/avoid).
export async function generatePracticeItem({ anthropic, model = DEFAULT_PRACTICE_MODEL, mode, promptContext, onRequest }) {
  const promptId = PROMPT_IDS[mode]
  const tool = TOOLS[mode]

  async function generate(retryNote) {
    let systemPrompt = compose(promptId, promptContext)
    if (retryNote) {
      systemPrompt += `\n\n## Previous attempt was rejected\n${retryNote}\nFix this and try again.`
    }
    const messages = [{ role: 'user', content: 'Generate the item now.' }]
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
