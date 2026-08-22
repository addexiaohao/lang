import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../../apiFetch.js'
import { SkillBadge } from '../SkillBadge.jsx'
import { MultiSelectPopover } from '../MultiSelectPopover.jsx'

const PAGE_SIZE = 25
const KINDS = ['vocabulary', 'grammar', 'expression']
const KIND_COLORS = {
  vocabulary: 'bg-green-100 text-green-700',
  grammar: 'bg-purple-100 text-purple-700',
  expression: 'bg-orange-100 text-orange-700',
}

// Cards panel additions (plan.md §7) — keeps the card as the unit, so sorting is only offered on
// rollups that are well-defined for ANY card regardless of which skills it has (min/mean level,
// last practiced across its skills) — never a bare "sort by level", which isn't (a card's skills
// are heterogeneous). Per-skill-type sorting stays the Skills page's job.
const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'created', label: 'Created' },
  { value: 'importance', label: 'Importance' },
  { value: 'link_count', label: 'Links' },
  { value: 'min_level', label: 'Min level' },
  { value: 'mean_level', label: 'Mean level' },
  { value: 'last_practiced', label: 'Last practiced' },
]
const PRACTICE_STATE_OPTIONS = [
  { value: 'never_practiced', label: 'Never practiced' },
  { value: 'has_failures', label: 'Has failures' },
]

// 'all' | 'some' | 'none' — drives the card-level checkbox's checked/indeterminate state.
// `skills` is undefined while not yet fetched (see cardSkills below) — treated as 'none'.
function skillSelectionState(skills, selectedSkills) {
  if (!skills || skills.length === 0) return 'none'
  const selectedCount = skills.filter(s => selectedSkills.has(s.id)).length
  if (selectedCount === 0) return 'none'
  if (selectedCount === skills.length) return 'all'
  return 'some'
}

