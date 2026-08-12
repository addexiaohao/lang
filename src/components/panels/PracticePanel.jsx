import { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../../apiFetch.js'
import PracticeMcCloze from '../PracticeMcCloze.jsx'
import PracticeExemplar from '../PracticeExemplar.jsx'
import PracticeExplain from '../PracticeExplain.jsx'
import { ChatPanel } from './ChatPanel.jsx'

// Runs an ephemeral practice session over `practiceSession.cards` in `practiceSession.mode`.
// Nothing here persists — reload or close and the session is gone, by design (see CLAUDE.md /
// practice-prototype-plan.md hard constraints).
export function PracticePanel({ activeProject, practiceSession, onDragStart, onClose, onSidePanelCountChange, generatedContext, tagCatalog, onNewTags }) {
  const { cards, mode } = practiceSession
  const [index, setIndex] = useState(0)
  const [current, setCurrent] = useState(null)
  const [avoid, setAvoid] = useState([])
  const [sentenceCount, setSentenceCount] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [finished, setFinished] = useState(false)
  // Two independent docked side panels — the "Why?"/"Explain" thread and the "Add source" chat —
  // can be open together, each its own column (see render below).
  const [explain, setExplain] = useState(null) // { suggestion, context } | null
  const [addSource, setAddSource] = useState(null) // { sentence } | null

  // Reports how many side panels are open (0/1/2) so PracticeMode.jsx can widen the box to fit
  // them — a plain effect rather than calling this at every setExplain/setAddSource call site,
  // since batched updates (e.g. advance() closing both at once) would otherwise report transient,
  // stale-closure intermediate counts.
  useEffect(() => {
    onSidePanelCountChange?.((explain ? 1 : 0) + (addSource ? 1 : 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explain, addSource])

  // While item n is on screen, prefetch.same (exemplar "Another sentence") and/or prefetch.next
  // (the following card) are requested in the background — that's the whole latency strategy.
  const prefetchRef = useRef({})
  const sessionKeyRef = useRef(0)

  const card = cards[index]

  const requestItem = useCallback(async (targetCard, avoidList) => {
    const res = await apiFetch('/api/practice', {
      method: 'POST',
      body: JSON.stringify({ project_id: activeProject.id, card_id: targetCard.id, mode, avoid: avoidList }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || 'Failed to generate item')
    // body.request is the exact { model, system, messages } api/practice.js sent to Anthropic —
    // the client only ever sends a card_id/mode/avoid, so this is the only place the real prompt
    // text (card context, task instructions) is visible; log that, not the request we made.
    console.log('[LLM request]', JSON.stringify(body.request, null, 2))
    console.log('[LLM response]', JSON.stringify(body.item, null, 2))
    return body.item
  }, [activeProject?.id, mode])

  const loadCurrent = useCallback(async (targetIndex, avoidList) => {
    setLoading(true)
    setError(null)
    const mySession = sessionKeyRef.current
    try {
      const item = await requestItem(cards[targetIndex], avoidList)
      if (sessionKeyRef.current !== mySession) return
      setCurrent(item)
    } catch (e) {
      if (sessionKeyRef.current !== mySession) return
      setError(e.message)
      setCurrent(null)
    } finally {
      if (sessionKeyRef.current === mySession) setLoading(false)
    }
  }, [cards, requestItem])

  // (Re)start whenever a new session is handed in (new selection, or "Practice again").
  useEffect(() => {
    sessionKeyRef.current += 1
    prefetchRef.current = {}
    setIndex(0)
    setAvoid([])
    setSentenceCount(1)
    setFinished(false)
    setCurrent(null)
    setExplain(null)
    setAddSource(null)
    loadCurrent(0, [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [practiceSession])

  // Prefetch the likely next request(s) while the current item is being looked at.
  useEffect(() => {
    if (!current || finished) return
    if (mode === 'exemplar') {
      prefetchRef.current.same = requestItem(card, [...avoid, current.sense_key]).catch(e => ({ __error: e.message }))
    }
    const nextIndex = index + 1
    if (nextIndex < cards.length) {
      prefetchRef.current.next = requestItem(cards[nextIndex], []).catch(e => ({ __error: e.message }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  async function resolvePrefetch(p) {
    if (!p) return null
    const result = await p
    return result?.__error ? null : result
  }

  async function advance() {
    setExplain(null)
    setAddSource(null)
    const nextIndex = index + 1
    if (nextIndex >= cards.length) {
      setFinished(true)
      return
    }
    const prefetched = await resolvePrefetch(prefetchRef.current.next)
    prefetchRef.current = {}
    setIndex(nextIndex)
    setAvoid([])
    setSentenceCount(1)
    if (prefetched) {
      setCurrent(prefetched)
      setError(null)
      setLoading(false)
    } else {
      loadCurrent(nextIndex, [])
    }
  }

  async function handleNochEinSatz() {
    // Unlike "Next"/"Got it" (advance(), which closes both side panels), this swaps in a new
    // sentence for the *same* card — the in-progress Add-source chat is about the sentence that's
    // about to disappear, so it must go too. The Explain thread is untouched: re-explaining the
    // same card across sentences is intentionally allowed to persist (see PracticeExplain.jsx).
    setAddSource(null)
    const newAvoid = [...avoid, current.sense_key]
    const prefetched = await resolvePrefetch(prefetchRef.current.same)
    prefetchRef.current.same = null
    setAvoid(newAvoid)
    setSentenceCount(c => c + 1)
    if (prefetched) {
      setCurrent(prefetched)
      setError(null)
      setLoading(false)
    } else {
      loadCurrent(index, newAvoid)
    }
  }

  function handleRestart() {
    sessionKeyRef.current += 1
    prefetchRef.current = {}
    setIndex(0)
    setAvoid([])
    setSentenceCount(1)
    setFinished(false)
    loadCurrent(0, [])
  }

  function handleExplain() {
    if (!current || !card) return
    const suggestion = mode === 'mc_cloze'
      ? `Why is "${current.answer}" correct here?`
      : `Can you explain "${card.name}" in this sentence?`
    const context = mode === 'mc_cloze'
      ? `Sentence: ${current.sentence}\nOptions: ${current.options.join(', ')}\nPracticing: ${card.name}`
      : `Sentence: ${current.sentence}\nPracticing: ${card.name}`
    setExplain({ suggestion, context })
  }

  function handleAddSource() {
    if (!current) return
    // The Add-source chat never sees the multiple-choice question — just the complete sentence,
    // blank filled in with the correct answer (exemplar items have no blank to begin with).
    const sentence = mode === 'mc_cloze' ? current.sentence.replace('___', current.answer) : current.sentence
    setAddSource({ sentence })
  }

  const total = cards.length
  const progress = `${Math.min(index + 1, total)} / ${total}`

  return (
    <div className="flex h-full min-w-0">
      <div className="flex flex-col h-full min-w-0 flex-1">
        <div
          className="px-3 py-2 border-b bg-white flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing select-none gap-2"
          onMouseDown={onDragStart}
        >
          <div className="min-w-0">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Practice</div>
            {!finished && card && (
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[10px] text-gray-400 shrink-0">{progress}</span>
                {mode === 'exemplar' && (
                  <span className="flex items-center gap-0.5 shrink-0" title={`${sentenceCount} sentence${sentenceCount > 1 ? 's' : ''} for this card`}>
                    {Array.from({ length: sentenceCount }).map((_, i) => (
                      <span key={i} className="w-1 h-1 rounded-full bg-blue-400" />
                    ))}
                  </span>
                )}
              </div>
            )}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              onMouseDown={e => e.stopPropagation()}
              aria-label="End session"
              title="End session"
              className="text-gray-400 hover:text-gray-600 transition-colors shrink-0"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {finished ? (
            <EndOfSession cards={cards} onRestart={handleRestart} />
          ) : loading ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-xs text-gray-400">Generating…</p>
            </div>
          ) : error ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-4 text-center">
              <p className="text-xs text-red-500">{error || "Couldn't generate a valid item."}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => loadCurrent(index, avoid)}
                  className="text-xs px-2.5 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  Retry
                </button>
                <button
                  onClick={advance}
                  className="text-xs px-2.5 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  Skip
                </button>
              </div>
            </div>
          ) : current && mode === 'mc_cloze' ? (
            <PracticeMcCloze item={current} onWeiter={advance} onExplain={handleExplain} onAddSource={handleAddSource} addSourceDisabled={!generatedContext} />
          ) : current && mode === 'exemplar' ? (
            <PracticeExemplar item={current} onVerstanden={advance} onNochEinSatz={handleNochEinSatz} onExplain={handleExplain} onAddSource={handleAddSource} addSourceDisabled={!generatedContext} />
          ) : null}
        </div>
      </div>

      {explain && (
        <PracticeExplain
          activeProject={activeProject}
          suggestion={explain.suggestion}
          context={explain.context}
          onClose={() => setExplain(null)}
        />
      )}

      {addSource && (
        <AddSourceChat
          activeProject={activeProject}
          forcedContext={generatedContext}
          tagCatalog={tagCatalog}
          onNewTags={onNewTags}
          onClose={() => setAddSource(null)}
          sentence={addSource.sentence}
        />
      )}
    </div>
  )
}

// Docked side panel for Practice's "Add source" button — same slot PracticeExplain.jsx uses, but
// this one is a genuine fresh instance of the "original" chat (save flow, dedup tool calls, all of
// it), not the stripped-down teacher-persona explainer. Two differences from the main Learn chat:
// `forcedContext` pins every saved source to the "generated" context (see SaveCard.jsx's
// forcedContext branch), and `initialMessage` sends the practice sentence itself the instant the
// panel opens, standing in for the user pasting it in. It's mounted fresh (conditional render, not
// display:none) each time PracticePanel opens it, and discarded — unmounted, conversation gone —
// the moment the sentence it's about disappears (advance() / handleNochEinSatz() above).
function AddSourceChat({ activeProject, forcedContext, tagCatalog, onNewTags, onClose, sentence }) {
  const [input, setInput] = useState('')
  return (
    <div className="w-80 sm:w-96 shrink-0 border-l bg-white flex flex-col h-full min-w-0">
      <ChatPanel
        activeProject={activeProject}
        forcedContext={forcedContext}
        tagCatalog={tagCatalog}
        onNewTags={onNewTags}
        input={input}
        onInputChange={setInput}
        onClose={onClose}
        title="Add source"
        initialMessage={sentence}
      />
    </div>
  )
}

function EndOfSession({ cards, onRestart }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
      <div>
        <p className="text-sm font-medium text-gray-800">Session complete</p>
        <p className="text-xs text-gray-400 mt-1">{cards.length} card{cards.length > 1 ? 's' : ''} covered</p>
      </div>
      <div className="flex flex-wrap gap-1 justify-center max-w-xs">
        {cards.map(c => (
          <span key={c.id} className="text-[10px] bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">{c.name}</span>
        ))}
      </div>
      <button
        onClick={onRestart}
        className="text-sm font-medium bg-blue-600 text-white rounded-lg px-4 py-1.5 hover:bg-blue-700 transition-colors"
      >
        Practice again
      </button>
    </div>
  )
}
