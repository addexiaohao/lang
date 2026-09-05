import { useState } from 'react'
import { DebugNotesPanel } from '../panels/DebugNotesPanel.jsx'
import { McClozeFailuresPanel } from '../panels/McClozeFailuresPanel.jsx'

// Debug mode: a dev/self-use audit view, not an entity to browse. Two sub-parts, switched by a
// plain tab strip (not Library's resizable multi-panel layout — there's nothing here that makes
// sense to view side by side): every practice_note (CLAUDE.md "user debug notes" via
// api/practice-note.js) with the question it was taken against, and every mc_cloze_check_failure
// with its full generation context. Mounted always (App.jsx's mode convention) with both
// sub-panels also always-mounted underneath, so switching tabs never loses scroll/pagination state.
const DEBUG_TABS = [
  { id: 'notes', label: 'Notes' },
  { id: 'mcloze', label: 'MC-cloze failures' },
]

export function DebugMode({ activeProject }) {
  const [tab, setTab] = useState('notes')

  return (
    <div className="h-full w-full flex flex-col bg-white overflow-hidden">
      <div className="flex items-center gap-1 px-4 pt-2 border-b border-gray-200 shrink-0">
        {DEBUG_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 relative">
        <div style={{ display: tab === 'notes' ? 'block' : 'none' }} className="absolute inset-0">
          <DebugNotesPanel activeProject={activeProject} />
        </div>
        <div style={{ display: tab === 'mcloze' ? 'block' : 'none' }} className="absolute inset-0">
          <McClozeFailuresPanel activeProject={activeProject} />
        </div>
      </div>
    </div>
  )
}
