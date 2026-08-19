import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../../apiFetch.js'
import { SKILL_TYPES } from '../../../lib/skillTypes.js'
import { PRACTICE_STATES, PRACTICE_STATE_LABELS } from '../../../lib/practiceStates.js'
import { levelToColor, importanceToColor } from '../../levelColor.js'
import { MultiSelectPopover } from '../MultiSelectPopover.jsx'

// The Skills page (plan.md). One row per `skill`, not per card — see that file's "Why a separate
// page" for the rationale. Rows/filters/sort/histogram are all served by schema.sql's
// browse_skills / skill_level_histogram RPCs (via /api/skills?browse=1 / ?histogram=1) so the
// derived "practice state" (plan.md §1) never has to be recomputed client-side.
const PAGE_SIZE = 25
const KINDS = ['vocabulary', 'grammar', 'expression']
const KIND_COLORS = {
  vocabulary: 'bg-green-100 text-green-700',
  grammar: 'bg-purple-100 text-purple-700',
  expression: 'bg-orange-100 text-orange-700',
}
const ALL_SKILL_TYPES = [...new Set(Object.values(SKILL_TYPES).flat())].sort()

const SORT_OPTIONS = [
  { value: 'level', label: 'Level' },
  { value: 'last_practiced', label: 'Last practiced' },
  { value: 'attempt_count', label: 'Attempts' },
  { value: 'importance', label: 'Importance' },
  { value: 'name', label: 'Name' },
  { value: 'created', label: 'Created' },
]

// Marker colour + row-dimming per plan.md §1. never_practiced is deliberately NOT colour-coded —
// an untested skill isn't a problem, just untouched; failures should draw the eye first.
const STATE_MARKER = {
  never_practiced: 'bg-gray-300',
  failing: 'bg-red-500',
  too_hard: 'bg-amber-500',
  passing: 'bg-green-500',
}

function daysAgo(iso) {
  if (!iso) return null
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return '1d ago'
  return `${days}d ago`
}

function stateText(row) {
  switch (row.practice_state) {
    case 'never_practiced': return 'never practiced'
    case 'failing': return `failed ${row.failed_count}× · last ${daysAgo(row.last_attempt_at)}`
    case 'too_hard': return `${row.too_hard_count}× too hard`
    case 'passing': return `last practiced ${daysAgo(row.last_attempt_at)}`
    default: return ''
  }
}

// Ten-bar distribution above the list (plan.md §4). Respects every filter EXCEPT level (the
// server-side skill_level_histogram RPC already excludes it). Clicking a bar sets the level
// filter to that single value; clicking the active bar clears it.
function Histogram({ data, activeLevel, onSetLevel }) {
  const max = Math.max(1, ...data.map(d => d.count))
  const byLevel = new Map(data.map(d => [d.level, d.count]))
  return (
    <div className="flex items-end gap-1 h-16 px-2 pt-2 pb-1 border-b bg-white shrink-0">
      {Array.from({ length: 10 }, (_, i) => i + 1).map(level => {
        const count = byLevel.get(level) ?? 0
        const active = activeLevel === level
        const dim = activeLevel != null && !active
        return (
          <button
            key={level}
            onClick={() => onSetLevel(active ? null : level)}
            title={`Level ${level}: ${count}`}
            className="flex-1 flex flex-col items-center justify-end h-full min-w-0"
          >
            <span className="text-[8px] text-gray-400 leading-none mb-0.5">{count > 0 ? count : ''}</span>
            <div
              className={`w-full rounded-t transition-opacity ${active ? 'ring-2 ring-blue-400' : ''}`}
              style={{
                height: `${Math.max((count / max) * 100, count > 0 ? 8 : 2)}%`,
                backgroundColor: count > 0 ? levelToColor(level) : '#e5e7eb',
                opacity: dim ? 0.35 : 1,
              }}
            />
            <span className="text-[8px] text-gray-400 leading-none mt-0.5">{level}</span>
          </button>
        )
      })}
    </div>
  )
}

