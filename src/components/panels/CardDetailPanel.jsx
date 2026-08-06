import { useState, useEffect } from 'react'
import { apiFetch } from '../../apiFetch.js'
import { speak } from '../../tts.js'

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

const KIND_COLORS = {
  vocabulary: 'bg-green-100 text-green-700',
  grammar: 'bg-purple-100 text-purple-700',
  expression: 'bg-orange-100 text-orange-700',
  table: 'bg-blue-100 text-blue-700',
}

export function CardDetailPanel({ card, activeProject, onClose, onAppendToChat, onDragStart, onSelectTag }) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [savingImportance, setSavingImportance] = useState(false)

  useEffect(() => {
    if (!card || !activeProject) return
    setDetail(null)
    setLoading(true)
    setError(null)
    apiFetch(`/api/knowledge-cards?project_id=${activeProject.id}&id=${card.id}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(setDetail)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [card?.id, activeProject?.id])

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

  const sources = detail?.source_knowledge
    ?.map(sk => sk.sources ? { ...sk.sources, positions: sk.positions ?? [] } : null)
    .filter(Boolean) ?? []

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
              <h2 className="text-sm font-semibold text-gray-900 flex-1 leading-snug">{card.name}</h2>
              <span className={`text-[10px] rounded px-1.5 py-0.5 font-medium shrink-0 ${KIND_COLORS[card.kind] ?? 'bg-gray-100 text-gray-600'}`}>
                {card.kind}
              </span>
            </div>

            {card.tags?.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {card.tags.map(tag => (
                  <button
                    key={tag}
                    onClick={() => onSelectTag?.(tag)}
                    className="text-[10px] bg-gray-100 text-gray-500 hover:bg-gray-200 rounded px-1.5 py-0.5 transition-colors"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center gap-4 mt-3">
              {card.skill != null && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-gray-400">Skill</span>
                  <div className="flex gap-0.5">
                    {Array.from({ length: 10 }, (_, i) => (
                      <div key={i} className={`w-2 h-2 rounded-sm ${i < card.skill ? 'bg-blue-500' : 'bg-gray-200'}`} />
                    ))}
                  </div>
                  <span className="text-[10px] text-gray-500">{card.skill}/10</span>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-gray-400">Importance</span>
                <div className="flex gap-0.5">
                  {Array.from({ length: 10 }, (_, i) => {
                    const value = i + 1
                    const filled = importance != null && value <= importance
                    return (
                      <button
                        key={value}
                        onClick={() => updateImportance(value)}
                        disabled={savingImportance}
                        title={`Set importance to ${value}`}
                        className={`w-2 h-2 rounded-sm transition-colors disabled:cursor-wait ${filled ? 'bg-amber-500' : 'bg-gray-200 hover:bg-amber-200'}`}
                      />
                    )
                  })}
                </div>
                <span className="text-[10px] text-gray-500">{importance != null ? `${importance}/10` : '—'}</span>
              </div>
            </div>
          </div>

          {/* Table axes */}
          {detail?.axes?.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Axes</p>
              <div className="space-y-1">
                {detail.axes.map(axis => (
                  <div key={axis.name} className="text-xs text-gray-600">
                    <span className="font-medium">{axis.name}:</span>{' '}
                    <span className="text-gray-500">{axis.values.join(', ')}</span>
                  </div>
                ))}
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
                    <p className="text-xs text-gray-800 leading-snug flex-1 font-medium">
                      <HighlightedText text={source.original_text} positions={source.positions} />
                    </p>
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
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
