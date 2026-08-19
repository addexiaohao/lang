import { useState, useEffect } from 'react'
import { apiFetch } from '../../apiFetch.js'
import { speak } from '../../tts.js'
import { HighlightedText } from '../HighlightedText.jsx'
import { isIndexInRanges } from '../../highlightText.js'
import AnnotatedSpanEditor from '../AnnotatedSpanEditor.jsx'

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

const KIND_COLORS = {
  vocabulary: 'bg-green-100 text-green-700',
  grammar: 'bg-purple-100 text-purple-700',
  expression: 'bg-orange-100 text-orange-700',
}

export function SourceDetailPanel({ source, activeProject, onClose, onAppendToChat, onDragStart, onSelectCard }) {
  const [selectedCardId, setSelectedCardId] = useState(null)
  const [hoveredCardId, setHoveredCardId] = useState(null)
  const [hoveredCharIndex, setHoveredCharIndex] = useState(null)
  const [detail, setDetail] = useState(null)
  const [editingCardId, setEditingCardId] = useState(null)
  const [savingPosition, setSavingPosition] = useState(false)
  const [positionError, setPositionError] = useState(null)

  // The `source` prop can come from two shapes: the Sources list (carries `source_knowledge`
  // with cards but no `positions`) or a bare { id, original_text, ... } handed over from
  // CardDetailPanel's "open source" action (carries neither). Either way, fetch the full detail
  // separately and prefer it once it lands — it's the only shape that's always complete (cards +
  // positions together). `source.source_knowledge`, when present, is used only so card identity
  // can render instantly before `detail` arrives.
  useEffect(() => {
    if (!source?.id || !activeProject) return
    setDetail(null)
    setEditingCardId(null)
    apiFetch(`/api/sources?project_id=${activeProject.id}&id=${source.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(setDetail)
      .catch(() => {})
  }, [source?.id, activeProject?.id])

  const sourceKnowledge = detail?.source_knowledge ?? source?.source_knowledge ?? []
  const cards = sourceKnowledge.map(sk => ({
    ...sk.knowledge_cards,
    positions: sk.positions ?? [],
  })).filter(c => c?.id)

  // Hover previews positions without disturbing the click-based selection;
  // it falls back to whatever is selected once the pointer leaves.
  const activeCardId = hoveredCardId ?? selectedCardId
  const highlightedPositions = activeCardId
    ? (cards.find(c => c.id === activeCardId)?.positions ?? [])
    : []

  // While hovering source text, bubble matching cards to the top; others
  // keep their relative order. Reverts to original order once the pointer
  // leaves the text (hoveredCharIndex back to null).
  const displayCards = hoveredCharIndex == null
    ? cards
    : [...cards].sort((a, b) => {
        const aMatch = isIndexInRanges(hoveredCharIndex, a.positions)
        const bMatch = isIndexInRanges(hoveredCharIndex, b.positions)
        return (bMatch ? 1 : 0) - (aMatch ? 1 : 0)
      })

  function handleCardClick(cardId) {
    setSelectedCardId(prev => prev === cardId ? null : cardId)
  }

  const editingCard = editingCardId ? cards.find(c => c.id === editingCardId) : null

  async function saveEditedPosition(cardId, ranges) {
    if (!source || !activeProject) return
    setSavingPosition(true)
    setPositionError(null)
    try {
      const params = new URLSearchParams({ project_id: activeProject.id, source_id: source.id, knowledge_card_id: cardId })
      const r = await apiFetch(`/api/source-knowledge?${params}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions: ranges }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.error || r.statusText)
      }
      const updated = await r.json()
      setDetail(prev => prev ? {
        ...prev,
        source_knowledge: (prev.source_knowledge ?? []).map(sk =>
          sk.knowledge_cards?.id === cardId ? { ...sk, positions: updated.positions } : sk
        ),
      } : prev)
      setEditingCardId(null)
    } catch (e) {
      setPositionError(String(e.message || e))
    } finally {
      setSavingPosition(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-w-0">
      <div
        className="px-3 py-2 border-b bg-white flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={onDragStart}
      >
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Source</span>
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

      {source ? (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Original text */}
          <div className="shrink-0 px-4 py-4 border-b">
            {editingCard ? (
              <div>
                <p className="text-[10px] text-gray-500 mb-1.5">
                  Editing span for <span className="font-medium text-gray-700">{editingCard.name}</span>
                </p>
                <AnnotatedSpanEditor
                  text={source.original_text}
                  positions={editingCard.positions}
                  highlightClassName="bg-yellow-200 text-yellow-900"
                  onChange={ranges => saveEditedPosition(editingCard.id, ranges)}
                  onCancel={() => { setEditingCardId(null); setPositionError(null) }}
                />
                {savingPosition && <p className="text-[10px] text-gray-400 mt-1">Saving…</p>}
                {positionError && <p className="text-[10px] text-red-500 mt-1">{positionError}</p>}
              </div>
            ) : (
              <>
                <div className="flex items-start gap-2">
                  <p className="text-sm text-gray-900 leading-relaxed flex-1 font-medium">
                    <HighlightedText
                      text={source.original_text}
                      positions={highlightedPositions}
                      onHoverIndex={setHoveredCharIndex}
                    />
                  </p>
                  <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                    <button
                      onClick={() => speak(source.original_text, activeProject?.tts_locale)}
                      title="Speak"
                      className="text-gray-400 hover:text-blue-500 transition-colors"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
                      </svg>
                    </button>
                    <button
                      onClick={() => onAppendToChat?.(source.original_text)}
                      title="Add to chat"
                      className="text-gray-400 hover:text-green-600 transition-colors"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                        <polyline points="9 10 4 15 9 20" />
                        <path d="M20 4v7a4 4 0 01-4 4H4" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="mt-2 flex items-center gap-3 text-[11px] text-gray-400">
                  {source.contexts?.name && (
                    <span className="bg-blue-50 text-blue-600 rounded px-1.5 py-0.5">
                      {source.contexts.name}
                    </span>
                  )}
                  <span>{formatDate(source.created_at)}</span>
                </div>
              </>
            )}
          </div>

          {/* Knowledge cards */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {cards.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
                  Knowledge cards ({cards.length})
                </p>
                <div className="space-y-2">
                  {displayCards.map(card => {
                    const isSelected = card.id === selectedCardId
                    const isMatchedByTextHover = isIndexInRanges(hoveredCharIndex, card.positions)
                    const isHighlighted = isSelected || card.id === hoveredCardId || isMatchedByTextHover
                    return (
                      <div
                        key={card.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleCardClick(card.id)}
                        onDoubleClick={() => onSelectCard?.(card)}
                        onMouseEnter={() => setHoveredCardId(card.id)}
                        onMouseLeave={() => setHoveredCardId(null)}
                        className={`w-full text-left border rounded-lg p-3 bg-white transition-colors cursor-pointer ${
                          isHighlighted || card.id === editingCardId
                            ? 'border-yellow-400 ring-1 ring-yellow-300'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm font-medium text-gray-800">{card.name}</span>
                          <span className={`text-[10px] rounded px-1.5 py-0.5 font-medium shrink-0 ${KIND_COLORS[card.kind] ?? 'bg-gray-100 text-gray-600'}`}>
                            {card.kind}
                          </span>
                        </div>

                        {card.tags?.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {card.tags.map(tag => (
                              <span key={tag} className="text-[10px] bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}

                        {detail && isSelected && (
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); setPositionError(null); setEditingCardId(card.id) }}
                            className="mt-1.5 text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                          >
                            {card.id === editingCardId ? 'Editing…' : 'Edit span'}
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
                {selectedCardId && (
                  <p className="text-[10px] text-gray-400 mt-2 text-center">Click card again to deselect</p>
                )}
              </div>
            )}

            {cards.length === 0 && (
              <p className="text-xs text-gray-400">No knowledge cards linked to this source.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
