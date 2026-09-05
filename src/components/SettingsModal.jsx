import { useState } from 'react'
import { useProject } from '../ProjectContext.jsx'
import { LanguagePackEditor } from './LanguagePackEditor.jsx'

const TABS = ['System prompt', 'Language pack']

export function SettingsModal({ project, tagCatalog, onClose }) {
  const { updateSystemPrompt } = useProject()
  const [tab, setTab] = useState('System prompt')
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
      <div className="bg-white rounded-xl shadow-lg max-w-4xl w-full mx-4 flex flex-col max-h-[88vh]">
        <div className="px-5 pt-5 pb-3 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-800">Settings — {project.name}</h2>
          <div className="flex gap-1 mt-3">
            {TABS.map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                  tab === t ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-500 hover:text-gray-800'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          {tab === 'System prompt' ? (
            <>
              <p className="text-xs text-amber-600 mb-2">
                Changing the system prompt affects all future conversations in this project.
              </p>
              <textarea
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-400 resize-y"
                rows={18}
                value={value}
                onChange={e => setValue(e.target.value)}
                autoFocus
              />
              {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
            </>
          ) : (
            <LanguagePackEditor project={project} tagCatalog={tagCatalog} />
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 transition-colors"
          >
            {tab === 'System prompt' ? 'Cancel' : 'Close'}
          </button>
          {tab === 'System prompt' && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-40 transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
