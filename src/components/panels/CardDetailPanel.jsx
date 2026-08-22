import { useState, useEffect } from 'react'
import { apiFetch } from '../../apiFetch.js'
import { speak } from '../../tts.js'
import { SKILL_TYPES, axisValueKey, axisValueGloss, axisValueExample, isSenseAxis, hasSenseAxis } from '../../../lib/skillTypes.js'
import AddSenseForm from '../AddSenseForm.jsx'

function HighlightedText({ text, positions = [] }) {
  if (!positions.length) return <>{text}</>
  const sorted = [...positions].sort((a, b) => a.start - b.start)
  const parts = []
  let cursor = 0
  for (const { start, end } of sorted) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), highlight: false })
    parts.push({ text: text.slice(start, end), highlight: true })
    cursor = end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlight: false })
  return (
    <>
      {parts.map((part, i) =>
        part.highlight
          ? <mark key={i} className="bg-yellow-200 text-yellow-900 rounded-sm">{part.text}</mark>
          : <span key={i}>{part.text}</span>
      )}
    </>
  )
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

// Coarse-to-fine relative time for the practice history list below — attempts within the same
// session read as minutes/hours ago, older ones fall back to formatDate's absolute form via the
// day/month/year rungs, same granularity SkillsPanel.jsx's daysAgo uses for the Skills page.
function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

const OUTCOME_STYLE = {
  correct: { label: 'Correct', className: 'bg-green-100 text-green-700' },
  incorrect: { label: 'Incorrect', className: 'bg-red-100 text-red-700' },
  too_hard: { label: 'Too hard', className: 'bg-amber-100 text-amber-700' },
}

// One row per practice_attempt, most recent first (the order /api/skills?history_for= already
// returns). The sentence actually used is collapsed by default — a click reveals it, same
// disclosure pattern SkillsPanel.jsx's "Show prompt" toggle uses for the raw request.
function PracticeHistoryRow({ attempt }) {
  const [expanded, setExpanded] = useState(false)
  const sentence = attempt.conversation?.response?.sentence ?? null
  const style = OUTCOME_STYLE[attempt.outcome] ?? { label: attempt.outcome, className: 'bg-gray-100 text-gray-600' }
  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5">
        <span className={`text-[10px] font-medium rounded px-1.5 py-0.5 shrink-0 ${style.className}`}>{style.label}</span>
        <span className="text-[10px] text-gray-400 shrink-0" title={formatDate(attempt.created_at)}>{timeAgo(attempt.created_at)}</span>
        {sentence && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="text-[10px] text-blue-500 hover:text-blue-700 font-medium ml-auto shrink-0"
          >
            {expanded ? 'Hide sentence' : 'Show sentence'}
          </button>
        )}
      </div>
      {expanded && sentence && (
        <p className="text-[11px] text-gray-600 italic mt-1">{sentence}</p>
      )}
    </div>
  )
}

