import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import ChatMessage from './components/ChatMessage.jsx'
import { ProjectSwitcher } from './components/ProjectSwitcher.jsx'
import { useProject } from './ProjectContext.jsx'
import { apiFetch } from './apiFetch.js'
import { supabase } from './supabaseClient.js'

function NewContextForm({ projectId, onCreated }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleCreate(e) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      const res = await apiFetch('/api/contexts', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, name: name.trim() }),
      })
      const data = await res.json()
      if (res.ok) {
        onCreated(data)
        setName('')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleCreate} className="flex items-center gap-1">
      <input
        className="text-xs border border-gray-300 rounded px-2 py-1 w-36 focus:outline-none focus:ring-1 focus:ring-blue-400"
        placeholder="New context…"
        value={name}
        onChange={e => setName(e.target.value)}
      />
      <button
        type="submit"
        disabled={saving || !name.trim()}
        className="text-xs px-2 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 transition-colors"
      >
        {saving ? '…' : 'Add'}
      </button>
    </form>
  )
}

export default function App() {
  const { activeProject, loading: projectsLoading } = useProject()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  // sourceRefMap: { [ref]: { id?: string, text?: string } } — conversation-wide source tracking
  const [sourceRefMap, setSourceRefMap] = useState({})
  const [contexts, setContexts] = useState([])
  const [tagCatalog, setTagCatalog] = useState([])
  const [showNewContext, setShowNewContext] = useState(false)
  const bottomRef = useRef(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!activeProject) return
    apiFetch(`/api/contexts?project_id=${activeProject.id}`)
      .then(r => r.ok ? r.json() : [])
      .then(setContexts)
      .catch(() => {})
    apiFetch(`/api/tags?project_id=${activeProject.id}`)
      .then(r => r.ok ? r.json() : [])
      .then(setTagCatalog)
      .catch(() => {})
    // Reset conversation when switching projects
    setMessages([])
    setSourceRefMap({})
  }, [activeProject?.id])

  const handleSourceRegistered = useCallback((ref, text) => {
    setSourceRefMap(prev => ({ ...prev, [ref]: { ...(prev[ref] ?? {}), text } }))
  }, [])

  const handleSourceSaved = useCallback((ref, id) => {
    if (ref != null) setSourceRefMap(prev => ({ ...prev, [ref]: { ...(prev[ref] ?? {}), id } }))
  }, [])

  function refreshTagCatalog() {
    if (!activeProject) return
    apiFetch(`/api/tags?project_id=${activeProject.id}`)
      .then(r => r.ok ? r.json() : [])
      .then(setTagCatalog)
      .catch(() => {})
  }

  function handleContextCreated(context) {
    setContexts(prev => [...prev, context])
    setShowNewContext(false)
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage(e) {
    e.preventDefault()
    const text = input.trim()
    if (!text || isStreaming || !activeProject) return

    const userMessage = { role: 'user', content: text }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setInput('')
    setIsStreaming(true)

    setMessages(prev => [...prev, { role: 'assistant', content: '' }])

    try {
      const res = await apiFetch('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ project_id: activeProject.id, messages: nextMessages }),
      })

      if (!res.ok) throw new Error(`API error: ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: updated[updated.length - 1].content + chunk,
          }
          return updated
        })
      }
    } catch (err) {
      setMessages(prev => {
        const updated = [...prev]
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          content: `Error: ${err.message}`,
        }
        return updated
      })
    } finally {
      setIsStreaming(false)
    }
  }

  if (projectsLoading) return null

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="px-4 py-3 border-b bg-white shadow-sm flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <ProjectSwitcher />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {showNewContext ? (
            <NewContextForm projectId={activeProject?.id} onCreated={handleContextCreated} />
          ) : (
            <button
              onClick={() => setShowNewContext(true)}
              className="text-xs text-gray-500 hover:text-blue-600 border border-gray-200 rounded px-2 py-1 transition-colors"
            >
              + Context
            </button>
          )}
          <button
            onClick={handleLogout}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
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
            tagCatalog={tagCatalog}
            onNewTags={refreshTagCatalog}
            projectId={activeProject?.id}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={sendMessage}
        className="px-4 py-3 border-t bg-white flex gap-2"
      >
        <input
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-100"
          placeholder="Type a message…"
          value={input}
          onChange={e => setInput(e.target.value)}
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
