import { useState, useEffect, forwardRef, useImperativeHandle } from 'react'
import { speak } from '../tts.js'
import GermanText from './GermanText.jsx'
import { apiFetch } from '../apiFetch.js'
import { useProject } from '../ProjectContext.jsx'
import { getProjectConfig } from '../../lib/projectConfig.js'

const TABLE_LABELS = {
  source: 'Source',
  knowledge_card: 'Knowledge Card',
}

const SaveCard = forwardRef(function SaveCard({ table, record, onSave, saveState = { status: 'idle' }, blocked = false, validationWarnings = [], unknownFields = [], contexts, sourceText, tagCatalog = [], onNewTags, linkState, onLink }, ref) {
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
    return table === 'source' ? { context_id: '', ...base } : base
  })

  // Tags are managed separately from fields for knowledge_card
  const [tagList, setTagList] = useState(() => {
    if (table !== 'knowledge_card') return []
    try {
      const raw = record.tags
      return Array.isArray(raw) ? raw : JSON.parse(raw ?? '[]')
    } catch { return [] }
  })

  // Per-unknown-tag metadata: { [originalTagName]: { addToCatalog, name, displayName, description } }
  // Seeded from model's new_tags hints (proposed both name and display_name)
  const [newTagMeta, setNewTagMeta] = useState(() => {
    if (table !== 'knowledge_card') return {}
    const hints = Array.isArray(record.new_tags) ? record.new_tags : []
    const meta = {}
    for (const h of hints) {
      if (h.name) {
        meta[h.name] = { addToCatalog: true, name: h.name, displayName: h.display_name ?? '', description: '' }
      }
    }
    return meta
  })
  const [tagInput, setTagInput] = useState('')

  // When catalog loads, initialize meta for any unknown tags not already in meta
  useEffect(() => {
    if (!tagCatalog.length) return
    const catalogSet = new Set(tagCatalog.map(t => t.name))
    setNewTagMeta(prev => {
      const next = { ...prev }
      let changed = false
      for (const t of tagList) {
        if (!catalogSet.has(t) && !next[t]) {
          next[t] = { addToCatalog: true, name: t, displayName: '', description: '' }
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [tagCatalog, tagList])

  const complexFields = new Set(
    Object.keys(record).filter(k => typeof record[k] === 'object' && record[k] !== null && k !== 'new_tags')
  )
  const rangeFields = new Set(['skill', 'importance'])
  const unknownFieldSet = new Set(unknownFields)
  const catalogSet = new Set(tagCatalog.map(t => t.name))
  const catalogMap = new Map(tagCatalog.map(t => [t.name, t]))

  const [existingCard, setExistingCard] = useState(null)

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

  function addTag(raw) {
    const tag = raw.trim().toLowerCase()
    if (!tag || tagList.includes(tag)) return
    setTagList(prev => [...prev, tag])
    if (!catalogSet.has(tag)) {
      setNewTagMeta(prev => ({ ...prev, [tag]: { addToCatalog: true, name: tag, displayName: '', description: '' } }))
    }
  }

  function removeTag(tag) {
    setTagList(prev => prev.filter(t => t !== tag))
  }

  function updateTagMeta(tag, patch) {
    setNewTagMeta(prev => ({
      ...prev,
      [tag]: { ...(prev[tag] ?? { addToCatalog: true, name: tag, displayName: '', description: '' }), ...patch },
    }))
  }

  async function handleSaveClick() {
    // Determine final tags: known + confirmed-new; drop unchecked new tags
    // For new tags, use the (possibly edited) name from meta
    const finalTags = tagList
      .filter(t => {
        if (catalogSet.has(t)) return true
        return (newTagMeta[t]?.addToCatalog ?? true)
      })
      .map(t => {
        if (!catalogSet.has(t)) return newTagMeta[t]?.name || t
        return t
      })

    // Post new confirmed tags to catalog (best-effort)
    const tagsToCreate = tagList.filter(t => !catalogSet.has(t) && (newTagMeta[t]?.addToCatalog ?? true))
    for (const originalName of tagsToCreate) {
      const meta = newTagMeta[originalName] ?? {}
      try {
        await apiFetch('/api/tags', {
          method: 'POST',
          body: JSON.stringify({
            project_id: activeProject?.id,
            name: meta.name || originalName,
            display_name: meta.displayName || undefined,
          }),
        })
      } catch { /* best-effort */ }
    }
    if (tagsToCreate.length > 0) onNewTags?.()

    const finalFields = table === 'knowledge_card'
      ? { ...fields, tags: JSON.stringify(finalTags) }
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
  const isDisabled = isSaving || isSaved || blocked || needsContext

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
          {isSaved ? 'Saved' : isSaving ? 'Saving…' : blocked ? 'Save source first' : needsContext ? 'Select a context' : 'Save'}
        </button>
      </div>

      {sourceText && (
        <div className="rounded-md bg-gray-50 border border-gray-200 px-2 py-1.5">
          <p className="text-xs text-gray-600 italic"><GermanText>{sourceText}</GermanText></p>
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
          const unknownInList = tagList.filter(t => tagCatalog.length > 0 && !catalogSet.has(t))
          return (
            <div key={key}>
              <label className="block text-xs mb-1 text-gray-500">tags</label>
              <div className="flex flex-wrap gap-1 mb-1">
                {tagList.map(tag => {
                  const isNew = tagCatalog.length > 0 && !catalogSet.has(tag)
                  const catalogEntry = catalogMap.get(tag)
                  const label = isNew
                    ? (newTagMeta[tag]?.name || tag)
                    : (catalogEntry?.display_name || tag)
                  return (
                    <span key={tag} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${isNew ? 'bg-amber-100 text-amber-800 border border-amber-300' : 'bg-blue-100 text-blue-700'}`}>
                      {isNew && <span className="text-[9px] font-bold uppercase tracking-wide opacity-70">new</span>}
                      {label}
                      {!isSaved && (
                        <button onClick={() => removeTag(tag)} className="ml-0.5 leading-none hover:text-red-500 text-gray-400">×</button>
                      )}
                    </span>
                  )
                })}
              </div>

              {unknownInList.map(tag => (
                <div key={tag} className="border border-amber-200 rounded-lg bg-amber-50 px-2 py-2 mb-1 space-y-1.5">
                  <label className="flex items-center gap-2 text-xs text-amber-800 cursor-pointer font-medium">
                    <input
                      type="checkbox"
                      checked={newTagMeta[tag]?.addToCatalog ?? true}
                      onChange={e => updateTagMeta(tag, { addToCatalog: e.target.checked })}
                    />
                    Add to catalog
                  </label>
                  {(newTagMeta[tag]?.addToCatalog ?? true) && (
                    <div className="grid grid-cols-2 gap-1.5">
                      <div>
                        <label className="block text-[10px] text-amber-700 mb-0.5">name</label>
                        <input
                          className="w-full text-xs font-mono border border-amber-200 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-amber-400"
                          placeholder="verb-irregular-present"
                          value={newTagMeta[tag]?.name ?? tag}
                          onChange={e => updateTagMeta(tag, { name: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-amber-700 mb-0.5">display</label>
                        <input
                          className="w-full text-xs font-mono border border-amber-200 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-amber-400"
                          placeholder="irr-present"
                          value={newTagMeta[tag]?.displayName ?? ''}
                          onChange={e => updateTagMeta(tag, { displayName: e.target.value })}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {!isSaved && (
                <input
                  className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                  placeholder="Add tag and press Enter…"
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  onKeyDown={e => {
                    if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
                      e.preventDefault()
                      addTag(tagInput)
                      setTagInput('')
                    }
                  }}
                />
              )}
            </div>
          )
        }

        return (
          <div key={key}>
            <label className={`block text-xs mb-0.5 ${unknownFieldSet.has(key) ? 'text-amber-500' : 'text-gray-500'}`}>{key}</label>
            {key === 'context_id' ? (
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
