import { useState, useRef, useEffect } from 'react'
import { useProject } from '../ProjectContext.jsx'

export function ProjectSwitcher() {
  const { projects, activeProject, setActiveProject, defaultProjectId, setDefault } = useProject()
  const [open, setOpen] = useState(false)
  const [showNewProject, setShowNewProject] = useState(false)
  const containerRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div className="relative" ref={containerRef}>
      <div className="flex items-center gap-1">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1.5 text-sm font-medium text-gray-700 hover:text-gray-900 border border-gray-300 rounded-lg px-3 py-1.5 bg-white hover:bg-gray-50 transition-colors"
        >
          {activeProject?.name ?? 'Select project'}
          <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
          {projects.map(p => (
            <div
              key={p.id}
              onClick={() => { setActiveProject(p); setOpen(false) }}
              className="flex items-center justify-between px-3 py-2 hover:bg-gray-50 cursor-pointer"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-blue-500 w-4 text-center text-sm shrink-0">
                  {p.id === activeProject?.id ? '✓' : ''}
                </span>
                <span className="text-sm text-gray-700 truncate">{p.name}</span>
              </div>
              <button
                onClick={e => { e.stopPropagation(); setDefault(p.id) }}
                aria-label={p.id === defaultProjectId ? 'Default project' : 'Set as default'}
                className="ml-2 text-base leading-none shrink-0 text-gray-300 hover:text-yellow-400 transition-colors"
              >
                {p.id === defaultProjectId ? '★' : '☆'}
              </button>
            </div>
          ))}
          <div className="border-t border-gray-100 mt-1 pt-1">
            <div
              onClick={() => { setShowNewProject(true); setOpen(false) }}
              className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer text-sm text-gray-600"
            >
              <span className="text-blue-500 font-medium">+</span> New project
            </div>
          </div>
        </div>
      )}

      {showNewProject && (
        <NewProjectModal onClose={() => setShowNewProject(false)} />
      )}
    </div>
  )
}

function NewProjectModal({ onClose }) {
  const { createProject } = useProject()
  const [name, setName] = useState('')
  const [locale, setLocale] = useState('')
  const [contextsRequired, setContextsRequired] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) { setError('Name is required'); return }
    setSaving(true)
    try {
      await createProject(name.trim(), {
        tts_locale: locale.trim() || null,
        context_required: contextsRequired,
      })
      onClose()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="bg-white rounded-xl shadow-lg w-80 p-5">
        <h2 className="text-base font-semibold text-gray-800 mb-4">New project</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
            <input
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              placeholder="German"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Language locale</label>
            <input
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              placeholder="de-DE"
              value={locale}
              onChange={e => setLocale(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-600">Contexts required</label>
            <button
              type="button"
              onClick={() => setContextsRequired(v => !v)}
              className={`relative w-10 h-5 rounded-full flex-shrink-0 transition-colors ${contextsRequired ? 'bg-blue-500' : 'bg-gray-300'}`}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${contextsRequired ? 'left-[22px]' : 'left-0.5'}`}
              />
            </button>
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="px-4 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-40 transition-colors"
            >
              {saving ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
