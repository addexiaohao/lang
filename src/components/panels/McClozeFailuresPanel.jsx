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

// Fills the item's "___" blank with a given option, same idea as lib/mcClozeCheck.js's
// fillBlank — used here purely for display, to show exactly the sentence the checker judged.
function fillBlank(sentence, option) {
  return sentence.replace('___', option)
}

// A single collapsed/expandable section — used to nest the conversation JSON (generation
// request/response, each check's own request/response) instead of dumping it all as one flat
// blob, since `conversation` is itself a JSON object containing a list of JSON check entries.
function Collapsible({ label, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-gray-200 rounded">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
          className={`w-2.5 h-2.5 text-gray-400 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        {label}
      </button>
      {open && <div className="border-t border-gray-200 p-2">{children}</div>}
    </div>
  )
}

function JsonBlock({ value }) {
  return (
    <pre className="text-sm text-gray-700 bg-gray-50 rounded p-2 overflow-x-auto max-h-[28rem] whitespace-pre-wrap">
      {JSON.stringify(value ?? null, null, 2)}
    </pre>
  )
}

// `conversation` (lib/mcClozeCheckLog.js): { generation: { request, response }, checks: [{ option,
// isAnswer, sentence, request, response, grammatical, sensible, reason }, ...] }. Rendered as
// nested collapsibles rather than one JSON.stringify dump, so a specific request/response can be
// opened without scrolling past every other one.
function ConversationView({ conversation }) {
  if (!conversation) return <p className="text-xs text-gray-400">No conversation recorded.</p>
  const { generation, checks } = conversation
  return (
    <div className="space-y-2">
      <Collapsible label="Generation">
        <div className="space-y-2">
          <Collapsible label="Request"><JsonBlock value={generation?.request} /></Collapsible>
          <Collapsible label="Response"><JsonBlock value={generation?.response} /></Collapsible>
        </div>
      </Collapsible>
      {Array.isArray(checks) && checks.length > 0 && (
        <Collapsible label={`Checks (${checks.length})`}>
          <div className="space-y-2">
            {checks.map((c, i) => (
              <Collapsible
                key={i}
                label={`${c.option}${c.isAnswer ? ' (answer)' : ''} — ${c.grammatical && c.sensible ? 'passed' : 'flagged'}`}
              >
                <div className="space-y-2">
                  {c.reason && <p className="text-xs text-gray-600 italic">{c.reason}</p>}
                  <Collapsible label="Request"><JsonBlock value={c.request} /></Collapsible>
                  <Collapsible label="Response"><JsonBlock value={c.response} /></Collapsible>
                </div>
              </Collapsible>
            ))}
          </div>
        </Collapsible>
      )}
    </div>
  )
}

function FailureRow({ failure }) {
  const [showConversation, setShowConversation] = useState(false)
  // offending_sentences/reasons are parallel arrays (CLAUDE.md's "mc_cloze answer-uniqueness
  // check"): the answer's filled-in sentence first (if IT failed), then any distractor's
  // filled-in sentence that was wrongly judged both grammatical and sensible.
  const offenders = (failure.offending_sentences ?? []).map((sentence, i) => ({
    sentence,
    reason: failure.reasons?.[i] ?? null,
    isAnswer: sentence === fillBlank(failure.sentence, failure.answer),
  }))

  return (
    <div className="border-b border-gray-100 px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        {failure.card && (
          <span className={`text-[10px] font-medium rounded px-1.5 py-0.5 ${KIND_COLORS[failure.card.kind] ?? 'bg-gray-100 text-gray-600'}`}>
            {failure.card.kind}
          </span>
        )}
        <span className="text-sm font-medium text-gray-800">{failure.card?.name ?? 'Unknown card'}</span>
        {failure.skill_type && <span className="text-xs text-gray-400">· {failure.skill_type}</span>}
        {failure.model && <span className="text-[10px] text-gray-300">· {failure.model}</span>}
        <span className="text-[10px] text-gray-400 ml-auto shrink-0">{relativeTime(failure.created_at)}</span>
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded p-2.5 mb-2">
        <p className="text-sm leading-relaxed text-gray-800 mb-2">
          <GermanText>{failure.sentence}</GermanText>
        </p>
        <div className="space-y-1">
          {(failure.options ?? []).map(opt => (
            <div key={opt} className={`px-2 py-1 rounded border text-xs ${opt === failure.answer ? 'border-green-400 bg-green-50 text-green-800' : 'border-gray-200 text-gray-500'}`}>
              {opt}{opt === failure.answer && <span className="ml-1.5 text-[10px] text-green-600">(intended answer)</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-1.5 mb-2">
        <p className="text-[10px] font-medium text-amber-700 uppercase tracking-wide">Checker verdicts</p>
        {offenders.length === 0 && <p className="text-xs text-gray-400">No offending sentences recorded.</p>}
        {offenders.map((o, i) => (
          <div key={i} className="text-xs bg-amber-50 border border-amber-100 rounded p-2">
            <p className="text-gray-800 mb-0.5">
              <GermanText>{o.sentence}</GermanText>
              {o.isAnswer && <span className="ml-1.5 text-[10px] text-gray-500">(intended answer)</span>}
            </p>
            <p className="text-amber-800 italic">{o.reason ?? '(no reason recorded)'}</p>
          </div>
        ))}
      </div>

      <button
        onClick={() => setShowConversation(v => !v)}
        className="text-[10px] text-blue-600 hover:text-blue-800 transition-colors"
      >
        {showConversation ? 'Hide full conversation' : 'Show full conversation'}
      </button>
      {showConversation && (
        <div className="mt-2">
          <ConversationView conversation={failure.conversation} />
        </div>
      )}
    </div>
  )
}

// Lists mc_cloze_check_failure rows (lib/mcClozeCheckLog.js) — a failures-only audit log of the
// mc_cloze answer-uniqueness check (CLAUDE.md's "Practice generation"). Debug mode's "MC-cloze
// failures" sub-panel.
export function McClozeFailuresPanel({ activeProject }) {
  const [failures, setFailures] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!activeProject) return
    setLoading(true)
    setError(null)
    apiFetch(`/api/mc-cloze-failures?project_id=${activeProject.id}&limit=${PAGE_SIZE}&offset=0`)
      .then(r => { if (!r.ok) throw new Error('Failed to load failures'); return r.json() })
      .then(data => { setFailures(data.failures); setTotal(data.total) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [activeProject?.id])

  async function loadMore() {
    if (loadingMore || failures.length >= total) return
    setLoadingMore(true)
    try {
      const res = await apiFetch(`/api/mc-cloze-failures?project_id=${activeProject.id}&limit=${PAGE_SIZE}&offset=${failures.length}`)
      if (!res.ok) throw new Error('Failed to load failures')
      const data = await res.json()
      setFailures(prev => [...prev, ...data.failures])
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
        {!loading && !error && failures.length === 0 && (
          <p className="text-sm text-gray-400 p-4">No mc_cloze check failures logged — a clean check leaves no trace.</p>
        )}
        {failures.map(f => <FailureRow key={f.id} failure={f} />)}
        {!loading && failures.length < total && (
          <div className="p-3 text-center">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50 transition-colors"
            >
              {loadingMore ? 'Loading…' : `Load more (${failures.length} of ${total})`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
