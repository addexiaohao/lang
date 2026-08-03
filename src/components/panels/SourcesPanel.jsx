import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../../apiFetch.js'

const PAGE_SIZE = 25

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function Highlight({ text, query }) {
  if (!query) return text
  const lq = query.toLowerCase()
  const lt = text.toLowerCase()
  const parts = []
  let cursor = 0
  let idx = lt.indexOf(lq)
  if (idx === -1) return text
  while (idx !== -1) {
    if (idx > cursor) parts.push(text.slice(cursor, idx))
    parts.push(<mark key={idx} className="bg-yellow-200 text-inherit not-italic rounded-sm">{text.slice(idx, idx + query.length)}</mark>)
    cursor = idx + query.length
    idx = lt.indexOf(lq, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

function ContextFilterDropdown({ contexts, selectedIds, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  function toggle(id) {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }

  const count = selectedIds.size

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Filter by context"
        className={`flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 transition-colors ${
          count > 0
            ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
            : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
        }`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        {count > 0 && <span>{count}</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded shadow-md min-w-[160px] py-1">
          {contexts.length === 0 && (
            <p className="text-[10px] text-gray-400 px-3 py-1.5">No contexts</p>
          )}
          {count > 0 && (
            <button
              onClick={() => { onChange(new Set()); setOpen(false) }}
              className="w-full text-left text-[10px] text-gray-400 hover:text-gray-600 px-3 py-1.5 hover:bg-gray-50"
            >
              Clear filter
            </button>
          )}
          {contexts.map(ctx => (
            <label
              key={ctx.id}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selectedIds.has(ctx.id)}
                onChange={() => toggle(ctx.id)}
                className="w-3 h-3 accent-blue-500"
              />
              <span className="text-[11px] text-gray-700 truncate">{ctx.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

export function SourcesPanel({ activeProject, onSelectSource, selectedSourceId, onAppendToChat, onDragStart, onClose }) {
  const [sources, setSources] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(0)
  const [selectedContextIds, setSelectedContextIds] = useState(new Set())
  const [contexts, setContexts] = useState([])
  const [refreshKey, setRefreshKey] = useState(0)

  // Reset all state on project switch
  useEffect(() => {
    setSearch('')
    setDebouncedSearch('')
    setPage(0)
    setSelectedContextIds(new Set())
    setSources([])
    setTotal(0)
  }, [activeProject?.id])

  // Fetch contexts for filter dropdown
  useEffect(() => {
    if (!activeProject) return
    apiFetch(`/api/contexts?project_id=${activeProject.id}`)
      .then(r => r.ok ? r.json() : [])
      .then(setContexts)
      .catch(() => {})
  }, [activeProject?.id])

  // Debounce search input — also resets to page 0
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(0)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  // Main fetch: server-side search + context filter + pagination
  useEffect(() => {
    if (!activeProject) return
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({
      project_id: activeProject.id,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
    if (debouncedSearch) params.set('q', debouncedSearch)
    if (selectedContextIds.size > 0) params.set('context_ids', [...selectedContextIds].join(','))
    apiFetch(`/api/sources?${params}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(({ sources, total }) => { setSources(sources); setTotal(total) })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [activeProject?.id, debouncedSearch, page, selectedContextIds, refreshKey])

  function handleContextFilterChange(newIds) {
    setSelectedContextIds(newIds)
    setPage(0)
  }

  // Immediately filter what's already loaded against the live (non-debounced) search and
  // the current context selection. Debounced values drive the API call for the full set.
  const visibleSources = sources.filter(s => {
    if (search && !s.original_text.toLowerCase().includes(search.toLowerCase())) return false
    if (selectedContextIds.size > 0 && !(s.contexts?.id && selectedContextIds.has(s.contexts.id))) return false
    return true
  })

  const pageCount = Math.ceil(total / PAGE_SIZE)
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total)

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* Header */}
      <div
        className="px-3 py-2 border-b bg-white flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={onDragStart}
      >
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Sources</span>
        <div className="flex items-center gap-2" onMouseDown={e => e.stopPropagation()}>
          <ContextFilterDropdown
            contexts={contexts}
            selectedIds={selectedContextIds}
            onChange={handleContextFilterChange}
          />
          <button
            onClick={() => setRefreshKey(k => k + 1)}
            title="Refresh"
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-600 transition-colors shrink-0"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-2 py-1.5 border-b bg-white shrink-0">
        <div className="relative">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
            className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-300 pointer-events-none">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search sources…"
            className="w-full pl-6 pr-6 py-1 text-xs bg-gray-50 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 focus:bg-white placeholder-gray-300"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && sources.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-8">Loading…</p>
        )}
        {error && (
          <p className="text-xs text-red-500 text-center mt-8">{error}</p>
        )}
        {!loading && !error && visibleSources.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-8">
            {search || selectedContextIds.size > 0 ? 'No sources match.' : 'No sources yet.'}
          </p>
        )}
        {visibleSources.map(source => {
          const cardCount = source.source_knowledge?.length ?? 0
          const isSelected = source.id === selectedSourceId
          return (
            <div
              key={source.id}
              className={`relative group border-b border-gray-100 ${isSelected ? 'bg-blue-50' : ''}`}
            >
              <button
                onClick={() => onSelectSource(source)}
                className={`
                  w-full text-left px-3 py-2.5 pr-7 transition-colors
                  ${isSelected ? 'border-l-2 border-l-blue-500' : 'hover:bg-gray-50'}
                `}
              >
                <p className="text-xs text-gray-800 leading-snug line-clamp-2 font-medium">
                  <Highlight text={source.original_text} query={search} />
                </p>
                <div className="flex items-center gap-2 mt-1">
                  {source.contexts?.name && (
                    <span className="text-[10px] text-blue-600 bg-blue-50 rounded px-1.5 py-0.5 truncate max-w-[120px]">
                      {source.contexts.name}
                    </span>
                  )}
                  {cardCount > 0 && (
                    <span className="text-[10px] text-gray-400">
                      {cardCount} card{cardCount !== 1 ? 's' : ''}
                    </span>
                  )}
                  <span className="text-[10px] text-gray-300 ml-auto shrink-0">
                    {formatDate(source.created_at)}
                  </span>
                </div>
              </button>
              <button
                onClick={() => onAppendToChat?.(source.original_text)}
                title="Add to chat"
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-green-600"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                  <polyline points="9 10 4 15 9 20" />
                  <path d="M20 4v7a4 4 0 01-4 4H4" />
                </svg>
              </button>
            </div>
          )
        })}
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="px-3 py-2 border-t bg-white flex items-center justify-between shrink-0">
          <button
            onClick={() => setPage(p => p - 1)}
            disabled={page === 0}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-30 disabled:cursor-default transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="text-[10px] text-gray-400">
            {rangeStart}–{rangeEnd} of {total}
          </span>
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={page >= pageCount - 1}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-30 disabled:cursor-default transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
