import { useState, useEffect } from 'react'
import { apiFetch } from '../../apiFetch.js'

const PAGE_SIZE = 25
const KINDS = ['vocabulary', 'grammar', 'expression', 'table']
const KIND_COLORS = {
  vocabulary: 'bg-green-100 text-green-700',
  grammar: 'bg-purple-100 text-purple-700',
  expression: 'bg-orange-100 text-orange-700',
  table: 'bg-blue-100 text-blue-700',
}

export function CardsPanel({ activeProject, onSelectCard, selectedCardId, onDragStart, onClose }) {
  const [cards, setCards] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [kind, setKind] = useState(null)
  const [page, setPage] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    setSearch('')
    setDebouncedSearch('')
    setKind(null)
    setPage(0)
    setCards([])
    setTotal(0)
  }, [activeProject?.id])

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(0)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => { setPage(0) }, [kind])

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
    if (kind) params.set('kind', kind)
    apiFetch(`/api/knowledge-cards?${params}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(({ cards, total }) => { setCards(cards); setTotal(total) })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [activeProject?.id, debouncedSearch, kind, page, refreshKey])

  const pageCount = Math.ceil(total / PAGE_SIZE)
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total)

  return (
    <div className="flex flex-col h-full min-w-0">
      <div
        className="px-3 py-2 border-b bg-white flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={onDragStart}
      >
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Cards</span>
        <div className="flex items-center gap-2" onMouseDown={e => e.stopPropagation()}>
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

      <div className="px-2 py-1.5 border-b bg-white shrink-0 space-y-1.5">
        <div className="relative">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
            className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-300 pointer-events-none">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search cards…"
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
        <div className="flex gap-1 flex-wrap">
          <button
            onClick={() => setKind(null)}
            className={`text-[10px] rounded px-1.5 py-0.5 transition-colors ${kind === null ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
          >
            All
          </button>
          {KINDS.map(k => (
            <button
              key={k}
              onClick={() => setKind(prev => prev === k ? null : k)}
              className={`text-[10px] rounded px-1.5 py-0.5 transition-colors ${kind === k ? KIND_COLORS[k] + ' font-medium ring-1 ring-current ring-opacity-40' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && cards.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-8">Loading…</p>
        )}
        {error && (
          <p className="text-xs text-red-500 text-center mt-8">{error}</p>
        )}
        {!loading && !error && cards.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-8">
            {search || kind ? 'No cards match.' : 'No cards yet.'}
          </p>
        )}
        {cards.map(card => {
          const isSelected = card.id === selectedCardId
          return (
            <button
              key={card.id}
              onClick={() => onSelectCard(card)}
              className={`w-full text-left px-3 py-2.5 border-b border-gray-100 transition-colors ${
                isSelected ? 'bg-blue-50 border-l-2 border-l-blue-500' : 'hover:bg-gray-50'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs font-medium text-gray-800 leading-snug">{card.name}</span>
                <span className={`text-[10px] rounded px-1.5 py-0.5 font-medium shrink-0 ${KIND_COLORS[card.kind] ?? 'bg-gray-100 text-gray-600'}`}>
                  {card.kind}
                </span>
              </div>
              <div className="flex items-center gap-1 mt-1 flex-wrap">
                {card.tags?.slice(0, 3).map(tag => (
                  <span key={tag} className="text-[10px] bg-gray-100 text-gray-500 rounded px-1 py-0.5">{tag}</span>
                ))}
                {card.tags?.length > 3 && (
                  <span className="text-[10px] text-gray-400">+{card.tags.length - 3}</span>
                )}
                <span className="ml-auto flex items-center gap-2 shrink-0">
                  <span title="Linked sources" className="flex items-center gap-0.5 text-[10px] text-gray-400">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-2.5 h-2.5">
                      <path d="M10 13a5 5 0 007.07 0l1.93-1.93a5 5 0 00-7.07-7.07L10.5 5.5" />
                      <path d="M14 11a5 5 0 00-7.07 0l-1.93 1.93a5 5 0 007.07 7.07L13.5 18.5" />
                    </svg>
                    {card.link_count ?? 0}
                  </span>
                  {card.importance != null && (
                    <span title="Importance" className="text-[10px] text-gray-400">★ {card.importance}</span>
                  )}
                  {card.skill != null && (
                    <span className="text-[10px] text-gray-400">{card.skill}/10</span>
                  )}
                </span>
              </div>
            </button>
          )
        })}
      </div>

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
          <span className="text-[10px] text-gray-400">{rangeStart}–{rangeEnd} of {total}</span>
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
