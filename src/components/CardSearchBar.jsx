import { useState, useEffect } from 'react'
import { apiFetch } from '../apiFetch.js'

const KIND_COLORS = {
  vocabulary: 'bg-green-100 text-green-700',
  grammar: 'bg-purple-100 text-purple-700',
  expression: 'bg-orange-100 text-orange-700',
}

// Scoped, exclusion-aware card search — plan.md ("Card Groups" §2): "Every creation path opens the
// same card search bar... Build it once and reuse it." Debounced name search via
// /api/search-knowledge-cards, project-scoped, leaving out `excludeIds` (typically the card(s)
// already in the group being edited). `onSelect(card)` fires on click; the input clears itself —
// the caller owns whatever list of picked cards accumulates across repeated selections.
export function CardSearchBar({ activeProject, excludeIds = [], onSelect, placeholder = 'Search cards…', autoFocus }) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (!activeProject || !debounced) { setResults([]); return }
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams({ project_id: activeProject.id, q: debounced })
    if (excludeIds.length > 0) params.set('exclude', excludeIds.join(','))
    apiFetch(`/api/search-knowledge-cards?${params}`)
      .then(r => r.ok ? r.json() : [])
      .then(data => { if (!cancelled) setResults(data) })
      .catch(() => { if (!cancelled) setResults([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id, debounced, excludeIds.join(',')])

  function pick(card) {
    onSelect(card)
    setQuery('')
    setResults([])
  }

  return (
    <div className="relative">
      <input
        type="text"
        autoFocus={autoFocus}
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full text-xs border border-gray-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
      />
      {debounced && (
        <div className="mt-1 border border-gray-200 rounded-lg bg-white shadow-sm max-h-40 overflow-y-auto">
          {loading && <p className="text-[10px] text-gray-400 text-center py-2">Searching…</p>}
          {!loading && results.length === 0 && (
            <p className="text-[10px] text-gray-400 text-center py-2">No matching cards</p>
          )}
          {!loading && results.map(card => (
            <button
              key={card.id}
              type="button"
              onClick={() => pick(card)}
              className="w-full text-left px-2.5 py-1.5 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
            >
              <span className="text-xs text-gray-800 truncate flex-1">{card.name}</span>
              <span className={`text-[9px] rounded px-1 py-0.5 shrink-0 ${KIND_COLORS[card.kind] ?? 'bg-gray-100 text-gray-600'}`}>
                {card.kind}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
