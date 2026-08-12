import { useState } from 'react'
import { useProject } from '../ProjectContext.jsx'

export function SettingsModal({ project, onClose }) {
  const { updateSystemPrompt } = useProject()
  const [value, setValue] = useState(project?.system_prompt ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await updateSystemPrompt(project.id, value)
      onClose()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="bg-white rounded-xl shadow-lg max-w-2xl w-full mx-4 p-5">
        <h2 className="text-base font-semibold text-gray-800 mb-1">
          Settings — {project.name}
        </h2>
        <p className="text-xs text-amber-600 mb-3">
          Changing the system prompt affects all future conversations in this project.
        </p>
        <textarea
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
          rows={14}
          value={value}
          onChange={e => setValue(e.target.value)}
          autoFocus
        />
        {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
        <div className="flex justify-end gap-2 mt-3">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-40 transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
