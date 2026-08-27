import { useState, useEffect } from 'react'
import { apiFetch } from '../../apiFetch.js'
import GermanText from '../GermanText.jsx'

const CARDS_PAGE_SIZE = 20

const KIND_COLORS = {
  vocabulary: 'text-blue-600 bg-blue-50',
  grammar: 'text-purple-600 bg-purple-50',
  expression: 'text-green-600 bg-green-50',
}

export function TagsPanel({ activeProject, tagCatalog, onNewTags, onDragStart, onClose, selectedTag, onSelectTag, onSelectCard, selectedCardId }) {
  const [cards, setCards] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const [showNewTagForm, setShowNewTagForm] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [newTagDisplayName, setNewTagDisplayName] = useState('')
  const [creatingTag, setCreatingTag] = useState(false)
  const [createTagError, setCreateTagError] = useState(null)

  const [editingTagId, setEditingTagId] = useState(null)
  const [editName, setEditName] = useState('')
  const [editDisplayName, setEditDisplayName] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState(null)

  function startEditTag(tag) {
    setEditingTagId(tag.id)
    setEditName(tag.name)
    setEditDisplayName(tag.display_name ?? '')
    setEditError(null)
  }

  function cancelEditTag() {
    setEditingTagId(null)
    setEditError(null)
  }

  async function handleSaveTagEdit(e, tagId) {
    e.preventDefault()
    if (!editName.trim()) return
    setSavingEdit(true)
    setEditError(null)
    try {
      const res = await apiFetch(`/api/tags?id=${tagId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.trim(),
          display_name: editDisplayName.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to update tag')
      onNewTags?.()
      setEditingTagId(null)
    } catch (err) {
      setEditError(err.message)
    } finally {
      setSavingEdit(false)
    }
  }

  async function handleCreateTag(e) {
    e.preventDefault()
    if (!newTagName.trim() || !newTagDisplayName.trim() || !activeProject) return
    setCreatingTag(true)
    setCreateTagError(null)
    try {
      const res = await apiFetch('/api/tags', {
        method: 'POST',
        body: JSON.stringify({
          project_id: activeProject.id,
          name: newTagName.trim(),
          display_name: newTagDisplayName.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create tag')
      onNewTags?.()
      setNewTagName('')
      setNewTagDisplayName('')
      setShowNewTagForm(false)
    } catch (err) {
      setCreateTagError(err.message)
    } finally {
      setCreatingTag(false)
    }
  }

  // Reset on project change
  useEffect(() => {
    onSelectTag?.(null)
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
    onSelectTag?.(tagName)
    setPage(0)
    setCards([])
    setTotal(0)
  }

  function handleBack() {
    onSelectTag?.(null)
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
            onClick={() => setShowNewTagForm(v => !v)}
            onMouseDown={e => e.stopPropagation()}
            aria-label="New tag"
            title="New tag"
            className={`ml-auto text-gray-400 hover:text-gray-600 transition-colors shrink-0 ${showNewTagForm ? 'text-blue-500 hover:text-blue-600' : ''}`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            onClick={onClose}
            onMouseDown={e => e.stopPropagation()}
            aria-label="Close"
            className="ml-2 text-gray-400 hover:text-gray-600 transition-colors shrink-0"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {showNewTagForm && (
          <div className="px-3 py-3 border-b bg-gray-50 shrink-0">
            <form onSubmit={handleCreateTag} className="space-y-2">
              <input
                className="w-full text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
                placeholder="Internal name (e.g. verb-irregular-present)"
                value={newTagName}
                onChange={e => setNewTagName(e.target.value)}
                disabled={!activeProject || creatingTag}
                autoFocus
              />
              <input
                className="w-full text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
                placeholder="Display name (e.g. irr-present)"
                value={newTagDisplayName}
                onChange={e => setNewTagDisplayName(e.target.value)}
                disabled={!activeProject || creatingTag}
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={creatingTag || !newTagName.trim() || !newTagDisplayName.trim() || !activeProject}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-blue-500 text-white text-sm hover:bg-blue-600 disabled:opacity-40 transition-colors"
                >
                  {creatingTag ? 'Adding…' : 'Add tag'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowNewTagForm(false); setCreateTagError(null) }}
                  className="px-3 py-1.5 rounded-lg text-gray-500 text-sm hover:bg-gray-100 transition-colors"
                >
                  Cancel
                </button>
              </div>
              {createTagError && <p className="text-xs text-red-500">{createTagError}</p>}
            </form>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {tagCatalog.length === 0 && (
            <p className="text-xs text-gray-400 text-center mt-8">No tags yet.</p>
          )}
          {[...tagCatalog].sort((a, b) => a.name.localeCompare(b.name)).map(tag => (
            editingTagId === tag.id ? (
              <div key={tag.id} className="px-3 py-2.5 border-b border-gray-100 bg-gray-50">
                <form onSubmit={e => handleSaveTagEdit(e, tag.id)} className="space-y-2">
                  <input
                    className="w-full text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
                    placeholder="Internal name"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    disabled={savingEdit}
                    autoFocus
                  />
                  <input
                    className="w-full text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
                    placeholder="Display name"
                    value={editDisplayName}
                    onChange={e => setEditDisplayName(e.target.value)}
                    disabled={savingEdit}
                  />
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={savingEdit || !editName.trim()}
                      className="flex-1 px-3 py-1.5 rounded-lg bg-blue-500 text-white text-sm hover:bg-blue-600 disabled:opacity-40 transition-colors"
                    >
                      {savingEdit ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEditTag}
                      className="px-3 py-1.5 rounded-lg text-gray-500 text-sm hover:bg-gray-100 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                  {editError && <p className="text-xs text-red-500">{editError}</p>}
                </form>
              </div>
            ) : (
              <div
                key={tag.id}
                className="w-full text-left px-3 py-2.5 border-b border-gray-100 hover:bg-gray-50 transition-colors group flex items-start"
              >
                <button onClick={() => handleTagClick(tag.name)} className="flex-1 min-w-0 text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-800 font-medium truncate flex-1 min-w-0">
                      {tag.name}
                      {tag.display_name && (
                        <span className="ml-1.5 text-[11px] font-normal text-gray-400">{tag.display_name}</span>
                      )}
                    </span>
                    <span className="text-[10px] text-gray-400 shrink-0 text-right">
                      {tag.card_count ?? 0} card{tag.card_count === 1 ? '' : 's'}
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
                <button
                  onClick={() => startEditTag(tag)}
                  aria-label="Edit tag"
                  title="Edit tag"
                  className="ml-2 mt-0.5 shrink-0 text-gray-300 hover:text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                    strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                    <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              </div>
            )
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
        {cards.map(card => {
          const isSelected = card.id === selectedCardId
          return (
            <div
              key={card.id}
              onClick={() => onSelectCard?.(card)}
              className={`px-3 py-2.5 border-b border-gray-100 cursor-pointer transition-colors ${
                isSelected ? 'bg-blue-50 border-l-2 border-l-blue-500' : 'hover:bg-gray-50'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm text-gray-800 font-medium leading-snug truncate">
                  <GermanText>{card.name}</GermanText>
                </span>
                <span className={`text-[10px] rounded px-1.5 py-0.5 shrink-0 ${KIND_COLORS[card.kind] ?? 'text-gray-500 bg-gray-100'}`}>
                  {card.kind}
                </span>
              </div>
              {card.tags && card.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {card.tags.filter(t => t !== selectedTag).map(t => (
                    <button
                      key={t}
                      onClick={e => { e.stopPropagation(); handleTagClick(t) }}
                      className="text-[10px] text-gray-500 bg-gray-100 hover:bg-gray-200 rounded px-1.5 py-0.5 transition-colors"
                    >
                      {tagCatalog.find(tc => tc.name === t)?.display_name || t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
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
