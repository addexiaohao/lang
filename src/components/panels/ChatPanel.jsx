import { useState, useRef, useEffect, useCallback } from 'react'
import ChatMessage from '../ChatMessage.jsx'
import { apiFetch } from '../../apiFetch.js'

export function ChatPanel({ activeProject, contexts, forcedContext, tagCatalog, onNewTags, input, onInputChange, onDragStart, onClose, title = 'Chat', initialMessage }) {
  const [messages, setMessages] = useState([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [sourceRefMap, setSourceRefMap] = useState({})
  const bottomRef = useRef(null)
  const scrollContainerRef = useRef(null)
  const stickToBottomRef = useRef(true)
  const autoSentRef = useRef(false)
  // null sentinel means "never mounted with a project yet" — distinguishes a genuine project
  // switch (which should clear the conversation) from React 18 Strict Mode's dev-only double
  // invocation of this same effect on initial mount, which would otherwise re-fire the reset
  // *after* an `initialMessage` auto-send's own state updates and wipe them out mid-flight.
  const mountedProjectIdRef = useRef(null)

  useEffect(() => {
    if (mountedProjectIdRef.current !== null && mountedProjectIdRef.current !== activeProject?.id) {
      setMessages([])
      setSourceRefMap({})
    }
    mountedProjectIdRef.current = activeProject?.id ?? null
    stickToBottomRef.current = true
  }, [activeProject?.id])

  useEffect(() => {
    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < 80
  }, [])

  const handleSourceRegistered = useCallback((ref, text) => {
    setSourceRefMap(prev => ({ ...prev, [ref]: { ...(prev[ref] ?? {}), text } }))
  }, [])

  const handleSourceSaved = useCallback((ref, id) => {
    if (ref != null) setSourceRefMap(prev => ({ ...prev, [ref]: { ...(prev[ref] ?? {}), id } }))
  }, [])

  async function sendText(text) {
    if (!text || isStreaming || !activeProject) return

    const userMessage = { role: 'user', content: text }
    const nextMessages = [...messages, userMessage]
    stickToBottomRef.current = true
    setMessages(nextMessages)
    onInputChange('')
    setIsStreaming(true)
    setMessages(prev => [...prev, { role: 'assistant', content: '' }])

    try {
      console.log('[LLM request]', JSON.stringify(nextMessages, null, 2))
      const res = await apiFetch('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ project_id: activeProject.id, messages: nextMessages }),
      })
      if (!res.ok) throw new Error(`API error: ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let fullResponse = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        fullResponse += chunk
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: updated[updated.length - 1].content + chunk,
          }
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
      setIsStreaming(false)
    }
  }

  function sendMessage(e) {
    e.preventDefault()
    return sendText(input.trim())
  }

  // `initialMessage` (e.g. Practice's "Add source") is sent as the very first turn the instant
  // the panel appears, standing in for the user pasting/typing it themselves — no manual step.
  // Guarded to fire exactly once per mount; a genuinely new initialMessage means a remount (the
  // caller conditionally renders this panel fresh each time), not a prop change on a live one.
  useEffect(() => {
    if (!initialMessage || autoSentRef.current || !activeProject) return
    autoSentRef.current = true
    sendText(initialMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id])

  return (
    <div className="flex flex-col h-full min-w-0">
      <div
        className="px-3 py-2 border-b bg-white shrink-0 flex items-center cursor-grab active:cursor-grabbing select-none"
        onMouseDown={onDragStart}
      >
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{title}</span>
        <button
          onClick={() => { setMessages([]); setSourceRefMap({}) }}
          onMouseDown={e => e.stopPropagation()}
          disabled={isStreaming || messages.length === 0}
          aria-label="New chat"
          className="ml-auto mr-2 text-gray-400 hover:text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="New chat"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        {onClose && (
          <button
            onClick={onClose}
            onMouseDown={e => e.stopPropagation()}
            aria-label="Close"
            className="ml-auto text-gray-400 hover:text-gray-600 transition-colors shrink-0"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {messages.length === 0 && (
          <p className="text-center text-gray-400 mt-16 text-sm">
            Paste some text in your target language to get started.
          </p>
        )}
        {messages.map((msg, i) => (
          <ChatMessage
            key={i}
            role={msg.role}
            content={msg.content}
            sourceRefMap={sourceRefMap}
            onSourceRegistered={handleSourceRegistered}
            onSourceSaved={handleSourceSaved}
            contexts={contexts}
            forcedContext={forcedContext}
            tagCatalog={tagCatalog}
            onNewTags={onNewTags}
            projectId={activeProject?.id}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={sendMessage} className="px-3 py-3 border-t bg-white flex gap-2 shrink-0">
        <input
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-100"
          placeholder="Type a message…"
          value={input}
          onChange={e => onInputChange(e.target.value)}
          disabled={isStreaming || !activeProject}
          autoFocus
        />
        <button
          type="submit"
          disabled={isStreaming || !input.trim() || !activeProject}
          className="px-4 py-2 rounded-lg bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isStreaming ? 'Thinking…' : 'Send'}
        </button>
      </form>
    </div>
  )
}