// Fetches a skill's practice history (most recent first, via /api/skills?history_for=) whenever
// `skillId` changes OR `refreshToken` changes identity — the latter is the card's own `detail`
// object, which gets a fresh reference every time PracticePanel force-refetches it right after
// recording a practice result, so a just-answered attempt shows up here without a manual refresh
// even when it didn't move the skill's level (e.g. the first correct answer after a failure, which
// deliberately leaves level unchanged — see lib/practiceScheduling.js's nextLevel).
function PracticeHistory({ activeProject, skillId, refreshToken }) {
  const [attempts, setAttempts] = useState(undefined)

  useEffect(() => {
    if (!skillId || !activeProject) { setAttempts(undefined); return }
    let cancelled = false
    setAttempts(undefined)
    apiFetch(`/api/skills?${new URLSearchParams({ project_id: activeProject.id, history_for: skillId })}`)
      .then(r => r.ok ? r.json() : [])
      .then(data => { if (!cancelled) setAttempts(data) })
      .catch(() => { if (!cancelled) setAttempts([]) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id, skillId, refreshToken])

  if (attempts === undefined) return <p className="text-[10px] text-gray-400">Loading…</p>
  if (attempts.length === 0) return <p className="text-[10px] text-gray-400">No practice yet.</p>
  return (
    <div className="space-y-2 divide-y divide-gray-100">
      {attempts.map(attempt => (
        <div key={attempt.id} className="pt-2 first:pt-0">
          <PracticeHistoryRow attempt={attempt} />
        </div>
      ))}
    </div>
  )
}

const KIND_COLORS = {
  vocabulary: 'bg-green-100 text-green-700',
  grammar: 'bg-purple-100 text-purple-700',
  expression: 'bg-orange-100 text-orange-700',
}

// Cartesian product of { axis, values }[] -> array of partial { [axisName]: key } combos. `values`
// entries may be plain strings (ordinary paradigm axes) or { key, gloss, example } objects (a sense
// axis, see lib/skillTypes.js) — axisValueKey normalizes either shape to the string a type is built
// from, so typeForCombo below never needs to know which shape it's looking at.
function cartesian(axisList) {
  return axisList.reduce((acc, { axis, values }) => {
    const next = []
    for (const combo of acc) for (const v of values ?? []) next.push({ ...combo, [axis]: axisValueKey(v) })
    return next
  }, [{}])
}

// A paradigm cell's skill `type` is positional (not sorted, unlike the old table_cells cell_key):
// one segment per axis, in the card's own axes order. See lib/skillTypes.js's validateSkillType.
function typeForCombo(axes, combo) {
  return axes.map(a => combo[a.name]).join('.')
}

function skillColor(level) {
  if (level == null) return 'bg-gray-50 text-gray-300 border-gray-100'
  if (level <= 3) return 'bg-red-50 text-red-700 border-red-200'
  if (level <= 6) return 'bg-amber-50 text-amber-700 border-amber-200'
  return 'bg-green-50 text-green-700 border-green-200'
}

// One dot-row per value (level or importance) — shared shape for flat types and paradigm cells.
// `value == null` (not yet assessed, or never encountered) renders all dots empty (light gray).
// `value === 0` is a distinct, deliberate "marked unimportant" state (importance only — level
// has no zero) — dots render darker than the empty-gray used for "not set", so the two states
// never look the same at a glance. `zeroable` (importance rows) additionally renders the label
// as a button that toggles the whole row to/from 0.
const DOT_COLORS = {
  blue: { filled: 'bg-blue-500', empty: 'hover:bg-blue-200' },
  amber: { filled: 'bg-amber-500', empty: 'hover:bg-amber-200' },
}
function Dots({ value, onSet, disabled, color, emptyLabel, label, zeroable }) {
  const c = DOT_COLORS[color]
  const isZero = value === 0
  return (
    <div className="flex items-center gap-2">
      {label && (
        zeroable ? (
          <button
            type="button"
            onClick={() => onSet(isZero ? null : 0)}
            disabled={disabled}
            title={isZero ? 'Unset — click to clear' : 'Mark unimportant'}
            className={`text-[9px] w-14 shrink-0 text-left transition-colors disabled:cursor-wait ${isZero ? 'line-through text-gray-500' : 'text-gray-400 hover:text-amber-600'}`}
          >
            {label}
          </button>
        ) : (
          <span className="text-[9px] text-gray-400 w-14 shrink-0">{label}</span>
        )
      )}
      <div className="flex items-center gap-1.5">
        <div className="flex gap-0.5">
          {Array.from({ length: 10 }, (_, i) => {
            const dotValue = i + 1
            const filled = value != null && value > 0 && dotValue <= value
            return (
              <button
                key={dotValue}
                onClick={() => onSet(dotValue)}
                disabled={disabled}
                title={`Set to ${dotValue}`}
                className={`w-2 h-2 rounded-sm transition-colors disabled:cursor-wait ${filled ? c.filled : isZero ? 'bg-gray-400 hover:bg-gray-500' : `bg-gray-200 ${c.empty}`}`}
              />
            )
          })}
        </div>
        <span className="text-[10px] text-gray-500 w-24 shrink-0">
          {isZero ? 'unimportant' : value != null ? `${value}/10` : emptyLabel}
        </span>
      </div>
    </div>
  )
}

// Small "+1"/"-1" badge shown next to a skill's Level dots right after a practice attempt changes
// it — green for a level that went up, red for one that went down. `delta` is a signed integer;
// `null`/`0` renders nothing (a correct answer at the level ceiling, e.g., moves nothing).
function LevelDelta({ delta }) {
  if (!delta) return null
  const positive = delta > 0
  return (
    <span className={`text-[10px] font-semibold rounded px-1 ${positive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
      {positive ? `+${delta}` : delta}
    </span>
  )
}

function FlatSkillList({ kind, skillRows, onSetLevel, onSetImportance, savingType, highlightType, levelChange }) {
  const byType = new Map(skillRows.map(s => [s.type, s]))
  const order = SKILL_TYPES[kind] ?? []
  // Existing rows first (in registry order), then any row of a type not in the registry (shouldn't
  // normally happen, but don't silently drop it).
  const types = [...order.filter(t => byType.has(t)), ...skillRows.map(s => s.type).filter(t => !order.includes(t))]

  if (types.length === 0) return <p className="text-xs text-gray-400">No skills tracked yet.</p>

  return (
    <div className="space-y-2">
      {types.map(type => {
        const row = byType.get(type)
        const disabled = savingType === type
        const highlighted = type === highlightType
        return (
          <div
            key={type}
            ref={el => { if (highlighted && el) el.scrollIntoView({ block: 'nearest' }) }}
            className={`border rounded-lg p-2 transition-colors ${highlighted ? 'border-blue-300 ring-2 ring-blue-400 bg-blue-50/50' : 'border-gray-100'}`}
          >
            <p className="text-[10px] text-gray-500 mb-1 truncate" title={type}>{type}</p>
            <div className="flex items-center gap-2">
              <Dots value={row?.level ?? null} disabled={disabled} color="blue" label="Level" emptyLabel="not yet assessed" onSet={value => onSetLevel(type, value)} />
              {type === levelChange?.type && <LevelDelta delta={levelChange.delta} />}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <Dots value={row?.importance ?? null} disabled={disabled} color="amber" label="Importance" zeroable emptyLabel="not set" onSet={value => onSetImportance(type, value)} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ParadigmSkillGrid({ axes, skillRows, onSetLevel, onSetImportance, savingType, highlightType, levelChange }) {
  const [selectedType, setSelectedType] = useState(highlightType ?? null)
  useEffect(() => { if (highlightType) setSelectedType(highlightType) }, [highlightType])
  const byType = new Map(skillRows.map(s => [s.type, s]))

  const rowAxis = axes[0]
  const colAxis = axes[1]
  const extraAxes = axes.slice(2)
  const extraCombos = extraAxes.length > 0 ? cartesian(extraAxes) : [{}]
  const selected = selectedType ? byType.get(selectedType) : null

  return (
    <div className="space-y-4">
      {extraCombos.map((extra, ei) => (
        <div key={ei}>
          {extraAxes.length > 0 && (
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
              {extraAxes.map(a => extra[a.name]).join(' · ')}
            </p>
          )}
          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="text-xs w-full border-collapse">
              {colAxis && (
                <thead>
                  <tr>
                    <th className="p-1.5 bg-gray-50 border-b border-r border-gray-200 text-left font-medium text-gray-400">{rowAxis.name} \ {colAxis.name}</th>
                    {(colAxis.values ?? []).map(cv => (
                      <th key={axisValueKey(cv)} className="p-1.5 bg-gray-50 border-b border-gray-200 font-medium text-gray-500">{axisValueKey(cv)}</th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {(rowAxis.values ?? []).map(rv => {
                  const rvKey = axisValueKey(rv)
                  const rvGloss = axisValueGloss(rv)
                  return (
                    <tr key={rvKey}>
                      <td className="p-1.5 bg-gray-50 border-r border-b border-gray-200 font-medium text-gray-500 whitespace-nowrap" title={rvGloss ?? undefined}>{rvKey}</td>
                      {colAxis ? (colAxis.values ?? []).map(cv => {
                        const cvKey = axisValueKey(cv)
                        const combo = { ...extra, [rowAxis.name]: rvKey, [colAxis.name]: cvKey }
                        const type = typeForCombo(axes, combo)
                        const cell = byType.get(type)
                        return (
                          <td key={cvKey} className="border-b border-gray-100 p-0.5">
                            <button
                              onClick={() => setSelectedType(type)}
                              className={`w-full h-full min-h-[2rem] rounded border px-1.5 py-1 transition-colors ${skillColor(cell?.level)} ${
                                selectedType === type ? 'ring-2 ring-blue-400' : 'hover:brightness-95'
                              }`}
                            >
                              {cell ? (cell.level ?? '·') : ''}
                            </button>
                          </td>
                        )
                      }) : (
                        <td className="border-b border-gray-100 p-0.5">
                          {(() => {
                            const combo = { ...extra, [rowAxis.name]: rvKey }
                            const type = typeForCombo(axes, combo)
                            const cell = byType.get(type)
                            return (
                              <button
                                onClick={() => setSelectedType(type)}
                                className={`w-full h-full min-h-[2rem] rounded border px-1.5 py-1 transition-colors ${skillColor(cell?.level)} ${
                                  selectedType === type ? 'ring-2 ring-blue-400' : 'hover:brightness-95'
                                }`}
                              >
                                {cell ? (cell.level ?? '·') : ''}
                              </button>
                            )
                          })()}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {selectedType && (
        <div className="border-t pt-3 space-y-1.5">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
            Cell — {selectedType}{!selected && ' (never encountered)'}
          </p>
          <div className="flex items-center gap-2">
            <Dots
              value={selected?.level ?? null}
              disabled={savingType === selectedType}
              color="blue"
              label="Level"
              emptyLabel="not yet assessed"
              onSet={value => onSetLevel(selectedType, value)}
            />
            {selectedType === levelChange?.type && <LevelDelta delta={levelChange.delta} />}
          </div>
          <div className="flex items-center gap-2">
            <Dots
              value={selected?.importance ?? null}
              disabled={savingType === selectedType}
              color="amber"
              label="Importance"
              zeroable
              emptyLabel="not set"
              onSet={value => onSetImportance(selectedType, value)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// A sense axis (lib/skillTypes.js) is one-dimensional and semantically nothing like a declension
// grid — ParadigmSkillGrid's row×column table (built for genuinely multi-axis paradigms) hid the
// gloss behind a click and rendered a mystery second column for it. Every sense gets its own row
// here instead: key, gloss, example, and Level/Importance dots all visible without selecting a cell
// first — there's no grid structure to justify hiding them.
function SenseSkillList({ axes, skillRows, onSetLevel, onSetImportance, onRefineGloss, savingType, highlightType, levelChange }) {
  const senseAxis = axes[0]
  const byType = new Map(skillRows.map(s => [s.type, s]))
  const [editingKey, setEditingKey] = useState(null)
  const [glossDraft, setGlossDraft] = useState('')

  return (
    <div className="space-y-2">
      {(senseAxis.values ?? []).map(v => {
        const key = axisValueKey(v)
        const gloss = axisValueGloss(v)
        const example = axisValueExample(v)
        const skill = byType.get(key)
        const isEditing = editingKey === key
        return (
          <div key={key} className={`rounded-md border px-2 py-1.5 space-y-1.5 ${key === highlightType ? 'border-blue-300 bg-blue-50' : 'border-gray-200 bg-white'}`}>
            <div>
              <span className="text-xs font-semibold text-gray-700">{key}</span>
              {isEditing ? (
                <div className="flex items-start gap-1.5 mt-1">
                  <textarea
                    autoFocus
                    rows={2}
                    className="flex-1 text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
                    value={glossDraft}
                    onChange={e => setGlossDraft(e.target.value)}
                  />
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => { onRefineGloss(key, glossDraft); setEditingKey(null) }}
                      disabled={!glossDraft.trim()}
                      className="text-[10px] px-2 py-0.5 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40"
                    >
                      Save
                    </button>
                    <button type="button" onClick={() => setEditingKey(null)} className="text-[10px] px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <p className="text-xs text-gray-600 italic flex-1">{gloss || '(no gloss yet)'}</p>
                  {onRefineGloss && (
                    <button
                      type="button"
                      onClick={() => { setGlossDraft(gloss ?? ''); setEditingKey(key) }}
                      className="shrink-0 text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                    >
                      Edit
                    </button>
                  )}
                </div>
              )}
              {example && <p className="text-xs text-gray-400 mt-0.5">e.g. "{example}"</p>}
            </div>
            <div className="flex items-center gap-2">
              <Dots
                value={skill?.level ?? null}
                disabled={savingType === key}
                color="blue"
                label="Level"
                emptyLabel="not yet assessed"
                onSet={value => onSetLevel(key, value)}
              />
              {key === levelChange?.type && <LevelDelta delta={levelChange.delta} />}
            </div>
            <div className="flex items-center gap-2">
              <Dots
                value={skill?.importance ?? null}
                disabled={savingType === key}
                color="amber"
                label="Importance"
                zeroable
                emptyLabel="not set"
                onSet={value => onSetImportance(key, value)}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// `prefetchedDetail`, when given and matching `card.id`, is used in place of the panel's own
// fetch — lets a caller (Practice's docked card panel) kick the request off earlier than mount,
// so the panel renders with no loading flicker once shown. `levelChange` ({ type, delta } | null,
// also Practice-only) renders a +N/-N badge next to that one skill's Level dots, right after a
// practice attempt just moved it. `seedInfo` ({ offered, used } | null, also Practice-only) is the
// "other vocabulary already known" pool offered to the model for the current item vs. what it
// reports actually weaving in (lib/prompts/registry.js's seedSection, api/practice.js) — rendered
// as a "Suggested vocabulary" section alongside the skill tested.
export function CardDetailPanel({ card, activeProject, onClose, onDeleted, onRenamed, onAppendToChat, onDragStart, onSelectTag, onSelectSource, highlightSkillType, prefetchedDetail, levelChange, seedInfo, tagCatalog = [], onNewTags }) {
  const [detail, setDetail] = useState(prefetchedDetail?.id === card?.id ? prefetchedDetail : null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [savingImportance, setSavingImportance] = useState(false)
  const [savingSkillType, setSavingSkillType] = useState(null)
  const [showAddSense, setShowAddSense] = useState(false)
  const [editingSenseFor, setEditingSenseFor] = useState(null)
  const [senseDraft, setSenseDraft] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [nameError, setNameError] = useState(null)
  const [savingTags, setSavingTags] = useState(false)
  const [showTagPicker, setShowTagPicker] = useState(false)
  const [tagSearch, setTagSearch] = useState('')

  useEffect(() => {
    setConfirmingDelete(false)
    setEditingName(false)
    setNameError(null)
    setShowTagPicker(false)
    setTagSearch('')
    setShowAddSense(false)
  }, [card?.id])

  useEffect(() => {
    if (!card || !activeProject) return
    if (prefetchedDetail?.id === card.id) {
      setDetail(prefetchedDetail)
      setLoading(false)
      setError(null)
      return
    }
    setDetail(null)
    setLoading(true)
    setError(null)
    apiFetch(`/api/knowledge-cards?project_id=${activeProject.id}&id=${card.id}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(setDetail)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [card?.id, activeProject?.id, prefetchedDetail])

  const importance = detail?.importance ?? card?.importance ?? null

  async function updateImportance(value) {
    if (!card || !activeProject || value === importance) return
    setSavingImportance(true)
    try {
      const r = await apiFetch(`/api/knowledge-cards?project_id=${activeProject.id}&id=${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ importance: value }),
      })
      if (!r.ok) throw new Error(r.statusText)
      const updated = await r.json()
      setDetail(prev => prev ? { ...prev, importance: updated.importance } : prev)
    } catch (e) {
      setError(String(e))
    } finally {
      setSavingImportance(false)
    }
  }

  const tags = detail?.tags ?? card?.tags ?? []

  async function updateTags(newTags) {
    if (!card || !activeProject) return
    setSavingTags(true)
    try {
      const r = await apiFetch(`/api/knowledge-cards?project_id=${activeProject.id}&id=${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: newTags }),
      })
      if (!r.ok) throw new Error(r.statusText)
      const updated = await r.json()
      setDetail(prev => prev ? { ...prev, tags: updated.tags } : prev)
    } catch (e) {
      setError(String(e))
    } finally {
      setSavingTags(false)
    }
  }

  function removeTag(tag) {
    updateTags(tags.filter(t => t !== tag))
  }

  function addTag(tag) {
    setShowTagPicker(false)
    setTagSearch('')
    if (tags.includes(tag)) return
    updateTags([...tags, tag])
  }

  async function addNewTag(name) {
    const trimmed = name.trim()
    setShowTagPicker(false)
    setTagSearch('')
    if (!trimmed || !activeProject || tags.includes(trimmed)) return
    setSavingTags(true)
    try {
      const r = await apiFetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: activeProject.id, name: trimmed }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.error || r.statusText)
      }
      onNewTags?.()
      await updateTags([...tags, trimmed])
    } catch (e) {
      setError(String(e.message || e))
      setSavingTags(false)
    }
  }

  const tagPickerOptions = tagCatalog
    .filter(t => !tags.includes(t.name))
    .filter(t => {
      const q = tagSearch.trim().toLowerCase()
      if (!q) return true
      return t.name.toLowerCase().includes(q) || (t.display_name ?? '').toLowerCase().includes(q)
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  const trimmedTagQuery = tagSearch.trim()
  const canAddNewTag = trimmedTagQuery.length > 0
    && !tags.some(t => t.toLowerCase() === trimmedTagQuery.toLowerCase())
    && !tagCatalog.some(t => t.name.toLowerCase() === trimmedTagQuery.toLowerCase())

  const rawAxes = detail?.details?.axes ?? card?.details?.axes
  const axes = Array.isArray(rawAxes) && rawAxes.length > 0 ? rawAxes : null

  async function updateSkillField(skillType, field, value) {
    if (!card || !activeProject) return
    setSavingSkillType(skillType)
    try {
      const r = await apiFetch(`/api/knowledge-cards?project_id=${activeProject.id}&id=${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill_type: skillType, [field]: value }),
      })
      if (!r.ok) throw new Error(r.statusText)
      const updated = await r.json()
      setDetail(prev => {
        if (!prev) return prev
        const rest = (prev.skill ?? []).filter(s => s.type !== skillType)
        return { ...prev, skill: [...rest, updated] }
      })
    } catch (e) {
      setError(String(e))
    } finally {
      setSavingSkillType(null)
    }
  }
  const updateSkillLevel = (skillType, value) => updateSkillField(skillType, 'level', value)
  const updateSkillImportance = (skillType, value) => updateSkillField(skillType, 'importance', value)

  // "Refine existing sense" (plan.md — "Word Senses" §3), also reachable straight from the card
  // detail view, not just at save time: correct a sense's gloss in place via the sense-specific
  // PATCH shape (api/knowledge-cards.js) rather than the skill_type/level shape above, since a
  // gloss lives on knowledge_cards.details.axes, not the skill row.
  async function refineSenseGloss(senseKey, gloss) {
    if (!card || !activeProject) return
    setSavingSkillType(senseKey)
    try {
      const r = await apiFetch(`/api/knowledge-cards?project_id=${activeProject.id}&id=${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sense_key: senseKey, sense_gloss: gloss }),
      })
      if (!r.ok) throw new Error(r.statusText)
      const updated = await r.json()
      setDetail(prev => prev ? { ...prev, details: updated.details } : prev)
    } catch (e) {
      setError(String(e))
    } finally {
      setSavingSkillType(null)
    }
  }

  // Full re-fetch after adding a sense — the PATCH response is just the updated card, but adding a
  // sense also creates a new `skill` row this panel doesn't otherwise know about, so the simplest
  // correct thing is to reload everything rather than hand-merge two partial shapes.
  function refetchDetail() {
    if (!card || !activeProject) return
    apiFetch(`/api/knowledge-cards?project_id=${activeProject.id}&id=${card.id}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(setDetail)
      .catch(e => setError(String(e)))
  }

  const sources = detail?.source_knowledge
    ?.map(sk => sk.sources ? { ...sk.sources, positions: sk.positions ?? [], skillId: sk.skill_id ?? null } : null)
    .filter(Boolean) ?? []

  // This card's sense options for the per-source picker below (null when the card isn't sense-split
  // — the picker only renders then). Each option pairs the sense's display key/gloss with its actual
  // skill id, looked up from `detail.skill` (already resolved to the external sense key by the API —
  // see lib/skillTypes.js's resolveSkillType()).
  const senseOptions = axes && isSenseAxis(axes[0])
    ? (axes[0].values ?? []).map(v => {
        const key = axisValueKey(v)
        return { key, gloss: axisValueGloss(v), skillId: (detail?.skill ?? []).find(s => s.type === key)?.id ?? null }
      })
    : null

  async function updateSourceSense(source, newSkillId) {
    if (!activeProject) return
    const prevSkillId = source.skillId
    setDetail(prev => prev ? {
      ...prev,
      source_knowledge: prev.source_knowledge.map(sk => sk.source_id === source.id ? { ...sk, skill_id: newSkillId } : sk),
    } : prev)
    try {
      const r = await apiFetch('/api/source-knowledge', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: activeProject.id, source_id: source.id, knowledge_card_id: card.id, skill_id: newSkillId }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText)
    } catch (e) {
      setError(String(e.message || e))
      setDetail(prev => prev ? {
        ...prev,
        source_knowledge: prev.source_knowledge.map(sk => sk.source_id === source.id ? { ...sk, skill_id: prevSkillId } : sk),
      } : prev)
    }
  }

  function startEditingName() {
    setNameDraft(card.name)
    setNameError(null)
    setEditingName(true)
  }

  async function saveName() {
    const trimmed = nameDraft.trim()
    if (!card || !activeProject || !trimmed || trimmed === card.name) {
      setEditingName(false)
      return
    }
    setSavingName(true)
    setNameError(null)
    try {
      const r = await apiFetch(`/api/knowledge-cards?project_id=${activeProject.id}&id=${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.error || r.statusText)
      }
      const updated = await r.json()
      setDetail(prev => prev ? { ...prev, name: updated.name } : prev)
      onRenamed?.(card.id, updated.name)
      setEditingName(false)
    } catch (e) {
      setNameError(String(e.message || e))
    } finally {
      setSavingName(false)
    }
  }

  async function deleteCard() {
    if (!card || !activeProject) return
    setDeleting(true)
    setError(null)
    try {
      const r = await apiFetch(`/api/knowledge-cards?project_id=${activeProject.id}&id=${card.id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(r.statusText)
      onDeleted ? onDeleted(card.id) : onClose?.()
    } catch (e) {
      setError(String(e))
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-w-0">
      <div
        className="px-3 py-2 border-b bg-white flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={onDragStart}
      >
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Card</span>
        <button
          onClick={onClose}
          onMouseDown={e => e.stopPropagation()}
          aria-label="Close"
          className="text-gray-400 hover:text-gray-600 transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {!card ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-gray-400">Select a card</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          {/* Card identity */}
          <div>
            <div className="flex items-start gap-2">
              {editingName ? (
                <div className="flex-1 min-w-0">
                  <input
                    autoFocus
                    type="text"
                    value={nameDraft}
                    disabled={savingName}
                    onChange={e => setNameDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveName()
                      if (e.key === 'Escape') setEditingName(false)
                    }}
                    onBlur={saveName}
                    className="w-full text-sm font-semibold text-gray-900 border border-blue-300 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-60"
                  />
                  {nameError && <p className="text-[10px] text-red-500 mt-0.5">{nameError}</p>}
                </div>
              ) : (
                <button
                  onClick={startEditingName}
                  title="Click to rename"
                  className="text-sm font-semibold text-gray-900 flex-1 leading-snug text-left hover:bg-gray-50 rounded px-0.5 -mx-0.5 transition-colors"
                >
                  {card.name}
                </button>
              )}
              <span className={`text-[10px] rounded px-1.5 py-0.5 font-medium shrink-0 ${KIND_COLORS[card.kind] ?? 'bg-gray-100 text-gray-600'}`}>
                {card.kind}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1 mt-2">
              {tags.map(tag => (
                <span key={tag} className="inline-flex items-center gap-1 text-[10px] bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">
                  <button
                    onClick={() => onSelectTag?.(tag)}
                    className="hover:text-gray-800 transition-colors"
                  >
                    {tag}
                  </button>
                  <button
                    onClick={() => removeTag(tag)}
                    disabled={savingTags}
                    title="Remove tag"
                    className="leading-none text-gray-400 hover:text-red-500 disabled:cursor-wait"
                  >
                    ×
                  </button>
                </span>
              ))}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowTagPicker(v => !v)}
                  disabled={savingTags}
                  title="Add tag"
                  className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-medium border transition-colors disabled:cursor-wait ${showTagPicker ? 'bg-blue-100 border-blue-300 text-blue-600' : 'border-gray-300 text-gray-400 hover:text-blue-500 hover:border-blue-300'}`}
                >
                  +
                </button>
                {showTagPicker && (
                  <>
                    <button
                      type="button"
                      className="fixed inset-0 z-10 cursor-default"
                      onClick={() => { setShowTagPicker(false); setTagSearch('') }}
                      aria-label="Close tag picker"
                    />
                    <div className="absolute left-0 top-full mt-1 z-20 w-56 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
                      <input
                        autoFocus
                        className="w-full text-xs border-b border-gray-200 px-2 py-1.5 focus:outline-none"
                        placeholder="Search tags…"
                        value={tagSearch}
                        onChange={e => setTagSearch(e.target.value)}
                      />
                      {canAddNewTag && (
                        <button
                          type="button"
                          onClick={() => addNewTag(trimmedTagQuery)}
                          className="w-full text-left px-2 py-1.5 hover:bg-amber-50 transition-colors border-b border-gray-100"
                        >
                          <span className="text-xs font-medium text-amber-700">+ Add new tag "{trimmedTagQuery}"</span>
                        </button>
                      )}
                      <div className="max-h-40 overflow-y-auto">
                        {tagPickerOptions.length === 0 && !canAddNewTag && (
                          <p className="text-xs text-gray-400 text-center py-2">No matching tags</p>
                        )}
                        {tagPickerOptions.map(t => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => addTag(t.name)}
                            className="w-full text-left px-2 py-1.5 hover:bg-gray-50 transition-colors"
                          >
                            <div className="text-xs text-gray-800 truncate">
                              {t.name}
                              {t.display_name && (
                                <span className="ml-1.5 text-[11px] text-gray-400">{t.display_name}</span>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-4 mt-3">
              <Dots value={importance} disabled={savingImportance} color="amber" label="Importance" zeroable emptyLabel="—" onSet={updateImportance} />
            </div>
          </div>

          {/* Skill */}
          {detail && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Skill</p>
                {card.kind === 'vocabulary' && !showAddSense && (
                  <button
                    type="button"
                    onClick={() => setShowAddSense(true)}
                    className="text-[10px] text-purple-500 hover:text-purple-700 font-medium"
                  >
                    + Add sense
                  </button>
                )}
              </div>
              {showAddSense && (
                <div className="mb-3">
                  <AddSenseForm
                    card={card}
                    hasSenseAxis={hasSenseAxis(detail ?? card)}
                    unlinkedSourceCount={(detail.source_knowledge ?? []).filter(sk => !sk.skill_id).length}
                    onAdded={() => { setShowAddSense(false); refetchDetail() }}
                    onCancel={() => setShowAddSense(false)}
                  />
                </div>
              )}
              {axes && isSenseAxis(axes[0]) ? (
                <SenseSkillList axes={axes} skillRows={detail.skill ?? []} onSetLevel={updateSkillLevel} onSetImportance={updateSkillImportance} onRefineGloss={refineSenseGloss} savingType={savingSkillType} highlightType={highlightSkillType} levelChange={levelChange} />
              ) : axes ? (
                <ParadigmSkillGrid axes={axes} skillRows={detail.skill ?? []} onSetLevel={updateSkillLevel} onSetImportance={updateSkillImportance} savingType={savingSkillType} highlightType={highlightSkillType} levelChange={levelChange} />
              ) : (
                <FlatSkillList kind={card.kind} skillRows={detail.skill ?? []} onSetLevel={updateSkillLevel} onSetImportance={updateSkillImportance} savingType={savingSkillType} highlightType={highlightSkillType} levelChange={levelChange} />
              )}
            </div>
          )}

          {/* Recent practice history for the just-practiced skill (Practice mode's docked card
              panel always passes highlightSkillType; elsewhere — Library, the peek overlay — no
              skill is "just answered" so this section stays hidden). */}
          {detail && highlightSkillType && (() => {
            const highlightedSkillId = (detail.skill ?? []).find(s => s.type === highlightSkillType)?.id ?? null
            if (!highlightedSkillId) return null
            return (
              <div>
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Recent practice</p>
                <PracticeHistory activeProject={activeProject} skillId={highlightedSkillId} refreshToken={detail} />
              </div>
            )
          })()}

          {/* Seed vocabulary offered to the model for this practice item (Practice mode only) */}
          {seedInfo && seedInfo.offered.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Suggested vocabulary</p>
              <div className="flex flex-wrap gap-1">
                {seedInfo.offered.map(name => {
                  const used = seedInfo.used.includes(name)
                  return (
                    <span
                      key={name}
                      className={`text-[10px] rounded px-1.5 py-0.5 ${used ? 'bg-blue-100 text-blue-700 font-medium' : 'bg-gray-100 text-gray-400'}`}
                      title={used ? 'Used in this item' : 'Offered, not used'}
                    >
                      {name}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {/* Linked sources */}
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
              Sources{detail ? ` (${sources.length})` : ''}
            </p>
            {loading && <p className="text-xs text-gray-400">Loading…</p>}
            {error && <p className="text-xs text-red-500">{error}</p>}
            {!loading && !error && sources.length === 0 && detail && (
              <p className="text-xs text-gray-400">No sources linked.</p>
            )}
            <div className="space-y-2">
              {sources.map(source => (
                <div key={source.id} className="border border-gray-200 rounded-lg p-3 bg-white">
                  <div className="flex items-start gap-2">
                    {onSelectSource ? (
                      <button
                        onClick={() => onSelectSource(source)}
                        className="text-xs text-gray-800 leading-snug flex-1 font-medium text-left hover:text-blue-600 transition-colors"
                      >
                        <HighlightedText text={source.original_text} positions={source.positions} />
                      </button>
                    ) : (
                      <p className="text-xs text-gray-800 leading-snug flex-1 font-medium">
                        <HighlightedText text={source.original_text} positions={source.positions} />
                      </p>
                    )}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => speak(source.original_text, activeProject?.tts_locale)}
                        title="Speak"
                        className="text-gray-400 hover:text-blue-500 transition-colors"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                          <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
                        </svg>
                      </button>
                      <button
                        onClick={() => onAppendToChat?.(source.original_text)}
                        title="Add to chat"
                        className="text-gray-400 hover:text-green-600 transition-colors"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                          <polyline points="9 10 4 15 9 20" />
                          <path d="M20 4v7a4 4 0 01-4 4H4" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    {source.contexts?.name && (
                      <span className="text-[10px] bg-blue-50 text-blue-600 rounded px-1.5 py-0.5">
                        {source.contexts.name}
                      </span>
                    )}
                    <span className="text-[10px] text-gray-400">{formatDate(source.created_at)}</span>
                    {senseOptions && (
                      editingSenseFor === source.id ? (
                        <div className="ml-auto flex items-center gap-1">
                          <select
                            autoFocus
                            value={senseDraft}
                            onChange={e => setSenseDraft(e.target.value)}
                            title="Which sense of this word this source demonstrates"
                            className="text-[10px] border border-gray-200 rounded px-1 py-0.5 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-purple-400"
                          >
                            <option value="">— no sense set —</option>
                            {senseOptions.map(opt => (
                              <option key={opt.key} value={opt.skillId ?? ''} disabled={!opt.skillId}>{opt.key}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => { updateSourceSense(source, senseDraft || null); setEditingSenseFor(null) }}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500 text-white hover:bg-purple-600"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingSenseFor(null)}
                            className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="ml-auto flex items-center gap-1.5">
                          <span className="text-[10px] text-gray-500">
                            {senseOptions.find(o => o.skillId === source.skillId)?.key ?? '— no sense —'}
                          </span>
                          <button
                            type="button"
                            onClick={() => { setEditingSenseFor(source.id); setSenseDraft(source.skillId ?? '') }}
                            className="text-[10px] text-purple-500 hover:text-purple-700 font-medium"
                          >
                            Edit
                          </button>
                        </div>
                      )
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Delete card — cascades to its skills, practice history, and source links */}
          <div className="border-t pt-4">
            {confirmingDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-600 flex-1">
                  Delete "{card.name}" and all its skills, practice history, and source links? This cannot be undone.
                </span>
                <button
                  onClick={deleteCard}
                  disabled={deleting}
                  className="text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded px-2 py-1 shrink-0 transition-colors"
                >
                  {deleting ? 'Deleting…' : 'Confirm delete'}
                </button>
                <button
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                  className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-60 rounded px-2 py-1 shrink-0 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="text-xs font-medium text-red-600 hover:text-red-700 transition-colors"
              >
                Delete card
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
