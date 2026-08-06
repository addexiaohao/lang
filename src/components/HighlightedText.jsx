import { computeHighlightSegments } from '../highlightText.js'

// Default is intentionally plain and easy to swap out later.
export const DEFAULT_HIGHLIGHT_CLASS = 'bg-yellow-100'

// Renders `text` with <mark> spans at the given [{start, end}] absolute
// character positions. Reusable anywhere a piece of text needs positional
// highlighting (source detail view, annotated sentences, etc.) —
// highlightClassName lets callers configure the look per use site.
//
// Passing onHoverIndex additionally wraps every character in its own span
// and reports the absolute character index under the pointer (or null on
// leave) — char-precision "what's under the cursor" for reverse lookups
// (e.g. hovering source text to find which cards cover that position).
export function HighlightedText({ text, positions = [], highlightClassName = DEFAULT_HIGHLIGHT_CLASS, onHoverIndex }) {
  const parts = computeHighlightSegments(text, positions)
  let cursor = 0

  return (
    <>
      {parts.map((part, i) => {
        const start = cursor
        cursor += part.text.length

        const content = onHoverIndex
          ? Array.from({ length: part.text.length }, (_, j) => (
              <span
                key={j}
                onMouseEnter={() => onHoverIndex(start + j)}
                onMouseLeave={() => onHoverIndex(null)}
              >
                {part.text[j]}
              </span>
            ))
          : part.text

        return part.highlight
          ? <mark key={i} className={`${highlightClassName} rounded-sm`}>{content}</mark>
          : <span key={i}>{content}</span>
      })}
    </>
  )
}
