import { useState, useEffect } from 'react'
import { apiFetch } from '../../apiFetch.js'
import GermanText from '../GermanText.jsx'

const PAGE_SIZE = 25

const KIND_COLORS = {
  vocabulary: 'bg-green-100 text-green-700',
  grammar: 'bg-purple-100 text-purple-700',
  expression: 'bg-orange-100 text-orange-700',
}

function relativeTime(iso) {
  if (!iso) return ''
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function inferItemMode(item) {
  if (!item) return null
  if (Array.isArray(item.options)) return 'mc_cloze'
  if (item.target_span) return 'exemplar'
  if (item.meaning !== undefined) return 'spelling'
  return null
}

// A neutral (no right/wrong coloring — a note isn't an attempt outcome) reproduction of whatever
// practice item was on screen when the note was taken, same visual language as SkillsPanel.jsx's
// ReviewMcCloze/Spelling/Exemplar.
function QuestionView({ item }) {
  const mode = inferItemMode(item)
  if (!mode) return <pre className="text-[10px] text-gray-500 bg-gray-50 border border-gray-200 rounded p-2 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(item, null, 2)}</pre>

  if (mode === 'mc_cloze') {
    const [before, after] = item.sentence.split('___')
    return (
      <div className="space-y-2">
        <p className="text-sm leading-relaxed text-gray-800">
          <GermanText>{before}</GermanText>
          <span className="inline-block mx-1 px-2 py-0.5 rounded border-b-2 border-blue-500 bg-blue-50 text-blue-700 font-medium">{item.answer}</span>
          <GermanText>{after}</GermanText>
        </p>
        <div className="space-y-1">
          {item.options.map(opt => (
            <div key={opt} className={`px-2 py-1 rounded border text-xs ${opt === item.answer ? 'border-blue-400 bg-blue-50 text-blue-800' : 'border-gray-200 text-gray-400'}`}>
              {opt}
            </div>
          ))}
        </div>
        {item.translation && <p className="text-xs text-gray-500 italic">{item.translation}</p>}
      </div>
    )
  }

  if (mode === 'spelling') {
    const [before, after] = item.sentence.split('___')
    return (
      <div className="space-y-1">
        <p className="text-sm leading-relaxed text-gray-800">
          <GermanText>{before}</GermanText>
          <span className="inline-block mx-1 px-2 py-0.5 rounded border-b-2 border-blue-500 bg-blue-50 text-blue-700 font-medium">{item.answer}</span>
          <GermanText>{after}</GermanText>
        </p>
        <p className="text-xs text-gray-500 italic">{item.meaning}</p>
        {item.translation && <p className="text-xs text-gray-400 italic">{item.translation}</p>}
      </div>
    )
  }

  // exemplar
  const positions = item.target_span ? [{ start: item.target_span[0], end: item.target_span[1] }] : []
  return (
    <div className="space-y-1">
      <p className="text-sm leading-relaxed text-gray-800">
        <GermanText positions={positions} highlightClassName="bg-transparent underline decoration-2 decoration-blue-500 font-semibold">
          {item.sentence}
        </GermanText>
      </p>
      {item.translation && <p className="text-xs text-gray-500 italic">{item.translation}</p>}
    </div>
  )
}

function NoteRow({ note }) {
  const [showQuestion, setShowQuestion] = useState(false)
  return (
    <div className="border-b border-gray-100 px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap mb-1.5">
        {note.card && (
          <span className={`text-[10px] font-medium rounded px-1.5 py-0.5 ${KIND_COLORS[note.card.kind] ?? 'bg-gray-100 text-gray-600'}`}>
            {note.card.kind}
          </span>
        )}
        <span className="text-sm font-medium text-gray-800">{note.card?.name ?? 'Unknown card'}</span>
        {note.skill_type && <span className="text-xs text-gray-400">· {note.skill_type}</span>}
        <span className="text-[10px] text-gray-400 ml-auto shrink-0">{relativeTime(note.created_at)}</span>
      </div>
      <p className="text-sm text-gray-800 whitespace-pre-wrap mb-1.5">{note.note}</p>
      <button
        onClick={() => setShowQuestion(v => !v)}
        className="text-[10px] text-blue-600 hover:text-blue-800 transition-colors"
      >
        {showQuestion ? 'Hide question' : 'Show question'}
      </button>
      {showQuestion && (
        <div className="mt-2 bg-gray-50 border border-gray-200 rounded p-2.5">
          <QuestionView item={note.question} />
        </div>
      )}
    </div>
  )
}

// Lists practice_note rows (see api/practice-note.js/api/debug-notes.js) — dev/self-use scratch
// notes taken against whatever practice question was on screen. Debug mode's "Notes" sub-panel.
export function DebugNotesPanel({ activeProject }) {
  const [notes, setNotes] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!activeProject) return
    setLoading(true)
    setError(null)
    apiFetch(`/api/debug-notes?project_id=${activeProject.id}&limit=${PAGE_SIZE}&offset=0`)
      .then(r => { if (!r.ok) throw new Error('Failed to load notes'); return r.json() })
      .then(data => { setNotes(data.notes); setTotal(data.total) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [activeProject?.id])

  async function loadMore() {
    if (loadingMore || notes.length >= total) return
    setLoadingMore(true)
    try {
      const res = await apiFetch(`/api/debug-notes?project_id=${activeProject.id}&limit=${PAGE_SIZE}&offset=${notes.length}`)
      if (!res.ok) throw new Error('Failed to load notes')
      const data = await res.json()
      setNotes(prev => [...prev, ...data.notes])
      setTotal(data.total)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        {loading && <p className="text-sm text-gray-400 p-4">Loading…</p>}
        {error && <p className="text-sm text-red-600 p-4">{error}</p>}
        {!loading && !error && notes.length === 0 && (
          <p className="text-sm text-gray-400 p-4">No debug notes yet — add one from a practice question via "Add note".</p>
        )}
        {notes.map(note => <NoteRow key={note.id} note={note} />)}
        {!loading && notes.length < total && (
          <div className="p-3 text-center">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50 transition-colors"
            >
              {loadingMore ? 'Loading…' : `Load more (${notes.length} of ${total})`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
