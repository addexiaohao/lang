// Pure logic for splitting text into highlighted/non-highlighted segments
// given a list of absolute { start, end } character ranges. Kept separate
// from any component so it can be reused (e.g. for annotated_sentence
// spans, search-match highlighting, etc.) without pulling in React.

export function computeHighlightSegments(text, positions = []) {
  if (!positions?.length) return [{ text, highlight: false }]

  const sorted = [...positions].sort((a, b) => a.start - b.start)
  const parts = []
  let cursor = 0

  for (const { start, end } of sorted) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), highlight: false })
    parts.push({ text: text.slice(start, end), highlight: true })
    cursor = end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlight: false })

  return parts
}

// Whether an absolute character index falls inside any of the given
// [{start, end}] ranges (end-exclusive, matching computeHighlightSegments).
export function isIndexInRanges(index, ranges = []) {
  if (index == null) return false
  return ranges.some(({ start, end }) => index >= start && index < end)
}
