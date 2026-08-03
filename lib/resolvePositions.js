// Resolves an annotated sentence (with ⟦fragment⟧ markers) to absolute character
// positions within a source's original_text.
//
// Markers: U+27E6 ⟦ (open) and U+27E7 ⟧ (close). These are mathematical double
// brackets that essentially never appear in natural-language text.
//
// Returns [{start, end}] where start/end are absolute offsets into originalText.
// Throws with a descriptive message on any resolution failure.

const OPEN = '⟦'
const CLOSE = '⟧'

export function resolvePositions(annotatedSentence, originalText) {
  if (originalText.includes(OPEN) || originalText.includes(CLOSE)) {
    throw new Error('Source text contains reserved marker characters ⟦⟧ — cannot resolve positions')
  }

  const fragments = []
  let stripped = ''
  let i = 0

  while (i < annotatedSentence.length) {
    const ch = annotatedSentence[i]
    if (ch === OPEN) {
      const closeIdx = annotatedSentence.indexOf(CLOSE, i + 1)
      if (closeIdx === -1) throw new Error('Unmatched opening marker ⟦ in annotated sentence')
      const fragmentText = annotatedSentence.slice(i + 1, closeIdx)
      if (!fragmentText) throw new Error('Empty marker pair ⟦⟧ in annotated sentence')
      const start = stripped.length
      stripped += fragmentText
      fragments.push({ start, end: stripped.length })
      i = closeIdx + 1
    } else if (ch === CLOSE) {
      throw new Error('Unexpected closing marker ⟧ without opening ⟦')
    } else {
      stripped += ch
      i++
    }
  }

  if (fragments.length === 0) {
    throw new Error('No marker pairs found in annotated sentence')
  }

  const sentenceOffset = originalText.indexOf(stripped)
  if (sentenceOffset === -1) {
    throw new Error('Stripped sentence does not appear verbatim in source text')
  }

  return fragments.map(f => ({ start: f.start + sentenceOffset, end: f.end + sentenceOffset }))
}
