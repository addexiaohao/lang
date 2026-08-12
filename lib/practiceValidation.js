// Semantic validation for generated practice items — beyond the JSON-schema shape already
// enforced by the forced tool_choice call. Failures throw with a message that doubles as the
// retry-prompt note (see api/practice.js).

export class PracticeValidationError extends Error {}

export function validatePracticeItem(mode, item, { cardKind } = {}) {
  if (typeof item?.sentence !== 'string' || !item.sentence.trim()) {
    throw new PracticeValidationError('sentence is required and must be non-empty')
  }
  if (typeof item?.sense_key !== 'string' || !item.sense_key.trim()) {
    throw new PracticeValidationError('sense_key is required and must be non-empty')
  }
  if (typeof item?.translation !== 'string' || !item.translation.trim()) {
    throw new PracticeValidationError('translation is required and must be non-empty')
  }

  if (mode === 'mc_cloze') {
    const blankCount = (item.sentence.match(/___/g) ?? []).length
    if (blankCount !== 1) {
      throw new PracticeValidationError(`sentence must contain exactly one "___" blank, found ${blankCount}`)
    }
    if (!Array.isArray(item.options) || item.options.length < 3 || item.options.length > 4) {
      throw new PracticeValidationError('options must be an array of 3-4 strings')
    }
    if (item.options.some(o => typeof o !== 'string' || !o.trim())) {
      throw new PracticeValidationError('options must all be non-empty strings')
    }
    if (new Set(item.options).size !== item.options.length) {
      throw new PracticeValidationError('options must be unique')
    }
    if (typeof item.answer !== 'string' || !item.options.includes(item.answer)) {
      throw new PracticeValidationError('answer must exactly match one of the options, verbatim')
    }
    if (cardKind === 'vocabulary') {
      if (!Array.isArray(item.option_meanings) || item.option_meanings.length !== item.options.length) {
        throw new PracticeValidationError('option_meanings is required for vocabulary cards and must have one entry per option, in the same order')
      }
      if (item.option_meanings.some(m => typeof m !== 'string' || !m.trim())) {
        throw new PracticeValidationError('option_meanings must all be non-empty strings')
      }
    } else if (item.option_meanings !== undefined) {
      if (!Array.isArray(item.option_meanings) || item.option_meanings.length !== item.options.length) {
        throw new PracticeValidationError('option_meanings, if present, must have one entry per option, in the same order')
      }
    }
    return
  }

  if (mode === 'exemplar') {
    // target_span is derived server-side from the model's ⟦⟧ marker (see api/practice.js's
    // resolveExemplarMarkers), so it's always a well-formed, in-range [start, end] pair by
    // construction — no need to re-check that here. The one thing marker placement can still get
    // wrong is wrapping whitespace along with the word.
    const [start, end] = item.target_span
    const span = item.sentence.slice(start, end)
    if (!span.trim() || /^\s|\s$/.test(span)) {
      throw new PracticeValidationError('target_span must point at a contiguous word, not whitespace-padded')
    }
    return
  }

  throw new PracticeValidationError(`unknown mode: ${mode}`)
}
