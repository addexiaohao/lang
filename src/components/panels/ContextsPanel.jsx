import { useState } from 'react'
import { apiFetch } from '../../apiFetch.js'
export function ContextsPanel({ activeProject, contexts, setContexts, onDragStart, onClose }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleCreate(e) {
    e.preventDefault()
    if (!name.trim() || !activeProject) return
    setSaving(true)
    setError(null)
    try {
      const res = await apiFetch('/api/contexts', {
        method: 'POST',
        body: JSON.stringify({ project_id: activeProject.id, name: name.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create context')
      setContexts(prev => [...prev, data])
      setName('')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-w-0">
      <div
        className="px-3 py-2 border-b bg-white shrink-0 flex items-center cursor-grab active:cursor-grabbing select-none"
        onMouseDown={onDragStart}
      >
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Contexts</span>
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
      </div>

      <div className="flex-1 overflow-y-auto">
        {contexts.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-8">No contexts yet.</p>
        )}
        {contexts.map(ctx => (
          <div key={ctx.id} className="px-3 py-2.5 border-b border-gray-100">
            <p className="text-sm text-gray-800">{ctx.name}</p>
            {ctx.description && (
              <p className="text-xs text-gray-400 mt-0.5">{ctx.description}</p>
            )}
          </div>
        ))}
      </div>

      {/* New context form pinned at bottom */}
      <div className="px-3 py-3 border-t bg-white shrink-0">
        <form onSubmit={handleCreate} className="flex gap-2">
          <input
            className="flex-1 text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
            placeholder="New context…"
            value={name}
            onChange={e => setName(e.target.value)}
            disabled={!activeProject}
          />
          <button
            type="submit"
            disabled={saving || !name.trim() || !activeProject}
            className="px-3 py-1.5 rounded-lg bg-blue-500 text-white text-sm hover:bg-blue-600 disabled:opacity-40 transition-colors shrink-0"
          >
            {saving ? '…' : 'Add'}
          </button>
        </form>
        {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
      </div>
    </div>
  )
}
