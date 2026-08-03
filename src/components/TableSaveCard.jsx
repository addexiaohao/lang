import { useState, forwardRef, useImperativeHandle } from 'react'
import { apiFetch } from '../apiFetch.js'

const TableSaveCard = forwardRef(function TableSaveCard({ record, saveState = { status: 'idle' }, existingId, onSaved, projectId }, ref) {
  const [name, setName] = useState(record.name ?? '')
  const [notes, setNotes] = useState(record.notes ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState(null)

  const isSaved = saveState.status === 'saved'

  async function handleSave() {
    if (existingId) {
      onSaved?.(existingId, name)
      return
    }
    setIsSaving(true)
    setError(null)
    try {
      const body = { name, axes: record.axes, axis_values: record.axis_values, tags: record.tags ?? [], notes: notes || undefined }
      const res = await apiFetch('/api/save', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, table: 'table', record: body }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      onSaved?.(data.id, data.name)
    } catch (err) {
      setError(err.message)
    } finally {
      setIsSaving(false)
    }
  }

  useImperativeHandle(ref, () => ({ save: handleSave }))

  const axes = Array.isArray(record.axes) ? record.axes : []
  const axisValues = record.axis_values ?? {}

  return (
    <div className="border border-purple-200 rounded-xl bg-purple-50 p-3 space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-purple-600 uppercase tracking-wide">Table</span>
        <button
          onClick={handleSave}
          disabled={isSaving || isSaved}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            isSaved
              ? 'bg-green-500 text-white cursor-default'
              : existingId
                ? 'bg-gray-300 text-gray-500 cursor-default'
                : isSaving
                  ? 'bg-purple-300 text-white cursor-not-allowed'
                  : 'bg-purple-500 text-white hover:bg-purple-600'
          }`}
        >
          {isSaved ? 'Saved' : existingId ? 'Already exists' : isSaving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {existingId && (
        <div className="rounded-md bg-yellow-50 border border-yellow-200 px-2 py-1.5">
          <p className="text-xs text-yellow-700">Using existing table — cells will still be saved.</p>
        </div>
      )}

      <div>
        <label className="block text-xs mb-0.5 text-gray-500">name</label>
        <input
          className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-purple-400"
          value={name}
          onChange={e => setName(e.target.value)}
          disabled={isSaved}
        />
      </div>

      <div>
        <label className="block text-xs mb-0.5 text-gray-500">axes</label>
        <div className="flex flex-wrap gap-1">
          {axes.map(axis => (
            <span key={axis} className="px-2 py-0.5 rounded-full text-xs bg-purple-100 text-purple-800 font-mono">
              {axis}: {(axisValues[axis] ?? []).join(', ')}
            </span>
          ))}
        </div>
      </div>

      {record.tags?.length > 0 && (
        <div>
          <label className="block text-xs mb-0.5 text-gray-500">tags</label>
          <div className="flex flex-wrap gap-1">
            {record.tags.map(tag => (
              <span key={tag} className="px-2 py-0.5 rounded-full text-xs bg-purple-100 text-purple-700">{tag}</span>
            ))}
          </div>
        </div>
      )}

      <div>
        <label className="block text-xs mb-0.5 text-gray-500">notes</label>
        <input
          className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-purple-400"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          disabled={isSaved}
          placeholder="(optional)"
        />
      </div>

      {error && (
        <p className="text-xs text-red-500">{error}</p>
      )}
    </div>
  )
})

export default TableSaveCard
