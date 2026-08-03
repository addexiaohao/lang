import { useState, useEffect } from 'react'
import { apiFetch } from '../../apiFetch.js'

const CARDS_PAGE_SIZE = 20

const KIND_COLORS = {
  vocabulary: 'text-blue-600 bg-blue-50',
  grammar: 'text-purple-600 bg-purple-50',
  expression: 'text-green-600 bg-green-50',
  table: 'text-orange-600 bg-orange-50',
}

function SkillBar({ skill }) {
  if (skill == null) return null
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: 10 }, (_, i) => (
        <div
          key={i}
          className={`h-1 w-2 rounded-sm ${i < skill ? 'bg-blue-400' : 'bg-gray-200'}`}
        />
      ))}
    </div>
  )
}

export function TagsPanel({ activeProject, tagCatalog, onDragStart, onClose }) {
  const [selectedTag, setSelectedTag] = useState(null)
  const [cards, setCards] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Reset on project change
  useEffect(() => {
    setSelectedTag(null)
    setCards([])
    setTotal(0)
    setPage(0)
  }, [activeProject?.id])

  // Fetch cards when a tag is selected
  useEffect(() => {
    if (!activeProject || !selectedTag) return
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({
      project_id: activeProject.id,
      tag: selectedTag,
      limit: CARDS_PAGE_SIZE,
      offset: page * CARDS_PAGE_SIZE,
    })
    apiFetch(`/api/knowledge-cards?${params}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(({ cards, total }) => { setCards(cards); setTotal(total) })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [activeProject?.id, selectedTag, page])

  function handleTagClick(tagName) {
    setSelectedTag(tagName)
    setPage(0)
    setCards([])
    setTotal(0)
  }

  function handleBack() {
    setSelectedTag(null)
    setCards([])
    setTotal(0)
    setPage(0)
  }

  const pageCount = Math.ceil(total / CARDS_PAGE_SIZE)
  const rangeStart = total === 0 ? 0 : page * CARDS_PAGE_SIZE + 1
  const rangeEnd = Math.min((page + 1) * CARDS_PAGE_SIZE, total)

  // Tag list view
  if (!selectedTag) {
    return (
      <div className="flex flex-col h-full min-w-0">
        <div
          className="px-3 py-2 border-b bg-white shrink-0 flex items-center cursor-grab active:cursor-grabbing select-none"
          onMouseDown={onDragStart}
        >
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Tags</span>
          <span className="ml-2 text-[10px] text-gray-400">{tagCatalog.length}</span>
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
          {tagCatalog.length === 0 && (
            <p className="text-xs text-gray-400 text-center mt-8">No tags yet.</p>
          )}
          {[...tagCatalog].sort((a, b) => a.name.localeCompare(b.name)).map(tag => (
            <button
              key={tag.id}
              onClick={() => handleTagClick(tag.name)}
              className="w-full text-left px-3 py-2.5 border-b border-gray-100 hover:bg-gray-50 transition-colors group"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-gray-800 font-medium truncate">
                  {tag.name}
                  {tag.display_name && (
                    <span className="ml-1.5 text-[11px] font-normal text-gray-400">{tag.display_name}</span>
                  )}
                </span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round"
                  className="w-3 h-3 text-gray-300 group-hover:text-gray-400 shrink-0">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
              {tag.description && (
                <p className="text-[11px] text-gray-400 mt-0.5 leading-snug">{tag.description}</p>
              )}
            </button>
          ))}
        </div>
      </div>
    )
  }

  // Card list view for selected tag
  const displayName = tagCatalog.find(t => t.name === selectedTag)?.display_name || selectedTag

  return (
    <div className="flex flex-col h-full min-w-0">
      <div
        className="px-3 py-2 border-b bg-white shrink-0 flex items-center gap-2 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={onDragStart}
      >
        <button
          onClick={handleBack}
          onMouseDown={e => e.stopPropagation()}
          className="text-gray-400 hover:text-gray-600 transition-colors shrink-0"
          title="Back to tags"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="text-xs font-semibold text-gray-700 truncate flex-1">{displayName}</span>
        {!loading && (
          <span className="text-[10px] text-gray-400 shrink-0">{total} card{total !== 1 ? 's' : ''}</span>
        )}
        <button
          onClick={onClose}
          onMouseDown={e => e.stopPropagation()}
          aria-label="Close"
          className="text-gray-400 hover:text-gray-600 transition-colors shrink-0"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && cards.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-8">Loading…</p>
        )}
        {error && (
          <p className="text-xs text-red-500 text-center mt-8">{error}</p>
        )}
        {!loading && !error && cards.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-8">No cards with this tag.</p>
        )}
        {cards.map(card => (
          <div key={card.id} className="px-3 py-2.5 border-b border-gray-100">
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm text-gray-800 font-medium leading-snug">{card.name}</span>
              <span className={`text-[10px] rounded px-1.5 py-0.5 shrink-0 ${KIND_COLORS[card.kind] ?? 'text-gray-500 bg-gray-100'}`}>
                {card.kind}
              </span>
            </div>
            {card.skill != null && (
              <div className="mt-1.5">
                <SkillBar skill={card.skill} />
              </div>
            )}
            {card.tags && card.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {card.tags.filter(t => t !== selectedTag).map(t => (
                  <button
                    key={t}
                    onClick={() => handleTagClick(t)}
                    className="text-[10px] text-gray-500 bg-gray-100 hover:bg-gray-200 rounded px-1.5 py-0.5 transition-colors"
                  >
                    {tagCatalog.find(tc => tc.name === t)?.display_name || t}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {total > CARDS_PAGE_SIZE && (
        <div className="px-3 py-2 border-t bg-white flex items-center justify-between shrink-0">
          <button
            onClick={() => setPage(p => p - 1)}
            disabled={page === 0}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-30 disabled:cursor-default transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="text-[10px] text-gray-400">{rangeStart}–{rangeEnd} of {total}</span>
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={page >= pageCount - 1}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-30 disabled:cursor-default transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
