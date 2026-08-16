export class AssertionError extends Error {
  constructor(message, context) {
    super(message)
    this.name = 'AssertionError'
    this.context = context
  }
}

const VALID_KINDS = ['vocabulary', 'grammar', 'expression']

// Format checks — run on every emitted block regardless of test case.
// These are hard failures: malformed output is never acceptable.

export function assertNoParseErrors(blocks) {
  for (const b of blocks) {
    if (b.parseError)
      throw new AssertionError(
        `save:${b.type} block has invalid JSON: ${b.parseError}`,
        { raw: b.raw }
      )
  }
}

export function assertValidFormat(blocks) {
  for (const { type, parsed } of blocks.filter(b => b.parsed)) {
    if (type === 'source') {
      if (!parsed.original_text)
        throw new AssertionError('save:source missing required field: original_text', parsed)
    }

    if (type === 'knowledge_card') {
      if (!parsed.kind)
        throw new AssertionError('save:knowledge_card missing required field: kind', parsed)
      if (!VALID_KINDS.includes(parsed.kind))
        throw new AssertionError(`save:knowledge_card invalid kind "${parsed.kind}"`, parsed)
      if (!parsed.name)
        throw new AssertionError('save:knowledge_card missing required field: name', parsed)
      if (parsed.importance !== undefined && (parsed.importance < 1 || parsed.importance > 10))
        throw new AssertionError(`save:knowledge_card importance out of range: ${parsed.importance}`, parsed)
      if (parsed.tags !== undefined && !Array.isArray(parsed.tags))
        throw new AssertionError('save:knowledge_card tags must be an array', parsed)

      const tags = parsed.tags ?? []
      if (tags.includes('plural-only')) {
        for (const gender of ['masc', 'fem', 'neut']) {
          if (tags.includes(gender))
            throw new AssertionError(
              `"${parsed.name}": plural-only noun must not also have gender tag "${gender}"`,
              parsed
            )
        }
      }
    }
  }
}

// Helpers for per-case conditional assertions.
// "Conditional" means: only fail if the card IS present and wrong.
// Never fail because a card wasn't emitted — that's a judgment call.

export function findCards(blocks, namePattern) {
  return blocks
    .filter(b => b.type === 'knowledge_card' && b.parsed)
    .map(b => b.parsed)
    .filter(c =>
      typeof namePattern === 'string'
        ? c.name === namePattern
        : namePattern.test(c.name)
    )
}

export function mustHaveTags(card, tags) {
  const cardTags = card.tags ?? []
  for (const tag of tags) {
    if (!cardTags.includes(tag))
      throw new AssertionError(`"${card.name}": missing expected tag "${tag}"`, card)
  }
}

export function mustNotHaveTags(card, tags) {
  const cardTags = card.tags ?? []
  for (const tag of tags) {
    if (cardTags.includes(tag))
      throw new AssertionError(`"${card.name}": must not have tag "${tag}"`, card)
  }
}

export function mustBeKind(card, kind) {
  if (card.kind !== kind)
    throw new AssertionError(`"${card.name}": expected kind "${kind}", got "${card.kind}"`, card)
}

// Assert no card matching namePattern exists in the blocks.
export function mustBeAbsent(blocks, namePattern, reason) {
  const found = findCards(blocks, namePattern)
  if (found.length > 0)
    throw new AssertionError(
      `card "${found[0].name}" must not be emitted — ${reason}`,
      found[0]
    )
}
