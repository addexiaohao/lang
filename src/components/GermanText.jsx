import { speak } from '../tts.js'
import { useProject } from '../ProjectContext.jsx'
import { getProjectConfig } from '../../lib/projectConfig.js'
import { computeHighlightSegments } from '../highlightText.js'

function extractText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node?.props?.children !== undefined) return extractText(node.props.children)
  return ''
}

// Renders foreign-language text (from <de>...</de> tags or plain string) with per-word click-to-speak.
// Used both by ReactMarkdown (children = React nodes) and directly (children = string).
// `positions` ([{start, end}], absolute offsets into the full text) optionally highlights
// a span (e.g. the portion a knowledge card refers to) without disturbing word-level TTS.
export default function GermanText({ children, positions = [], highlightClassName = 'bg-yellow-200 text-yellow-900' }) {
  const { activeProject } = useProject()
  const { ttsLocale } = getProjectConfig(activeProject ?? {})
  const text = typeof children === 'string' ? children : extractText(children)

  let cursor = 0
  return (
    <span>
      {text.split(/(\s+)/).map((part, i) => {
        const start = cursor
        cursor += part.length

        if (/^\s+$/.test(part)) return <span key={i}>{part}</span>

        const localPositions = positions
          .map(p => ({ start: Math.max(p.start, start) - start, end: Math.min(p.end, start + part.length) - start }))
          .filter(p => p.end > p.start)
        const segments = computeHighlightSegments(part, localPositions)

        return (
          <span
            key={i}
            onClick={() => speak(part, ttsLocale)}
            className="cursor-pointer rounded px-0.5 text-amber-700 underline decoration-dotted decoration-amber-400 hover:bg-yellow-100 transition-colors"
            title={`Speak: "${part}"`}
          >
            {segments.map((seg, j) =>
              seg.highlight
                ? <mark key={j} className={`${highlightClassName} rounded-sm`}>{seg.text}</mark>
                : seg.text
            )}
          </span>
        )
      })}
    </span>
  )
}
