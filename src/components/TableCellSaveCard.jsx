import { useState, forwardRef, useImperativeHandle } from 'react'
import { apiFetch } from '../apiFetch.js'

const TableCellSaveCard = forwardRef(function TableCellSaveCard({ record, saveState = { status: 'idle' }, blocked, tableName, tableId, onSaved, projectId }, ref) {
  const [skill, setSkill] = useState(record.skill ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState(null)

  const isSaved = saveState.status === 'saved'
  const isDisabled = isSaving || isSaved || blocked

  const axisValues = record.axis_values ?? {}
  const axisChips = Object.entries(axisValues).map(([axis, val]) => `${axis}: ${val}`)

  async function handleSave() {
    if (blocked) return
    setIsSaving(true)
    setError(null)
    try {
      const skillVal = skill !== '' ? Number(skill) : null
      const rec = { table_id: tableId, axis_values: axisValues, ...(skillVal != null ? { skill: skillVal } : {}) }
      const res = await apiFetch('/api/save', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, table: 'table_cell', record: rec }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      onSaved?.(data.id, data.cell_key)
    } catch (err) {
      setError(err.message)
    } finally {
      setIsSaving(false)
    }
  }

  useImperativeHandle(ref, () => ({ save: handleSave }))

  return (
    <div className="border border-purple-100 rounded-xl bg-purple-50/60 p-3 space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-purple-500 uppercase tracking-wide">
          Cell {tableName ? <span className="font-normal normal-case">— {tableName}</span> : null}
        </span>
        <button
          onClick={handleSave}
          disabled={isDisabled}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            isSaved
              ? 'bg-green-500 text-white cursor-default'
              : blocked
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : isSaving
                  ? 'bg-purple-300 text-white cursor-not-allowed'
                  : 'bg-purple-500 text-white hover:bg-purple-600'
          }`}
        >
          {isSaved ? 'Saved' : blocked ? 'Save table first' : isSaving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div className="flex flex-wrap gap-1">
        {axisChips.map(chip => (
          <span key={chip} className="px-2 py-0.5 rounded-full text-xs bg-purple-100 text-purple-800 font-mono">{chip}</span>
        ))}
      </div>

      <div>
        <label className="block text-xs mb-0.5 text-gray-500">skill</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={10}
            value={skill !== '' ? skill : 0}
            onChange={e => setSkill(e.target.value)}
            disabled={isSaved || blocked}
            className="flex-1 accent-purple-500"
          />
          <span className="text-xs font-mono w-4 text-center">{skill !== '' ? skill : '–'}</span>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-500">{error}</p>
      )}
    </div>
  )
})

export default TableCellSaveCard
