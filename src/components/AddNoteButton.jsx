import { useState } from 'react'

// "Add note" control for a practice question — a dev/self-use scratch note (see
// api/practice-note.js), unrelated to right/wrong/level. Self-contained: owns its own
// open/text/saving state so PracticeMcCloze/PracticeSpelling/PracticeExemplar can each drop it
// into their footer without duplicating that logic. `onSave(text)` is expected to return a
// promise that resolves once the note is persisted.
export default function AddNoteButton({ onSave }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  function cancel() {
    setOpen(false)
    setText('')
    setError(null)
  }

  async function save() {
    if (!text.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      await onSave(text.trim())
      setText('')
      setOpen(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(e.message || 'Failed to save note')
    } finally {
      setSaving(false)
    }
  }

  if (open) {
    return (
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel() }}
          autoFocus
          placeholder="Note to self…"
          className="text-xs px-1.5 py-0.5 rounded border border-gray-300 focus:outline-none focus:border-blue-400 w-40"
        />
        <button
          onClick={save}
          disabled={!text.trim() || saving}
          className="text-xs text-blue-600 hover:text-blue-700 disabled:opacity-40 transition-colors"
        >
          {saving ? '…' : 'Save'}
        </button>
        <button onClick={cancel} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
          Cancel
        </button>
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    )
  }

  return (
    <button
      onClick={() => setOpen(true)}
      className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
    >
      {saved ? 'Noted ✓' : 'Add note'}
    </button>
  )
}
