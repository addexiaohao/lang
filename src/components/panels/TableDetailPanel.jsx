import { useState, useEffect } from 'react'
import { apiFetch } from '../../apiFetch.js'
import { speak } from '../../tts.js'

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

// Mirrors deriveCellKey in api/save.js / lib server-side logic — canonical, sorted-by-axis,
// slugified key used to look up a cell's row within a table's cell list.
function cellKeyFor(axisValues) {
  return Object.keys(axisValues)
    .sort()
    .map(k => String(axisValues[k]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .join('-')
}

// Cartesian product of { axis, values }[] -> array of partial axis_values objects.
function cartesian(axisList) {
  return axisList.reduce((acc, { axis, values }) => {
    const next = []
    for (const combo of acc) for (const v of values ?? []) next.push({ ...combo, [axis]: v })
    return next
  }, [{}])
}

function skillColor(skill) {
  if (skill == null) return 'bg-gray-50 text-gray-300 border-gray-100'
  if (skill <= 3) return 'bg-red-50 text-red-700 border-red-200'
  if (skill <= 6) return 'bg-amber-50 text-amber-700 border-amber-200'
  return 'bg-green-50 text-green-700 border-green-200'
}

export function TableDetailPanel({ table, activeProject, onClose, onAppendToChat, onDragStart, onSelectTag }) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [selectedCellKey, setSelectedCellKey] = useState(null)
  const [savingSkill, setSavingSkill] = useState(false)

  useEffect(() => {
    if (!table || !activeProject) return
    setDetail(null)
    setSelectedCellKey(null)
    setLoading(true)
    setError(null)
    apiFetch(`/api/tables?project_id=${activeProject.id}&id=${table.id}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(setDetail)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [table?.id, activeProject?.id])

  const cellsByKey = new Map((detail?.table_cells ?? []).map(c => [c.cell_key, c]))
  const selectedCell = selectedCellKey ? cellsByKey.get(selectedCellKey) : null

  async function updateSkill(value) {
    if (!selectedCell || !activeProject) return
    setSavingSkill(true)
    try {
      const r = await apiFetch(`/api/tables?project_id=${activeProject.id}&cell_id=${selectedCell.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill: value }),
      })
      if (!r.ok) throw new Error(r.statusText)
      const updated = await r.json()
      setDetail(prev => prev ? {
        ...prev,
        table_cells: prev.table_cells.map(c => c.id === updated.id ? { ...c, skill: updated.skill } : c),
      } : prev)
    } catch (e) {
      setError(String(e))
    } finally {
      setSavingSkill(false)
    }
  }

  const axes = detail?.axes ?? []
  const axisValues = detail?.axis_values ?? {}
  const rowAxis = axes[0]
  const colAxis = axes[1]
  const extraAxes = axes.slice(2)
  const extraCombos = extraAxes.length > 0
    ? cartesian(extraAxes.map(a => ({ axis: a, values: axisValues[a] })))
    : [{}]

  return (
    <div className="flex flex-col h-full min-w-0">
      <div
        className="px-3 py-2 border-b bg-white flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={onDragStart}
      >
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Table</span>
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

      {!table ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-gray-400">Select a table</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 leading-snug">{table.name}</h2>
            {detail?.tags?.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {detail.tags.map(tag => (
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
            {detail?.notes && (
              <p className="text-xs text-gray-500 mt-2 leading-relaxed">{detail.notes}</p>
            )}
          </div>

          {loading && <p className="text-xs text-gray-400">Loading…</p>}
          {error && <p className="text-xs text-red-500">{error}</p>}

          {detail && (
            <div className="space-y-4">
              {extraCombos.map((extra, ei) => (
                <div key={ei}>
                  {extraAxes.length > 0 && (
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
                      {extraAxes.map(a => extra[a]).join(' · ')}
                    </p>
                  )}
                  <div className="overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="text-xs w-full border-collapse">
                      {colAxis && (
                        <thead>
                          <tr>
                            <th className="p-1.5 bg-gray-50 border-b border-r border-gray-200 text-left font-medium text-gray-400">{rowAxis} \ {colAxis}</th>
                            {(axisValues[colAxis] ?? []).map(cv => (
                              <th key={cv} className="p-1.5 bg-gray-50 border-b border-gray-200 font-medium text-gray-500">{cv}</th>
                            ))}
                          </tr>
                        </thead>
                      )}
                      <tbody>
                        {(axisValues[rowAxis] ?? []).map(rv => (
                          <tr key={rv}>
                            <td className="p-1.5 bg-gray-50 border-r border-b border-gray-200 font-medium text-gray-500 whitespace-nowrap">{rv}</td>
                            {colAxis ? (axisValues[colAxis] ?? []).map(cv => {
                              const values = { ...extra, [rowAxis]: rv, [colAxis]: cv }
                              const key = cellKeyFor(values)
                              const cell = cellsByKey.get(key)
                              return (
                                <td key={cv} className="border-b border-gray-100 p-0.5">
                                  <button
                                    onClick={() => setSelectedCellKey(key)}
                                    className={`w-full h-full min-h-[2rem] rounded border px-1.5 py-1 transition-colors ${skillColor(cell?.skill)} ${
                                      selectedCellKey === key ? 'ring-2 ring-blue-400' : 'hover:brightness-95'
                                    }`}
                                  >
                                    {cell ? (cell.skill ?? '·') : ''}
                                  </button>
                                </td>
                              )
                            }) : (
                              <td className="border-b border-gray-100 p-0.5">
                                {(() => {
                                  const values = { ...extra, [rowAxis]: rv }
                                  const key = cellKeyFor(values)
                                  const cell = cellsByKey.get(key)
                                  return (
                                    <button
                                      onClick={() => setSelectedCellKey(key)}
                                      className={`w-full h-full min-h-[2rem] rounded border px-1.5 py-1 transition-colors ${skillColor(cell?.skill)} ${
                                        selectedCellKey === key ? 'ring-2 ring-blue-400' : 'hover:brightness-95'
                                      }`}
                                    >
                                      {cell ? (cell.skill ?? '·') : ''}
                                    </button>
                                  )
                                })()}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Selected cell detail */}
          {selectedCellKey && (
            <div className="border-t pt-4">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
                Cell — {Object.entries(selectedCell?.axis_values ?? {}).map(([a, v]) => `${a}: ${v}`).join(', ')}
              </p>

              {!selectedCell ? (
                <p className="text-xs text-gray-400">Never encountered — no cell recorded yet.</p>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 mb-3">
                    <span className="text-[10px] text-gray-400">Skill</span>
                    <div className="flex gap-0.5">
                      {Array.from({ length: 11 }, (_, i) => (
                        <button
                          key={i}
                          onClick={() => updateSkill(i)}
                          disabled={savingSkill}
                          title={`Set skill to ${i}`}
                          className={`w-2 h-2 rounded-sm transition-colors disabled:cursor-wait ${
                            selectedCell.skill != null && i <= selectedCell.skill ? 'bg-blue-500' : 'bg-gray-200 hover:bg-blue-200'
                          }`}
                        />
                      ))}
                    </div>
                    <span className="text-[10px] text-gray-500">{selectedCell.skill != null ? `${selectedCell.skill}/10` : '—'}</span>
                  </div>

                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    Sources ({selectedCell.source_table_cells?.length ?? 0})
                  </p>
                  {(!selectedCell.source_table_cells || selectedCell.source_table_cells.length === 0) && (
                    <p className="text-xs text-gray-400">No sources linked.</p>
                  )}
                  <div className="space-y-2">
                    {(selectedCell.source_table_cells ?? []).map((link, i) => (
                      <div key={i} className="border border-gray-200 rounded-lg p-3 bg-white">
                        <div className="flex items-start gap-2">
                          <p className="text-xs text-gray-800 leading-snug flex-1 font-medium">
                            {link.sources?.original_text}
                          </p>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => speak(link.sources?.original_text, activeProject?.tts_locale)}
                              title="Speak"
                              className="text-gray-400 hover:text-blue-500 transition-colors"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
                              </svg>
                            </button>
                            <button
                              onClick={() => onAppendToChat?.(link.sources?.original_text)}
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
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          {link.excerpt && (
                            <span className="text-[10px] font-mono bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">{link.excerpt}</span>
                          )}
                          {link.sources?.contexts?.name && (
                            <span className="text-[10px] bg-blue-50 text-blue-600 rounded px-1.5 py-0.5">{link.sources.contexts.name}</span>
                          )}
                          {link.sources?.created_at && (
                            <span className="text-[10px] text-gray-400">{formatDate(link.sources.created_at)}</span>
                          )}
                        </div>
                        {link.note && <p className="text-[11px] text-gray-500 mt-1.5">{link.note}</p>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
