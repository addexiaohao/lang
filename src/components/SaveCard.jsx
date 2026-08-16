import { useState, useEffect, forwardRef, useImperativeHandle } from 'react'
import { speak } from '../tts.js'
import GermanText from './GermanText.jsx'
import AnnotatedSpanEditor from './AnnotatedSpanEditor.jsx'
import { useProject } from '../ProjectContext.jsx'
import { getProjectConfig } from '../../lib/projectConfig.js'
import { stripMarkers, applyMarkers } from '../../lib/annotationMarkers.js'
import { apiFetch } from '../apiFetch.js'

const TABLE_LABELS = {
  source: 'Source',
  knowledge_card: 'Knowledge Card',
}

const SaveCard = forwardRef(function SaveCard({ table, record, onSave, saveState = { status: 'idle' }, blocked = false, validationWarnings = [], unknownFields = [], contexts, forcedContext = null, sourceText, tagCatalog = [], proposedTagMeta = {}, onAddNewTag, linkState, onLink, annotatedSentence, onAnnotatedSentenceChange }, ref) {
  const { activeProject } = useProject()
  const { ttsLocale, contextsRequired } = getProjectConfig(activeProject ?? {})
  const [fields, setFields] = useState(() => {
    const base = Object.fromEntries(
      Object.entries(record)
        .filter(([k]) => k !== 'new_tags')
        .map(([k, v]) => [
          k,
          typeof v === 'object' && v !== null ? JSON.stringify(v, null, 2) : String(v ?? ''),
        ])
    )
    return table === 'source' ? { context_id: forcedContext?.id ?? '', ...base } : base
  })

  // Tags are managed separately from fields for knowledge_card
  const [tagList, setTagList] = useState(() => {
    if (table !== 'knowledge_card') return []
    try {
      const raw = record.tags
      return Array.isArray(raw) ? raw : JSON.parse(raw ?? '[]')
    } catch { return [] }
  })


  const complexFields = new Set(
    Object.keys(record).filter(k => typeof record[k] === 'object' && record[k] !== null && k !== 'new_tags')
  )
  // A paradigm card's proposed axes must be inspectable as the grid they'll produce, not raw
  // JSON — this is the one irreversible choice in the save flow (axes are immutable once saved).
  const proposedAxes = Array.isArray(record.details?.axes) && record.details.axes.length > 0
    ? record.details.axes
    : null
  const rangeFields = new Set(['importance'])
  const unknownFieldSet = new Set(unknownFields)
  const catalogSet = new Set(tagCatalog.map(t => t.name))
  const catalogMap = new Map(tagCatalog.map(t => [t.name, t]))

  const [editingSpan, setEditingSpan] = useState(false)
  let sentenceInfo = null
  try {
    if (annotatedSentence) sentenceInfo = stripMarkers(annotatedSentence)
  } catch {
    sentenceInfo = null
  }
  // Positions of the annotated span relative to the full sourceText (which may
  // contain more than just the annotated sentence), for highlighting inline.
  let annotatedPositions = []
  if (sentenceInfo && sourceText) {
    const offset = sourceText.indexOf(sentenceInfo.text)
    if (offset !== -1) {
      annotatedPositions = sentenceInfo.positions.map(p => ({ start: p.start + offset, end: p.end + offset }))
    }
  }

  const [existingCard, setExistingCard] = useState(null)
  const [showTagPicker, setShowTagPicker] = useState(false)
  const [tagSearch, setTagSearch] = useState('')

  useEffect(() => {
    if (table === 'knowledge_card' && fields.name && activeProject) {
      apiFetch(`/api/search-knowledge-cards?project_id=${activeProject.id}&q=${encodeURIComponent(fields.name)}`)
        .then(r => r.json())
        .then(results => {
          const exact = results.find(c => c.name.toLowerCase() === fields.name.toLowerCase())
          if (exact) setExistingCard(exact)
        })
        .catch(() => {})
    } else if (table === 'source' && fields.original_text && activeProject) {
      apiFetch(`/api/search-sources?project_id=${activeProject.id}&q=${encodeURIComponent(fields.original_text)}`)
        .then(r => r.json())
        .then(results => { if (results.length > 0) setExistingCard(results[0]) })
        .catch(() => {})
    }
  }, [])

  function update(key, value) {
    setFields(prev => ({ ...prev, [key]: value }))
  }

  function removeTag(tag) {
    setTagList(prev => prev.filter(t => t !== tag))
  }

  function addTag(tag) {
    setTagList(prev => prev.includes(tag) ? prev : [...prev, tag])
    setShowTagPicker(false)
    setTagSearch('')
  }

  function addNewTag(name) {
    addTag(name)
    onAddNewTag?.(name)
  }

  async function handleSaveClick() {
    const finalFields = table === 'knowledge_card'
      ? { ...fields, tags: JSON.stringify(tagList) }
      : fields
    await onSave(table, finalFields)
  }

  useImperativeHandle(ref, () => ({
    save: handleSaveClick,
  }))

  const { status, error } = saveState
  const isSaving = status === 'saving'
  const isSaved = status === 'saved'
  const needsContext = table === 'source' && contextsRequired && !fields.context_id
  const hasUnconfirmedTags = table === 'knowledge_card' && tagList.some(t => !catalogSet.has(t))
  const isDisabled = isSaving || isSaved || blocked || needsContext || hasUnconfirmedTags

  return (
    <div className="border border-blue-200 rounded-xl bg-blue-50 p-3 space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-blue-600 uppercase tracking-wide">
          {TABLE_LABELS[table] ?? table}
        </span>
        <button
          onClick={handleSaveClick}
          disabled={isDisabled}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            isSaved
              ? 'bg-green-500 text-white cursor-default'
              : blocked
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : isSaving
                  ? 'bg-blue-300 text-white cursor-not-allowed'
                  : 'bg-blue-500 text-white hover:bg-blue-600'
          }`}
        >
          {isSaved ? 'Saved' : isSaving ? 'Saving…' : hasUnconfirmedTags ? 'Confirm tags first' : blocked ? 'Save source first' : needsContext ? 'Select a context' : 'Save'}
        </button>
      </div>

      {sourceText && (
        <div className="rounded-md bg-gray-50 border border-gray-200 px-2 py-1.5 space-y-1.5">
          {editingSpan && sentenceInfo ? (
            <AnnotatedSpanEditor
              text={sentenceInfo.text}
              positions={sentenceInfo.positions}
              highlightClassName="bg-blue-200 text-blue-900"
              onChange={ranges => {
                onAnnotatedSentenceChange?.(applyMarkers(sentenceInfo.text, ranges))
                setEditingSpan(false)
              }}
              onCancel={() => setEditingSpan(false)}
            />
          ) : (
            <div className="flex items-start gap-2">
              <p className="text-xs text-gray-600 italic flex-1">
                <GermanText positions={annotatedPositions}>{sourceText}</GermanText>
              </p>
              {sentenceInfo && !isSaved && (
                <button
                  type="button"
                  onClick={() => setEditingSpan(true)}
                  className="shrink-0 text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                >
                  Edit
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {existingCard && (
        <div className="rounded-md bg-yellow-50 border border-yellow-200 px-2 py-1.5 flex items-center justify-between gap-2">
          <p className="text-xs text-yellow-700">
            {table === 'source'
              ? 'This source has already been saved.'
              : `Already in your library — "${existingCard.name}" (${existingCard.kind})`}
          </p>
          {table === 'knowledge_card' && onLink && (() => {
            const ls = linkState ?? { status: 'idle' }
            const isLinked = ls.status === 'linked'
            const isLinking = ls.status === 'linking'
            const isLinkDisabled = blocked || isLinking || isLinked
            return (
              <button
                onClick={() => onLink(existingCard.id)}
                disabled={isLinkDisabled}
                className={`shrink-0 px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                  isLinked
                    ? 'bg-green-500 text-white cursor-default'
                    : isLinking
                      ? 'bg-yellow-300 text-yellow-900 cursor-not-allowed'
                      : blocked
                        ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                        : 'bg-yellow-600 text-white hover:bg-yellow-700'
                }`}
              >
                {isLinked ? 'Linked' : isLinking ? 'Linking…' : blocked ? 'Save source first' : 'Add link'}
              </button>
            )
          })()}
        </div>
      )}

      {validationWarnings.length > 0 && (
        <div className="rounded-md bg-amber-50 border border-amber-200 px-2 py-1.5 space-y-0.5">
          {validationWarnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-700">{w}</p>
          ))}
        </div>
      )}

      {status === 'error' && (
        <p className="text-xs text-red-500">{error}</p>
      )}

      {Object.entries(fields).map(([key, value]) => {
        if (key === 'tags' && table === 'knowledge_card') {
          const pickerOptions = tagCatalog
            .filter(t => !tagList.includes(t.name))
            .filter(t => {
              const q = tagSearch.trim().toLowerCase()
              if (!q) return true
              return t.name.toLowerCase().includes(q) || (t.display_name ?? '').toLowerCase().includes(q)
            })
            .sort((a, b) => a.name.localeCompare(b.name))

          const trimmedQuery = tagSearch.trim()
          const canAddNewTag = trimmedQuery.length > 0
            && !tagList.some(t => t.toLowerCase() === trimmedQuery.toLowerCase())
            && !tagCatalog.some(t => t.name.toLowerCase() === trimmedQuery.toLowerCase())

          return (
            <div key={key} className="relative">
              <label className="block text-xs mb-1 text-gray-500">tags</label>
              <div className="flex flex-wrap items-center gap-1">
                {tagList.map(tag => {
                  const isProposed = !catalogSet.has(tag)
                  const catalogEntry = catalogMap.get(tag)
                  const label = isProposed
                    ? (proposedTagMeta[tag]?.displayName || tag)
                    : (catalogEntry?.display_name || tag)
                  return (
                    <span key={tag} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${isProposed ? 'bg-amber-100 text-amber-800 border border-amber-300' : 'bg-blue-100 text-blue-700'}`}>
                      {label}
                      {!isSaved && (
                        <button onClick={() => removeTag(tag)} className="ml-0.5 leading-none hover:text-red-500 text-gray-400">×</button>
                      )}
                    </span>
                  )
                })}
                {!isSaved && (
                  <button
                    type="button"
                    onClick={() => setShowTagPicker(v => !v)}
                    className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-medium border transition-colors ${showTagPicker ? 'bg-blue-100 border-blue-300 text-blue-600' : 'border-gray-300 text-gray-400 hover:text-blue-500 hover:border-blue-300'}`}
                    title="Add tag"
                  >
                    +
                  </button>
                )}
              </div>

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
                        onClick={() => addNewTag(trimmedQuery)}
                        className="w-full text-left px-2 py-1.5 hover:bg-amber-50 transition-colors border-b border-gray-100"
                      >
                        <span className="text-xs font-medium text-amber-700">+ Add new tag "{trimmedQuery}"</span>
                      </button>
                    )}
                    <div className="max-h-40 overflow-y-auto">
                      {pickerOptions.length === 0 && !canAddNewTag && (
                        <p className="text-xs text-gray-400 text-center py-2">No matching tags</p>
                      )}
                      {pickerOptions.map(t => (
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
          )
        }

        return (
          <div key={key}>
            <label className={`block text-xs mb-0.5 ${unknownFieldSet.has(key) ? 'text-amber-500' : 'text-gray-500'}`}>{key}</label>
            {key === 'context_id' ? (
              forcedContext ? (
                <div
                  className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-gray-100 text-gray-500"
                  title="This chat only ever saves sources under the generated context"
                >
                  {forcedContext.name}
                </div>
              ) : (
                <select
                  value={value}
                  onChange={e => update('context_id', e.target.value)}
                  className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                >
                  <option value="">Select context…</option>
                  {(contexts ?? []).map(ctx => (
                    <option key={ctx.id} value={ctx.id}>{ctx.name}</option>
                  ))}
                </select>
              )
            ) : rangeFields.has(key) ? (
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={value || 1}
                  onChange={e => update(key, e.target.value)}
                  className="flex-1 accent-blue-500"
                />
                <span className="text-xs font-mono w-4 text-center">{value || 1}</span>
              </div>
            ) : key === 'details' && proposedAxes ? (
              <div className="rounded-md bg-white border border-gray-200 px-2 py-1.5 space-y-1.5">
                <p className="text-xs font-mono text-gray-700">
                  {proposedAxes.map(a => a.name).join(' × ')}
                  {' → '}
                  {proposedAxes.map(a => a.values?.length ?? 0).join(' × ')}
                  {' = '}
                  {proposedAxes.reduce((acc, a) => acc * (a.values?.length ?? 0), 1)} cells
                </p>
                {proposedAxes.map(a => (
                  <div key={a.name} className="flex flex-wrap items-center gap-1">
                    <span className="text-[10px] text-gray-400 shrink-0">{a.name}:</span>
                    {(a.values ?? []).map(v => (
                      <span key={v} className="text-[10px] bg-purple-100 text-purple-700 rounded px-1.5 py-0.5">{v}</span>
                    ))}
                  </div>
                ))}
                <p className="text-[10px] text-amber-600">Axes are immutable once this card is saved.</p>
              </div>
            ) : complexFields.has(key) ? (
              <textarea
                className="w-full text-xs font-mono border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
                rows={Math.min(value.split('\n').length + 1, 8)}
                value={value}
                onChange={e => update(key, e.target.value)}
              />
            ) : key === 'original_text' ? (
              <div className="flex items-center gap-1">
                <input
                  className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                  value={value}
                  onChange={e => update(key, e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => speak(value, ttsLocale)}
                  disabled={!value.trim()}
                  className="shrink-0 p-1 text-gray-400 hover:text-amber-600 disabled:opacity-30 transition-colors"
                  title="Speak"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path d="M10 3.75a.75.75 0 00-1.264-.546L4.703 7H3.167a.75.75 0 00-.7.48A6.985 6.985 0 002 10c0 .887.165 1.737.468 2.52.111.29.39.48.7.48h1.535l4.033 3.796A.75.75 0 0010 16.25V3.75zM15.95 5.05a.75.75 0 00-1.06 1.061 5.5 5.5 0 010 7.778.75.75 0 001.06 1.06 7 7 0 000-9.899zM13.829 7.172a.75.75 0 00-1.061 1.06 2.5 2.5 0 010 3.536.75.75 0 001.06 1.06 4 4 0 000-5.656z" />
                  </svg>
                </button>
              </div>
            ) : (
              <input
                className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                value={value}
                onChange={e => update(key, e.target.value)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
})

export default SaveCard
