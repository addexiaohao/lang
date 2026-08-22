// Semantic validation for generated practice items — beyond the JSON-schema shape already
// enforced by the forced tool_choice call. Failures throw with a message that doubles as the
// retry-prompt note (see api/practice.js).

export class PracticeValidationError extends Error {}

export function validatePracticeItem(mode, item, { cardKind, cardTags, skillType } = {}) {
  if (typeof item?.sentence !== 'string' || !item.sentence.trim()) {
    throw new PracticeValidationError('sentence is required and must be non-empty')
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
    const distractors = item.options.filter(o => o !== item.answer)
    if (!Array.isArray(item.distractor_reasons) || item.distractor_reasons.length !== distractors.length) {
      throw new PracticeValidationError('distractor_reasons is required and must have exactly one entry per distractor (every option except answer)')
    }
    const namedDistractors = new Set()
    for (const entry of item.distractor_reasons) {
      if (!entry || typeof entry.option !== 'string' || !distractors.includes(entry.option)) {
        throw new PracticeValidationError('each distractor_reasons entry must name one of the distractor options, verbatim')
      }
      if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
        throw new PracticeValidationError('each distractor_reasons entry must include a non-empty reason')
      }
      namedDistractors.add(entry.option)
    }
    if (namedDistractors.size !== distractors.length) {
      throw new PracticeValidationError('distractor_reasons must cover every distractor exactly once, with no duplicates')
    }
    if (skillType === 'production' && cardTags?.includes('production-which-preposition') && (typeof item.frame !== 'string' || !item.frame.trim())) {
      throw new PracticeValidationError('frame is required for this skill — state the verb/construction that governs the target preposition, before the sentence')
    }
    return
  }

  if (mode === 'spelling') {
    const blankCount = (item.sentence.match(/___/g) ?? []).length
    if (blankCount !== 1) {
      throw new PracticeValidationError(`sentence must contain exactly one "___" blank, found ${blankCount}`)
    }
    if (typeof item.answer !== 'string' || !item.answer.trim()) {
      throw new PracticeValidationError('answer is required and must be non-empty')
    }
    if (typeof item.meaning !== 'string' || !item.meaning.trim()) {
      throw new PracticeValidationError('meaning is required and must be non-empty')
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
