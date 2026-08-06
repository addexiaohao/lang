// Resolves an annotated sentence (with ⟦fragment⟧ markers) to absolute character
// positions within a source's original_text.
//
// Markers: U+27E6 ⟦ (open) and U+27E7 ⟧ (close). These are mathematical double
// brackets that essentially never appear in natural-language text.
//
// Returns [{start, end}] where start/end are absolute offsets into originalText.
// Throws with a descriptive message on any resolution failure.

import { stripMarkers } from './annotationMarkers.js'

export function resolvePositions(annotatedSentence, originalText) {
  if (originalText.includes('⟦') || originalText.includes('⟧')) {
    throw new Error('Source text contains reserved marker characters ⟦⟧ — cannot resolve positions')
  }

  const { text: stripped, positions: fragments } = stripMarkers(annotatedSentence)

  if (fragments.length === 0) {
    throw new Error('No marker pairs found in annotated sentence')
  }

  const sentenceOffset = originalText.indexOf(stripped)
  if (sentenceOffset === -1) {
    throw new Error('Stripped sentence does not appear verbatim in source text')
  }

  return fragments.map(f => ({ start: f.start + sentenceOffset, end: f.end + sentenceOffset }))
}
