import { useState, useEffect } from 'react'
import { apiFetch } from '../../apiFetch.js'

const PAGE_SIZE = 25
const KINDS = ['vocabulary', 'grammar', 'expression']
const KIND_COLORS = {
  vocabulary: 'bg-green-100 text-green-700',
  grammar: 'bg-purple-100 text-purple-700',
  expression: 'bg-orange-100 text-orange-700',
}

// 'all' | 'some' | 'none' — drives the card-level checkbox's checked/indeterminate state.
// `skills` is undefined while not yet fetched (see cardSkills below) — treated as 'none'.
function skillSelectionState(skills, selectedSkills) {
  if (!skills || skills.length === 0) return 'none'
  const selectedCount = skills.filter(s => selectedSkills.has(s.id)).length
  if (selectedCount === 0) return 'none'
  if (selectedCount === skills.length) return 'all'
  return 'some'
}

export function CardsPanel({ activeProject, onSelectCard, selectedCardId, onDragStart, onClose, onStartPractice }) {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [kind, setKind] = useState(null)
  const [page, setPage] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)

  // Selection is over individual skills, not cards — Map<skill.id, skill> where skill carries its
  // own `card` (embedded by /api/skills). A card's checkbox is a shortcut that selects/deselects
  // all of that card's skills at once; expanding a card also lets you pick specific skills.
  const [selectedSkills, setSelectedSkills] = useState(() => new Map())
  // Map<card.id, skill[]> — fetched lazily (on expand, or on the card-level checkbox's first
  // click) and cached so re-expanding or re-checking a card doesn't refetch.
  const [cardSkills, setCardSkills] = useState(() => new Map())
  const [expandedCards, setExpandedCards] = useState(() => new Set())
  const [selectAllLoading, setSelectAllLoading] = useState(false)
  // Whether the "Select all" bulk action is the active selection — a plain flag rather than
  // recomputing from cardSkills each render, since the bulk action covers every filtered card
  // (possibly beyond the current page) and we don't want to refetch skills just to check that.
  // Any individual toggle clears it.
  const [selectAllActive, setSelectAllActive] = useState(false)

  useEffect(() => {
    setSearch('')
    setDebouncedSearch('')
    setKind(null)
    setPage(0)
    setItems([])
    setTotal(0)
    setSelectedSkills(new Map())
    setCardSkills(new Map())
    setExpandedCards(new Set())
    setSelectAllActive(false)
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
      .then(({ cards, total }) => { setItems(cards); setTotal(total) })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [activeProject?.id, debouncedSearch, kind, page, refreshKey])

  const pageCount = Math.ceil(total / PAGE_SIZE)
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total)
  const selectedCardCount = new Set(Array.from(selectedSkills.values(), s => s.card.id)).size

  async function loadCardSkills(cardId) {
    const params = new URLSearchParams({ project_id: activeProject.id, card_ids: cardId })
    const res = await apiFetch(`/api/skills?${params}`)
    const data = await res.json().catch(() => ({}))
    const skills = res.ok ? (data.skills ?? []) : []
    setCardSkills(prev => new Map(prev).set(cardId, skills))
    return skills
  }

  async function toggleExpand(cardId) {
    setExpandedCards(prev => {
      const next = new Set(prev)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
    if (!cardSkills.has(cardId)) await loadCardSkills(cardId)
  }

  function toggleSkill(skill) {
    setSelectAllActive(false)
    setSelectedSkills(prev => {
      const next = new Map(prev)
      if (next.has(skill.id)) next.delete(skill.id)
      else next.set(skill.id, skill)
      return next
    })
  }

  async function toggleCardAll(card) {
    setSelectAllActive(false)
    const skills = cardSkills.get(card.id) ?? await loadCardSkills(card.id)
    if (skills.length === 0) return
    setSelectedSkills(prev => {
      const next = new Map(prev)
      const allSelected = skills.every(s => prev.has(s.id))
      if (allSelected) skills.forEach(s => next.delete(s.id))
      else skills.forEach(s => next.set(s.id, s))
      return next
    })
  }

  async function handleToggleSelectAll() {
    if (selectAllActive) {
      setSelectedSkills(new Map())
      setSelectAllActive(false)
      return
    }
    setSelectAllLoading(true)
    try {
      const cardParams = new URLSearchParams({ project_id: activeProject.id, limit: String(total), offset: '0' })
      if (debouncedSearch) cardParams.set('q', debouncedSearch)
      if (kind) cardParams.set('kind', kind)
      const cardsRes = await apiFetch(`/api/knowledge-cards?${cardParams}`)
      if (!cardsRes.ok) return
      const { cards: allCards } = await cardsRes.json()
      if (allCards.length === 0) return

      const skillsParams = new URLSearchParams({ project_id: activeProject.id, card_ids: allCards.map(c => c.id).join(',') })
      const skillsRes = await apiFetch(`/api/skills?${skillsParams}`)
      if (!skillsRes.ok) return
      const { skills: allSkills } = await skillsRes.json()

      const byCard = new Map()
      for (const s of allSkills) {
        if (!byCard.has(s.card.id)) byCard.set(s.card.id, [])
        byCard.get(s.card.id).push(s)
      }
      setCardSkills(prev => {
        const next = new Map(prev)
        for (const card of allCards) next.set(card.id, byCard.get(card.id) ?? [])
        return next
      })
      setSelectedSkills(new Map(allSkills.map(s => [s.id, s])))
      setSelectAllActive(true)
    } finally {
      setSelectAllLoading(false)
    }
  }

  // Practice is generated per-skill (see lib/practiceRules.js, CLAUDE.md's "Skills" section) —
  // selectedSkills already holds the exact { id, type, card, ... } rows to practice, so this just
  // reshapes them into what onStartPractice expects, no extra fetch needed.
  function handleStartPractice() {
    if (selectedSkills.size === 0) return
    onStartPractice(Array.from(selectedSkills.values(), s => ({ card: s.card, type: s.type })))
  }

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
        <div className="flex items-center justify-between gap-1 flex-wrap">
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
          {total > 0 && (
            <button
              onClick={handleToggleSelectAll}
              disabled={selectAllLoading}
              className="text-[10px] text-blue-600 hover:text-blue-800 disabled:opacity-40 transition-colors shrink-0"
            >
              {selectAllLoading ? 'Selecting…' : selectAllActive ? 'Clear selection' : `Select all ${total}`}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && items.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-8">Loading…</p>
        )}
        {error && (
          <p className="text-xs text-red-500 text-center mt-8">{error}</p>
        )}
        {!loading && !error && items.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-8">
            {search || kind ? 'No cards match.' : 'No cards yet.'}
          </p>
        )}
        {items.map(item => {
          const skills = cardSkills.get(item.id)
          const expanded = expandedCards.has(item.id)
          const state = skillSelectionState(skills, selectedSkills)
          return (
            <div key={item.id} className="border-b border-gray-100">
              <div
                className={`flex items-stretch transition-colors ${
                  item.id === selectedCardId ? 'bg-blue-50 border-l-2 border-l-blue-500' : 'hover:bg-gray-50'
                }`}
              >
                <button
                  onClick={() => toggleExpand(item.id)}
                  aria-label={expanded ? 'Collapse skills' : 'Expand skills'}
                  className="flex items-center justify-center w-4 shrink-0 text-gray-300 hover:text-gray-500"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                    className={`w-2.5 h-2.5 transition-transform ${expanded ? 'rotate-90' : ''}`}>
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
                <label className="flex items-center pl-1 pr-1 shrink-0 cursor-pointer" title="Select all skills for this card">
                  <input
                    type="checkbox"
                    ref={el => { if (el) el.indeterminate = state === 'some' }}
                    checked={state === 'all'}
                    onChange={() => toggleCardAll(item)}
                    className="w-3 h-3"
                  />
                </label>
                <button onClick={() => onSelectCard(item)} className="flex-1 min-w-0 text-left pl-1 pr-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium text-gray-800 leading-snug">{item.name}</span>
                    <span className={`text-[10px] rounded px-1.5 py-0.5 font-medium shrink-0 ${KIND_COLORS[item.kind] ?? 'bg-gray-100 text-gray-600'}`}>
                      {item.kind}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    {item.tags?.slice(0, 3).map(tag => (
                      <span key={tag} className="text-[10px] bg-gray-100 text-gray-500 rounded px-1 py-0.5">{tag}</span>
                    ))}
                    {item.tags?.length > 3 && (
                      <span className="text-[10px] text-gray-400">+{item.tags.length - 3}</span>
                    )}
                    <span className="ml-auto flex items-center gap-2 shrink-0">
                      <span title="Linked sources" className="flex items-center gap-0.5 text-[10px] text-gray-400">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-2.5 h-2.5">
                          <path d="M10 13a5 5 0 007.07 0l1.93-1.93a5 5 0 00-7.07-7.07L10.5 5.5" />
                          <path d="M14 11a5 5 0 00-7.07 0l-1.93 1.93a5 5 0 007.07 7.07L13.5 18.5" />
                        </svg>
                        {item.link_count ?? 0}
                      </span>
                      {item.importance != null && (
                        <span title="Importance" className="text-[10px] text-gray-400">★ {item.importance}</span>
                      )}
                    </span>
                  </div>
                </button>
              </div>
              {expanded && (
                <div className="pl-9 pr-3 pb-1.5 bg-gray-50/60">
                  {skills === undefined ? (
                    <p className="text-[10px] text-gray-400 py-1">Loading skills…</p>
                  ) : skills.length === 0 ? (
                    <p className="text-[10px] text-gray-400 py-1">No skills yet.</p>
                  ) : (
                    skills.map(s => (
                      <label key={s.id} className="flex items-center gap-1.5 py-0.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedSkills.has(s.id)}
                          onChange={() => toggleSkill(s)}
                          className="w-3 h-3"
                        />
                        <span className="text-[10px] text-gray-600">{s.type}</span>
                        <span className="text-[10px] text-gray-400">
                          {s.level != null ? `· level ${s.level}` : '· not yet assessed'}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {selectedSkills.size > 0 && (
        <div className="px-3 py-2 border-t bg-white flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-gray-500 shrink-0">
            {selectedSkills.size} skill{selectedSkills.size > 1 ? 's' : ''} selected ({selectedCardCount} card{selectedCardCount > 1 ? 's' : ''})
          </span>
          <button
            onClick={handleStartPractice}
            className="text-[10px] font-medium bg-blue-600 text-white rounded px-2.5 py-1 hover:bg-blue-700 transition-colors shrink-0 ml-auto"
          >
            Practice
          </button>
        </div>
      )}

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