export function CardsPanel({ activeProject, tagCatalog, onSelectCard, selectedCardId, onDragStart, onClose, onStartPractice, refreshSignal }) {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [kind, setKind] = useState(null)
  const [tagsSelected, setTagsSelected] = useState(() => new Set())
  const [belowLevel, setBelowLevel] = useState('')
  const [practiceState, setPracticeState] = useState('')
  const [sort, setSort] = useState('name')
  const [sortDir, setSortDir] = useState('asc')
  const [page, setPage] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const scrollRef = useRef(null)

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

  const [confirmingMerge, setConfirmingMerge] = useState(false)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState(null)

  useEffect(() => {
    setSearch('')
    setDebouncedSearch('')
    setKind(null)
    setTagsSelected(new Set())
    setBelowLevel('')
    setPracticeState('')
    setSort('name')
    setSortDir('asc')
    setPage(0)
    setItems([])
    setTotal(0)
    setSelectedSkills(new Map())
    setCardSkills(new Map())
    setExpandedCards(new Set())
    setSelectAllActive(false)
    setConfirmingMerge(false)
    setMergeError(null)
  }, [activeProject?.id])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  function filterParams() {
    const params = new URLSearchParams({ project_id: activeProject.id, sort, sort_dir: sortDir })
    if (debouncedSearch) params.set('q', debouncedSearch)
    if (kind) params.set('kind', kind)
    if (tagsSelected.size > 0) params.set('tags', [...tagsSelected].join(','))
    if (belowLevel) params.set('below_level', belowLevel)
    if (practiceState) params.set('practice_state', practiceState)
    return params
  }

  // Filters changed — start over from page 0, replacing whatever was loaded.
  useEffect(() => {
    if (!activeProject) return
    setLoading(true)
    setError(null)
    const params = filterParams()
    params.set('limit', PAGE_SIZE)
    params.set('offset', 0)
    apiFetch(`/api/knowledge-cards?${params}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(({ cards, total }) => { setItems(cards); setTotal(total); setPage(0) })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id, debouncedSearch, kind, [...tagsSelected].join(','), belowLevel, practiceState, sort, sortDir, refreshKey, refreshSignal])

  const hasMore = items.length < total

  async function loadMore() {
    if (!activeProject || loading || loadingMore || !hasMore) return
    setLoadingMore(true)
    const nextPage = page + 1
    const params = filterParams()
    params.set('limit', PAGE_SIZE)
    params.set('offset', nextPage * PAGE_SIZE)
    try {
      const res = await apiFetch(`/api/knowledge-cards?${params}`)
      if (!res.ok) throw new Error(res.statusText)
      const { cards, total: newTotal } = await res.json()
      setItems(prev => [...prev, ...cards])
      setTotal(newTotal)
      setPage(nextPage)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoadingMore(false)
    }
  }

  function handleScroll(e) {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) loadMore()
  }

  // A short first page can leave the list shorter than the scroll container, so no scroll event
  // will ever fire to trigger the next page — top it up until it either fills the container or
  // runs out of results.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || loading || loadingMore || !hasMore) return
    if (el.scrollHeight <= el.clientHeight) loadMore()
  }, [items, total, loading, loadingMore, hasMore])

  const selectedCardsMap = new Map(Array.from(selectedSkills.values(), s => [s.card.id, s.card]))
  const selectedCards = Array.from(selectedCardsMap.values())
  const selectedCardCount = selectedCards.length

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
    setConfirmingMerge(false)
    setSelectedSkills(prev => {
      const next = new Map(prev)
      if (next.has(skill.id)) next.delete(skill.id)
      else next.set(skill.id, skill)
      return next
    })
  }

  async function toggleCardAll(card) {
    setSelectAllActive(false)
    setConfirmingMerge(false)
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
    setConfirmingMerge(false)
    if (selectAllActive) {
      setSelectedSkills(new Map())
      setSelectAllActive(false)
      return
    }
    setSelectAllLoading(true)
    try {
      const cardParams = filterParams()
      cardParams.set('limit', String(total))
      cardParams.set('offset', '0')
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

  // Merges the cards currently represented in the skill selection (distinct card ids across
  // selectedSkills) via /api/merge-cards — see schema.sql's merge_cards for the exact rules
  // (oldest card survives, tags union, source links combine, skills collapse by type keeping the
  // highest level). Clears selection and reloads the list on success.
  async function handleMerge() {
    if (selectedCards.length < 2 || !activeProject) return
    setMerging(true)
    setMergeError(null)
    try {
      const r = await apiFetch('/api/merge-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: activeProject.id, card_ids: selectedCards.map(c => c.id) }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.error || r.statusText)
      }
      setSelectedSkills(new Map())
      setSelectAllActive(false)
      setCardSkills(new Map())
      setExpandedCards(new Set())
      setConfirmingMerge(false)
      setRefreshKey(k => k + 1)
    } catch (e) {
      setMergeError(String(e.message || e))
    } finally {
      setMerging(false)
    }
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

        <div className="flex items-center gap-1 flex-wrap">
          <MultiSelectPopover
            label="Tags"
            options={(tagCatalog ?? []).map(t => ({ value: t.name, label: t.display_name || t.name, count: t.card_count }))}
            selected={tagsSelected}
            onToggle={value => setTagsSelected(prev => {
              const next = new Set(prev)
              if (next.has(value)) next.delete(value)
              else next.add(value)
              return next
            })}
          />
          <input
            type="number"
            min={1}
            max={10}
            value={belowLevel}
            onChange={e => setBelowLevel(e.target.value)}
            placeholder="Level ≤"
            title="Show cards with any skill at or below this level"
            className="w-14 text-[10px] bg-gray-100 text-gray-600 rounded px-1 py-0.5 border-none focus:outline-none focus:ring-1 focus:ring-blue-400 placeholder-gray-400"
          />
          {PRACTICE_STATE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setPracticeState(prev => prev === opt.value ? '' : opt.value)}
              className={`text-[10px] rounded px-1.5 py-0.5 transition-colors ${practiceState === opt.value ? 'bg-blue-100 text-blue-700 font-medium' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
            >
              {opt.label}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-1 shrink-0">
            <select
              value={sort}
              onChange={e => setSort(e.target.value)}
              className="text-[10px] bg-gray-100 text-gray-600 rounded px-1 py-0.5 border-none focus:outline-none focus:ring-1 focus:ring-blue-400"
            >
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button
              onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
              title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={`w-3 h-3 transition-transform ${sortDir === 'desc' ? 'rotate-180' : ''}`}>
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" ref={scrollRef} onScroll={handleScroll}>
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
                      <SkillBadge card={item} skills={item.skills} />
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
        {items.length > 0 && (
          <p className="text-[10px] text-gray-400 text-center py-2">
            {loadingMore
              ? 'Loading more…'
              : `${items.length} above · ${Math.max(total - items.length, 0)} left`}
          </p>
        )}
      </div>

      {selectedSkills.size > 0 && (
        <div className="border-t bg-white shrink-0">
          <div className="px-3 py-2 flex items-center gap-2">
            <span className="text-[10px] text-gray-500 shrink-0">
              {selectedSkills.size} skill{selectedSkills.size > 1 ? 's' : ''} selected ({selectedCardCount} card{selectedCardCount > 1 ? 's' : ''})
            </span>
            <div className="ml-auto flex items-center gap-2 shrink-0">
              {selectedCardCount >= 2 && (
                <button
                  onClick={() => { setMergeError(null); setConfirmingMerge(true) }}
                  className="text-[10px] font-medium bg-amber-600 text-white rounded px-2.5 py-1 hover:bg-amber-700 transition-colors"
                >
                  Merge {selectedCardCount} cards
                </button>
              )}
              <button
                onClick={handleStartPractice}
                className="text-[10px] font-medium bg-blue-600 text-white rounded px-2.5 py-1 hover:bg-blue-700 transition-colors"
              >
                Practice
              </button>
            </div>
          </div>
          {confirmingMerge && (
            <div className="px-3 pb-2 pt-1 border-t border-amber-100 bg-amber-50/50 space-y-1.5">
              <p className="text-[10px] text-gray-600">
                Merge these {selectedCardCount} cards into the oldest one? Tags are unioned, source links are combined, and for each skill type only the highest level is kept. The other cards are deleted. This cannot be undone.
              </p>
              <ul className="text-[10px] text-gray-500 list-disc pl-4 max-h-16 overflow-y-auto">
                {selectedCards.map(c => <li key={c.id}>{c.name}</li>)}
              </ul>
              {mergeError && <p className="text-[10px] text-red-500">{mergeError}</p>}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleMerge}
                  disabled={merging}
                  className="text-[10px] font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-60 rounded px-2 py-1 shrink-0 transition-colors"
                >
                  {merging ? 'Merging…' : 'Confirm merge'}
                </button>
                <button
                  onClick={() => setConfirmingMerge(false)}
                  disabled={merging}
                  className="text-[10px] text-gray-500 hover:text-gray-700 disabled:opacity-60 rounded px-2 py-1 shrink-0 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  )
}
