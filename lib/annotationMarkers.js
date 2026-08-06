// Parsing/serializing of ⟦fragment⟧ markers used in annotated_sentence strings.
// Split out from resolvePositions.js so the frontend can reuse the same logic
// to preview and edit spans before a card is saved.

const OPEN = '⟦'
const CLOSE = '⟧'

// Strips ⟦⟧ markers from an annotated sentence, returning the plain text plus
// the marked fragments as positions local to that plain text.
export function stripMarkers(annotatedSentence) {
  const positions = []
  let text = ''
  let i = 0

  while (i < annotatedSentence.length) {
    const ch = annotatedSentence[i]
    if (ch === OPEN) {
      const closeIdx = annotatedSentence.indexOf(CLOSE, i + 1)
      if (closeIdx === -1) throw new Error('Unmatched opening marker ⟦ in annotated sentence')
      const fragmentText = annotatedSentence.slice(i + 1, closeIdx)
      if (!fragmentText) throw new Error('Empty marker pair ⟦⟧ in annotated sentence')
      const start = text.length
      text += fragmentText
      positions.push({ start, end: text.length })
      i = closeIdx + 1
    } else if (ch === CLOSE) {
      throw new Error('Unexpected closing marker ⟧ without opening ⟦')
    } else {
      text += ch
      i++
    }
  }

  return { text, positions }
}

// Inverse of stripMarkers: wraps the given [{start, end}] ranges (local to
// `text`) in ⟦⟧ markers, producing an annotated_sentence string.
export function applyMarkers(text, positions) {
  if (!positions?.length) return text
  const sorted = [...positions].sort((a, b) => a.start - b.start)
  let result = ''
  let cursor = 0
  for (const { start, end } of sorted) {
    result += text.slice(cursor, start)
    result += OPEN + text.slice(start, end) + CLOSE
    cursor = end
  }
  result += text.slice(cursor)
  return result
}