// Click to reveal a 1-10 dot editor inline (plan.md §5) — writes immediately, no confirm. A
// hollow/outlined marker means hand_set (self-assessed); solid means earned via practice (or
// never assessed, rendered as an empty dash).
function LevelMarker({ row, onSet, saving }) {
  const [editing, setEditing] = useState(false)
  const { level, hand_set: handSet } = row

  if (editing) {
    return (
      <div className="flex items-center gap-0.5 shrink-0" onClick={e => e.stopPropagation()}>
        {Array.from({ length: 10 }, (_, i) => {
          const v = i + 1
          const filled = level != null && v <= level
          return (
            <button
              key={v}
              onClick={() => { onSet(v); setEditing(false) }}
              disabled={saving}
              title={`Set level to ${v}${v === 10 ? ' (retired — never auto-selected)' : ''}`}
              className={`w-2 h-2 rounded-sm transition-colors disabled:cursor-wait ${filled ? 'bg-blue-500' : 'bg-gray-200 hover:bg-blue-300'}`}
            />
          )
        })}
        <button onClick={() => setEditing(false)} className="text-[9px] text-gray-400 hover:text-gray-600 ml-1">done</button>
      </div>
    )
  }

  const color = level != null ? levelToColor(level) : null
  return (
    <button
      onClick={e => { e.stopPropagation(); setEditing(true) }}
      disabled={saving}
      title={level == null ? 'Never assessed — click to set' : handSet ? 'Hand-set — click to change' : 'Earned — click to change'}
      className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 disabled:opacity-50 transition-colors"
      style={
        level == null
          ? { backgroundColor: '#f3f4f6', color: '#d1d5db', border: '1px dashed #d1d5db' }
          : handSet
          ? { backgroundColor: 'transparent', color, border: `2px dashed ${color}` }
          : { backgroundColor: color, color: 'white' }
      }
    >
      {level ?? '–'}
    </button>
  )
}

