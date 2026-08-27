import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { apiFetch } from '../apiFetch.js'

// Docked side panel (not a modal) for Practice mode's "Ask" button, rendered as a
// sibling column inside PracticePanel.jsx. Supports multi-round follow-up: `messages` accumulates
// the whole conversation and the full array is resent to /api/practice-explain every turn (same
// stateless-server/stateful-client pattern ChatPanel.jsx uses for /api/chat). `suggestion` seeds
// the editable draft box for the first turn only; `context` (the practice item's sentence/options/
// card name) rides along silently, folded into the first turn's request content — it's never
// rendered as a message of its own or shown in the box. Responses render as markdown prose —
// never run through ChatMessage's save-block parser, since api/practice-explain.js uses a
// teacher-persona prompt that never emits save blocks.
export default function PracticeExplain({ activeProject, suggestion, context, onClose }) {
  const [messages, setMessages] = useState([]) // { role, content, apiContent? }
  const [draft, setDraft] = useState(suggestion)
  const [loading, setLoading] = useState(false)
  const textareaRef = useRef(null)
  const bottomRef = useRef(null)

  useEffect(() => {
    setMessages([])
    setDraft(suggestion)
  }, [suggestion])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function ask(e) {
    e?.preventDefault()
    const text = draft.trim()
    if (!text || loading || !activeProject) return

    const isFirstTurn = messages.length === 0
    const userMessage = {
      role: 'user',
      content: text,
      apiContent: isFirstTurn && context ? `${text}\n\n${context}` : text,
    }
    const nextMessages = [...messages, userMessage]
    setMessages([...nextMessages, { role: 'assistant', content: '' }])
    setDraft('')
    setLoading(true)

    try {
      const apiMessages = nextMessages.map(m => ({ role: m.role, content: m.apiContent ?? m.content }))
      console.log('[LLM request]', JSON.stringify(apiMessages, null, 2))
      const res = await apiFetch('/api/practice-explain', {
        method: 'POST',
        body: JSON.stringify({ project_id: activeProject.id, messages: apiMessages }),
      })
      if (!res.ok) throw new Error(`API error: ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let fullResponse = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fullResponse += decoder.decode(value, { stream: true })
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = { ...updated[updated.length - 1], content: fullResponse }
          return updated
        })
      }
      console.log('[LLM response]', fullResponse)
    } catch (err) {
      setMessages(prev => {
        const updated = [...prev]
        updated[updated.length - 1] = { ...updated[updated.length - 1], content: `Error: ${err.message}` }
        return updated
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-80 sm:w-96 shrink-0 border-l bg-white flex flex-col h-full min-w-0">
      <div className="px-3 py-2 border-b flex items-center justify-between shrink-0">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Ask</span>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-gray-400 hover:text-gray-600 transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-gray-400 text-xs">Edit the question if you like, then hit Ask.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'user' ? (
              <div className="max-w-[85%] rounded-2xl px-3 py-1.5 text-sm whitespace-pre-wrap leading-relaxed bg-blue-500 text-white rounded-br-sm">
                {m.content}
              </div>
            ) : (
              <div className="max-w-[85%] rounded-2xl px-3 py-1.5 text-sm leading-relaxed bg-gray-50 text-gray-800 border border-gray-200 rounded-bl-sm prose prose-sm max-w-none">
                {m.content ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                ) : (
                  <span className="opacity-40 animate-pulse">▍</span>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={ask} className="px-3 py-3 border-t shrink-0">
        <textarea
          ref={textareaRef}
          className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-100 max-h-40 overflow-y-auto"
          rows={3}
          placeholder={messages.length > 0 ? 'Ask a follow-up…' : undefined}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              ask(e)
            }
          }}
          disabled={loading}
        />
        <div className="mt-2 flex justify-end">
          <button
            type="submit"
            disabled={loading || !draft.trim() || !activeProject}
            className="px-4 py-1.5 rounded-lg bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Asking…' : messages.length > 0 ? 'Send' : 'Ask'}
          </button>
        </div>
      </form>
    </div>
  )
}
