import { speak } from '../tts.js'
import { useProject } from '../ProjectContext.jsx'
import { getProjectConfig } from '../../lib/projectConfig.js'

function extractText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node?.props?.children !== undefined) return extractText(node.props.children)
  return ''
}

// Renders foreign-language text (from <de>...</de> tags or plain string) with per-word click-to-speak.
// Used both by ReactMarkdown (children = React nodes) and directly (children = string).
export default function GermanText({ children }) {
  const { activeProject } = useProject()
  const { ttsLocale } = getProjectConfig(activeProject ?? {})
  const text = typeof children === 'string' ? children : extractText(children)
  return (
    <span>
      {text.split(/(\s+)/).map((part, i) =>
        /^\s+$/.test(part) ? (
          <span key={i}>{part}</span>
        ) : (
          <span
            key={i}
            onClick={() => speak(part, ttsLocale)}
            className="cursor-pointer rounded px-0.5 text-amber-700 underline decoration-dotted decoration-amber-400 hover:bg-yellow-100 transition-colors"
            title={`Speak: "${part}"`}
          >
            {part}
          </span>
        )
      )}
    </span>
  )
}