// Small numbered badge showing the parent card's importance (0-10) — background tinted by
// importanceToColor's amber ramp (levelColor.js), text flipped to white past the midpoint so it
// stays legible against the darker end of the ramp. Renders nothing when the card has no
// importance set, same "no row, no claim" convention as an unassessed skill. importance === 0 is
// a distinct "marked unimportant" state — rendered darker-than-gray rather than on the amber ramp
// so it never reads as merely "low importance".
function ImportanceBadge({ importance }) {
  if (importance == null) return null
  if (importance === 0) {
    return (
      <span
        title="Marked unimportant"
        className="inline-flex items-center justify-center min-w-[14px] h-3.5 px-0.5 rounded text-[9px] font-semibold shrink-0 bg-gray-400 text-white line-through"
      >
        0
      </span>
    )
  }
  return (
    <span
      title={`Importance ${importance}/10`}
      className="inline-flex items-center justify-center min-w-[14px] h-3.5 px-0.5 rounded text-[9px] font-semibold shrink-0"
      style={{ backgroundColor: importanceToColor(importance), color: importance > 5 ? 'white' : '#78350f' }}
    >
      {importance}
    </span>
  )
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Row expansion (plan.md §6) — fetched lazily on first expand, cached per skill. `attempt` is
// null while loading, `false` once loaded-but-none-found, or the practice_attempt row.
function ExpandedRow({ attempt }) {
  const [showPrompt, setShowPrompt] = useState(false)
  if (attempt === undefined) return <p className="text-[10px] text-gray-400 py-2 px-3">Loading…</p>
  if (!attempt) return <p className="text-[10px] text-gray-400 py-2 px-3">No attempts yet.</p>

  const response = attempt.conversation?.response
  return (
    <div className="px-3 py-2 space-y-2 bg-gray-50/60 border-t border-gray-100">
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-medium rounded px-1.5 py-0.5 ${
          attempt.outcome === 'correct' ? 'bg-green-100 text-green-700'
          : attempt.outcome === 'too_hard' ? 'bg-amber-100 text-amber-700'
          : 'bg-red-100 text-red-700'
        }`}>
          {attempt.outcome}
        </span>
        <span className="text-[10px] text-gray-400">{formatDate(attempt.created_at)}</span>
        {attempt.model && <span className="text-[10px] text-gray-300">· {attempt.model}</span>}
      </div>
      {response && (
        <pre className="text-[10px] text-gray-700 bg-white border border-gray-200 rounded p-2 overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(response, null, 2)}
        </pre>
      )}
      <button
        onClick={() => setShowPrompt(v => !v)}
        className="text-[10px] text-blue-600 hover:text-blue-800 transition-colors"
      >
        {showPrompt ? 'Hide prompt' : 'Show prompt'}
      </button>
      {showPrompt && (
        <pre className="text-[9px] text-gray-500 bg-white border border-gray-200 rounded p-2 overflow-x-auto max-h-64 whitespace-pre-wrap">
          {JSON.stringify(attempt.conversation?.request ?? null, null, 2)}
        </pre>
      )}
    </div>
  )
}

export function SkillsPanel({ activeProject, tagCatalog, onSelectCard, onDragStart, onClose }) {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const scrollRef = useRef(null)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [kind, setKind] = useState(null)
  const [skillType, setSkillType] = useState('')
  const [states, setStates] = useState(() => new Set())
  const [tagsSelected, setTagsSelected] = useState(() => new Set())
  const [levelFilter, setLevelFilter] = useState(null)
  const [sort, setSort] = useState('level')
  const [sortDir, setSortDir] = useState('asc')

  const [histogram, setHistogram] = useState([])
  const [expandedId, setExpandedId] = useState(null)
  const [attemptCache, setAttemptCache] = useState(() => new Map())
  const [savingId, setSavingId] = useState(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  function filterParams() {
    const params = new URLSearchParams({ project_id: activeProject.id })
    if (debouncedSearch) params.set('q', debouncedSearch)
    if (kind) params.set('kind', kind)
    if (skillType) params.set('skill_type', skillType)
    if (states.size > 0) params.set('state', [...states].join(','))
    if (tagsSelected.size > 0) params.set('tags', [...tagsSelected].join(','))
    return params
  }

  // Filters/sort changed — start over from the top.
  useEffect(() => {
    if (!activeProject) return
    setLoading(true)
    setError(null)
    const params = filterParams()
    if (levelFilter != null) { params.set('level_min', levelFilter); params.set('level_max', levelFilter) }
    params.set('sort', sort)
    params.set('sort_dir', sortDir)
    params.set('limit', PAGE_SIZE)
    params.set('offset', 0)
    params.set('browse', '1')
    apiFetch(`/api/skills?${params}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(({ skills, total }) => { setItems(skills); setTotal(total) })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id, debouncedSearch, kind, skillType, [...states].join(','), [...tagsSelected].join(','), levelFilter, sort, sortDir, refreshKey])

  // Histogram — same filters minus level (plan.md §4).
  useEffect(() => {
    if (!activeProject) return
    const params = filterParams()
    params.set('histogram', '1')
    apiFetch(`/api/skills?${params}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(({ histogram }) => setHistogram(histogram))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id, debouncedSearch, kind, skillType, [...states].join(','), [...tagsSelected].join(','), refreshKey])

  const hasMore = items.length < total

  async function loadMore() {
    if (!activeProject || loading || loadingMore || !hasMore) return
    setLoadingMore(true)
    const params = filterParams()
    if (levelFilter != null) { params.set('level_min', levelFilter); params.set('level_max', levelFilter) }
    params.set('sort', sort)
    params.set('sort_dir', sortDir)
    params.set('limit', PAGE_SIZE)
    params.set('offset', items.length)
    params.set('browse', '1')
    try {
      const res = await apiFetch(`/api/skills?${params}`)
      if (!res.ok) throw new Error(res.statusText)
      const { skills, total: newTotal } = await res.json()
      setItems(prev => [...prev, ...skills])
      setTotal(newTotal)
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

  useEffect(() => {
    const el = scrollRef.current
    if (!el || loading || loadingMore || !hasMore) return
    if (el.scrollHeight <= el.clientHeight) loadMore()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, total, loading, loadingMore, hasMore])

  function toggleState(value) {
    setStates(prev => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  function toggleTag(value) {
    setTagsSelected(prev => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  async function toggleExpand(row) {
    const id = row.id
    setExpandedId(prev => prev === id ? null : id)
    if (expandedId === id || attemptCache.has(id)) return
    const params = new URLSearchParams({ project_id: activeProject.id, last_attempt_for: id })
    const res = await apiFetch(`/api/skills?${params}`)
    const data = res.ok ? await res.json().catch(() => null) : null
    setAttemptCache(prev => new Map(prev).set(id, data))
  }

  async function setLevel(row, value) {
    setSavingId(row.id)
    try {
      const res = await apiFetch(`/api/knowledge-cards?${new URLSearchParams({ project_id: activeProject.id, id: row.card.id })}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill_type: row.type, level: value }),
      })
      if (!res.ok) throw new Error(res.statusText)
      const updated = await res.json()
      setItems(prev => prev.map(r => r.id === row.id ? { ...r, level: updated.level, hand_set: updated.hand_set } : r))
      setHistogram(prev => {
        const next = prev.map(d => ({ ...d }))
        const old = next.find(d => d.level === row.level)
        if (old) old.count = Math.max(0, old.count - 1)
        let fresh = next.find(d => d.level === value)
        if (!fresh) { fresh = { level: value, count: 0 }; next.push(fresh) }
        fresh.count += 1
        return next.sort((a, b) => a.level - b.level)
      })
    } catch (e) {
      setError(String(e))
    } finally {
      setSavingId(null)
    }
  }

  const activeFilterChips = [
    skillType && { key: 'type', label: `Skill: ${skillType}`, clear: () => setSkillType('') },
    levelFilter != null && { key: 'level', label: `Level: ${levelFilter}`, clear: () => setLevelFilter(null) },
    ...[...states].map(s => ({ key: `state-${s}`, label: PRACTICE_STATE_LABELS[s], clear: () => toggleState(s) })),
    ...[...tagsSelected].map(t => ({ key: `tag-${t}`, label: `#${t}`, clear: () => toggleTag(t) })),
  ].filter(Boolean)

  const tagOptions = (tagCatalog ?? []).map(t => ({ value: t.name, label: t.display_name || t.name, count: t.card_count }))
  const stateOptions = PRACTICE_STATES.map(s => ({ value: s, label: PRACTICE_STATE_LABELS[s] }))

  return (
    <div className="flex flex-col h-full min-w-0">
      <div
        className="px-3 py-2 border-b bg-white flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={onDragStart}
      >
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Skills</span>
        <div className="flex items-center gap-2" onMouseDown={e => e.stopPropagation()}>
          <button onClick={() => setRefreshKey(k => k + 1)} title="Refresh" className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
          {onClose && (
            <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600 transition-colors shrink-0">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <Histogram data={histogram} activeLevel={levelFilter} onSetLevel={setLevelFilter} />

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
            <button onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 flex-wrap">
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
          <select
            value={skillType}
            onChange={e => setSkillType(e.target.value)}
            className="text-[10px] bg-gray-100 text-gray-600 rounded px-1 py-0.5 border-none focus:outline-none focus:ring-1 focus:ring-blue-400"
          >
            <option value="">Any skill</option>
            {ALL_SKILL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <MultiSelectPopover label="State" options={stateOptions} selected={states} onToggle={toggleState} />
          <MultiSelectPopover label="Tags" options={tagOptions} selected={tagsSelected} onToggle={toggleTag} />

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

        {activeFilterChips.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {activeFilterChips.map(chip => (
              <button
                key={chip.key}
                onClick={chip.clear}
                className="inline-flex items-center gap-1 text-[10px] bg-blue-50 text-blue-700 rounded-full px-2 py-0.5 hover:bg-blue-100 transition-colors"
              >
                {chip.label}
                <span className="text-blue-400">×</span>
              </button>
            ))}
          </div>
        )}

        {total > 0 && (
          <p className="text-[10px] text-gray-400">{total} skill{total !== 1 ? 's' : ''}</p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto" ref={scrollRef} onScroll={handleScroll}>
        {loading && items.length === 0 && <p className="text-xs text-gray-400 text-center mt-8">Loading…</p>}
        {error && <p className="text-xs text-red-500 text-center mt-8">{error}</p>}
        {!loading && !error && items.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-8">No skills match.</p>
        )}
        {items.map(row => {
          const expanded = expandedId === row.id
          const dimmed = row.practice_state === 'never_practiced'
          return (
            <div key={row.id} className="border-b border-gray-100">
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggleExpand(row)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(row) } }}
                className={`w-full flex items-center gap-2 pl-2 pr-3 py-2 text-left hover:bg-gray-50 transition-colors cursor-pointer ${dimmed ? 'opacity-60' : ''}`}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${STATE_MARKER[row.practice_state]}`} title={row.practice_state} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <ImportanceBadge importance={row.card.importance} />
                    <button
                      onClick={e => { e.stopPropagation(); onSelectCard?.(row.card) }}
                      className="text-xs font-medium text-gray-800 hover:text-blue-600 truncate transition-colors"
                    >
                      {row.card.name}
                    </button>
                    <span className={`text-[9px] rounded px-1 py-0.5 font-medium shrink-0 ${KIND_COLORS[row.card.kind] ?? 'bg-gray-100 text-gray-600'}`}>
                      {row.card.kind}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[10px] text-gray-500 truncate">{row.type}</span>
                    <span className="text-[10px] text-gray-300">·</span>
                    <span className="text-[10px] text-gray-400 truncate">{stateText(row)}</span>
                  </div>
                </div>
                {row.level === 10 && <span className="text-[9px] text-gray-400 shrink-0" title="Retired — never auto-selected by practice">retired</span>}
                <LevelMarker row={row} onSet={v => setLevel(row, v)} saving={savingId === row.id} />
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                  className={`w-2.5 h-2.5 text-gray-300 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}>
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
              {expanded && <ExpandedRow attempt={attemptCache.get(row.id)} />}
            </div>
          )
        })}
        {loadingMore && <p className="text-[10px] text-gray-400 text-center py-2">Loading more…</p>}
      </div>
    </div>
  )
}
