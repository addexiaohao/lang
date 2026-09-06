import { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../../apiFetch.js'
import { fetchQuickStartSkills } from '../../practiceQuickStart.js'
import { MAX_EASIER_SENTENCE_ATTEMPTS } from '../../../lib/practiceRules.js'
import PracticeMcCloze from '../PracticeMcCloze.jsx'
import PracticeSpelling from '../PracticeSpelling.jsx'
import PracticeExemplar from '../PracticeExemplar.jsx'
import PracticeExplain from '../PracticeExplain.jsx'
import { CardDetailPanel } from './CardDetailPanel.jsx'
import { ChatPanel } from './ChatPanel.jsx'

// Runs an ephemeral practice session over `practiceSession.skills` — a list of { card, type }
// pairs (skills are the practice unit now, not cards, see lib/practiceRules.js and CLAUDE.md's
// "Skills" section). Each skill's question shape (`current.mode`, one of
// 'mc_cloze'/'spelling'/'exemplar') is decided server-side by the rule registry per request, not
// fixed for the whole session — a mixed selection can freely interleave question types skill by
// skill.
// Nothing here persists — reload or close and the session is gone, by design (see CLAUDE.md /
// practice-prototype-plan.md hard constraints).
export function PracticePanel({ activeProject, practiceSession, onDragStart, onClose, onSidePanelCountChange, onStartPractice, generatedContext, tagCatalog, onNewTags, onSelectCard }) {
  const { skills, capNotice } = practiceSession
  // End-of-session "More practice" button state (see handleRestart below) — separate from
  // `loading`, which is about generating the current item, not fetching a new selection.
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState(null)
  const [index, setIndex] = useState(0)
  // plan.md §4's failure-cap notice ("working through N tricky ones — no new words until this
  // shrinks") — surfaced once per session, dismissible, not re-shown once closed.
  const [capNoticeDismissed, setCapNoticeDismissed] = useState(false)
  const [current, setCurrent] = useState(null)
  const [sentenceCount, setSentenceCount] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [finished, setFinished] = useState(false)
  // Three independent docked side panels — the "Ask" thread, the "Add source" chat, and
  // the card panel (auto-opened once the current item is answered) — can be open together, each
  // its own column (see render below).
  const [explain, setExplain] = useState(null) // { suggestion, context } | null
  const [addSource, setAddSource] = useState(null) // { sentence } | null
  const [cardOpen, setCardOpen] = useState(false)
  // card.id -> detail, filled in as prefetches resolve (see fetchCardDetail below) — keyed by
  // id, and populated independently of `cardOpen`, so the docked panel's very first render already
  // has the data instead of racing its own mount effect against ours.
  const [cardDetails, setCardDetails] = useState({})
  // { cardId, type, delta } | null — the +N/-N badge shown next to the just-answered skill's Level
  // dots in the docked card panel, computed by diffing the level before/after recordPracticeResult
  // lands. Cleared whenever the item changes so it doesn't linger on the wrong skill.
  const [levelChange, setLevelChange] = useState(null)
  // index -> { skill, correct } for every item actually answered this session (skipped items via
  // the error state's "Skip" leave no entry) — drives EndOfSession's right/wrong coloring.
  const [results, setResults] = useState({})
  // How many times "Easier sentence" has been used on the item currently on screen (0 = never).
  // Reset to 0 whenever `current` is replaced by a genuinely new item (loadCurrent, advance,
  // handleNochEinSatz) — NOT reset by handleEasierSentence itself, since it counts attempts on
  // the same underlying skill across regenerations. The button hides once this hits
  // MAX_EASIER_SENTENCE_ATTEMPTS (lib/practiceRules.js — also the server-side clamp).
  const [easierCount, setEasierCount] = useState(0)
  // The raw (server-response-shape) items this skill's conversation has produced so far, oldest
  // first — sent back as `history` on the next "Easier sentence" request so api/practice.js can
  // replay this as a genuine multi-turn Anthropic conversation (see lib/practiceGenerate.js's
  // `history` param) instead of a stateless one-shot regeneration that has no memory of what it
  // just wrote. Always kept in sync 1:1 with easierCount (length === easierCount + 1 once an item
  // is loaded) — reset alongside it at every same reset point.
  const [itemHistory, setItemHistory] = useState([])

  // Reports how many side panels are open (0/1/2/3) so PracticeMode.jsx can widen the box to fit
  // them — a plain effect rather than calling this at every setExplain/setAddSource/setCardOpen
  // call site, since batched updates (e.g. advance() closing all three at once) would otherwise
  // report transient, stale-closure intermediate counts.
  useEffect(() => {
    onSidePanelCountChange?.((explain ? 1 : 0) + (addSource ? 1 : 0) + (cardOpen ? 1 : 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explain, addSource, cardOpen])

  // While item n is on screen, prefetch.same (exemplar same-card resentence — currently unused by
  // any button, see PracticeExemplar.jsx) and/or prefetch.next (the following skill) are requested
  // in the background — that's the whole latency strategy.
  const prefetchRef = useRef({})
  const sessionKeyRef = useRef(0)
  // Groups every practice_attempt row produced for the item currently on screen — regenerated
  // (crypto.randomUUID()) whenever `current` becomes a genuinely new item (loadCurrent, advance,
  // handleNochEinSatz), but left UNCHANGED across an "Easier sentence" regeneration, since that's a
  // continuation of the same encounter, not a new one (see handleEasierSentence). A ref, not state:
  // nothing renders off it, it just needs to be current by the time handleAnswered/
  // handleEasierSentence read it.
  const encounterIdRef = useRef(null)
  // card.id -> Promise<detail|null> — the card panel's own fetch, kept separate from the
  // question-item prefetch above. Started as soon as an item loads (see effect below), well
  // before the user answers, so by the time the panel auto-opens the data is already there.
  const cardDetailCacheRef = useRef({})

  const skill = skills[index]
  // The skill actually generated for the item on screen — usually `skill`, but can differ after a
  // silent server-side substitution (see requestItem's comment above). Everything downstream of
  // the current item (result recording, Explain, the card panel) should use this, not `skill`.
  const effectiveSkill = current?.skill ?? skill
  const card = effectiveSkill?.card

  // Fetches (or re-fetches) a card's full detail behind the auto-shown card panel, stashing it in
  // `cardDetails` by card id as soon as it resolves — independent of whether the panel is open
  // yet. By default idempotent/cached (a re-request for the same card, e.g. two skills on one card
  // back to back, is free); `force: true` bypasses the cache — used right after a practice result
  // is recorded, since the prefetched detail was fetched *before* the level bump and would
  // otherwise show a stale (pre-answer) level in the panel. Returns the detail (or the in-flight
  // promise for it) so callers can chain off the fresh value, e.g. to diff a level before/after.
  const fetchCardDetail = useCallback((targetCard, { force = false } = {}) => {
    if (!targetCard || !activeProject) return Promise.resolve(null)
    if (!force && cardDetailCacheRef.current[targetCard.id]) return cardDetailCacheRef.current[targetCard.id]
    const p = apiFetch(`/api/knowledge-cards?${new URLSearchParams({ project_id: activeProject.id, id: targetCard.id })}`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(detail => {
        setCardDetails(prev => ({ ...prev, [targetCard.id]: detail }))
        return detail
      })
    cardDetailCacheRef.current[targetCard.id] = p
    return p
  }, [activeProject?.id])

  // Fired from handleAnswered with the just-answered correctness (right/wrong/don't know) —
  // bumps the skill's level by one step (floor 1, ceiling 10) server-side (api/knowledge-cards.js),
  // which also stamps last_correct, but only when the attempt was actually correct. Fire-and-forget:
  // a failed bookkeeping write shouldn't block moving on to the next item. Once it lands, force a
  // fresh card-detail fetch so the auto-shown panel picks up the new level instead of the
  // pre-answer one it was prefetched with, and diff against `beforeLevel` (the level as of the
  // moment the answer was given — see handleAnswered) to drive the +N/-N badge.
  const recordPracticeResult = useCallback((targetSkill, correct, beforeLevel, encounterId, model, requestSnapshot, rawResponse) => {
    apiFetch(`/api/knowledge-cards?${new URLSearchParams({ project_id: activeProject.id, id: targetSkill.card.id })}`, {
      method: 'PATCH',
      body: JSON.stringify({
        skill_type: targetSkill.type,
        practice_result: correct ? 'correct' : 'incorrect',
        encounter_id: encounterId,
        model,
        conversation: { request: requestSnapshot, response: rawResponse },
      }),
    })
      .then(() => fetchCardDetail(targetSkill.card, { force: true }))
      .then(detail => {
        const afterLevel = detail?.skill?.find(s => s.type === targetSkill.type)?.level ?? null
        if (beforeLevel == null || afterLevel == null || afterLevel === beforeLevel) return
        setLevelChange({ cardId: targetSkill.card.id, type: targetSkill.type, delta: afterLevel - beforeLevel })
      })
      .catch(e => console.error('[practice] failed to record result', e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id])

  // Fired from handleEasierSentence for the round being abandoned — logs outcome 'too_hard'
  // without touching skill.level/last_correct (unlike recordPracticeResult), via the dedicated
  // api/practice-attempt.js endpoint. Shares the same encounterId as whatever round comes next in
  // this chain (handleEasierSentence doesn't touch encounterIdRef), so all rounds of one "Easier
  // sentence" chain land under one encounter_id. Fire-and-forget, same as recordPracticeResult.
  const logTooHard = useCallback((targetSkill, encounterId, model, requestSnapshot, rawResponse) => {
    if (!encounterId) return
    apiFetch('/api/practice-attempt', {
      method: 'POST',
      body: JSON.stringify({
        project_id: activeProject.id,
        card_id: targetSkill.card.id,
        skill_type: targetSkill.type,
        encounter_id: encounterId,
        outcome: 'too_hard',
        model,
        conversation: { request: requestSnapshot, response: rawResponse },
      }),
    }).catch(e => console.error('[practice] failed to log too_hard attempt', e))
  }, [activeProject?.id])

  // `history`/`problemType`, if given, continue an existing "Easier sentence" conversation for
  // this exact skill (see handleEasierSentence below) — `history` is the ordered list of raw
  // items (server-response shape) already produced this chain, `problemType` pins which problem
  // type it committed to (api/practice.js's resolvePracticeRule uses it to avoid re-rolling a
  // different one mid-chain). Both omitted for an ordinary fresh generation.
  const requestItem = useCallback(async (targetSkill, { history = [], problemType } = {}) => {
    const res = await apiFetch('/api/practice', {
      method: 'POST',
      body: JSON.stringify({
        project_id: activeProject.id,
        card_id: targetSkill.card.id,
        skill_type: targetSkill.type,
        history: history.length ? history : undefined,
        problem_type: problemType,
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || 'Failed to generate item')
    // body.request is the exact { model, system, messages } api/practice.js sent to Anthropic —
    // the client only ever sends a card_id/skill_type, so this is the only place the real
    // prompt text (card context, task instructions) is visible; log that, not the request we made.
    console.log('[LLM request]', JSON.stringify(body.request, null, 2))
    console.log('[LLM response]', JSON.stringify(body.item, null, 2))
    // body.mode is the question type the rule registry picked for this skill (lib/practiceRules.js)
    // — stash it on the item itself since it can differ skill to skill within one session.
    // body.card/body.skill_type are what api/practice.js ACTUALLY generated for — the requested
    // skill_type may have had no problem type configured, in which case the server silently
    // substituted a different skill (see lib/practiceRules.js's practiceableSkillTypes()). Stash
    // that as `skill` on the item so result recording / Explain / the card panel act on the real
    // thing, not on targetSkill.
    // seed: { offered, used } — the "other vocabulary already known" pool offered to the model
    // (body.seed_cards, each { id, name }) vs. what it reports actually using (item.used_seed_words,
    // names only) — shown in the auto-opened card panel alongside the skill tested, offered names
    // rendered as links via their id.
    // rawItem/problemType are kept alongside the displayable item so handleEasierSentence can
    // extend itemHistory and pin the chain's problemType on the next continuation request.
    // rawResponse is the full raw model response (for mc_cloze, the Step 1 sentence-drafting text
    // ahead of the tool call too, see lib/practiceRules.js) — kept only for conversation-history
    // logging (recordPracticeResult/logTooHard below); never rendered.
    return {
      ...body.item,
      mode: body.mode,
      problemType: body.problem_type,
      // Some drills (production-which-preposition/conjunction) test PRODUCING the right word for a
      // stated meaning, not inferring meaning from context — see PracticeMcCloze.jsx, which shows
      // `translation` before the learner answers instead of only after when this is set.
      revealTranslation: !!body.reveal_translation,
      rawItem: body.item,
      rawResponse: body.response ?? null,
      request: body.request ?? null,
      model: body.request?.model ?? null,
      skill: { card: body.card ?? targetSkill.card, type: body.skill_type ?? targetSkill.type },
      seed: { offered: body.seed_cards ?? [], used: body.item?.used_seed_words ?? [] },
    }
  }, [activeProject?.id])

  const loadCurrent = useCallback(async (targetIndex) => {
    setLoading(true)
    setError(null)
    const mySession = sessionKeyRef.current
    try {
      const item = await requestItem(skills[targetIndex])
      if (sessionKeyRef.current !== mySession) return
      encounterIdRef.current = crypto.randomUUID()
      setCurrent(item)
      setEasierCount(0)
      setItemHistory([item.rawItem])
    } catch (e) {
      if (sessionKeyRef.current !== mySession) return
      setError(e.message)
      setCurrent(null)
    } finally {
      if (sessionKeyRef.current === mySession) setLoading(false)
    }
  }, [skills, requestItem])

  // (Re)start whenever a new session is handed in (new selection, or "More practice").
  useEffect(() => {
    sessionKeyRef.current += 1
    prefetchRef.current = {}
    cardDetailCacheRef.current = {}
    setIndex(0)
    setSentenceCount(1)
    setFinished(false)
    setCurrent(null)
    setExplain(null)
    setAddSource(null)
    setCardOpen(false)
    setCardDetails({})
    setLevelChange(null)
    setResults({})
    setEasierCount(0)
    setItemHistory([])
    loadCurrent(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [practiceSession])

  // Prefetch the likely next request(s) while the current item is being looked at — and the
  // current item's own card detail, well ahead of the answer that will reveal it.
  useEffect(() => {
    if (!current || finished) return
    if (current.mode === 'exemplar') {
      prefetchRef.current.same = requestItem(current.skill ?? skill).catch(e => ({ __error: e.message }))
    }
    const nextIndex = index + 1
    if (nextIndex < skills.length) {
      prefetchRef.current.next = requestItem(skills[nextIndex]).catch(e => ({ __error: e.message }))
    }
    fetchCardDetail(current.skill?.card ?? skill?.card)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  async function resolvePrefetch(p) {
    if (!p) return null
    const result = await p
    return result?.__error ? null : result
  }

  // Fired the moment an item is answered — an option picked, "Don't know", a spelling submitted,
  // or exemplar's "Got it" — not at "Next". The skill update (and the right/wrong record used by
  // EndOfSession) has to land right away, before the user might close the panel without ever
  // clicking Next. `beforeLevel` is read from whatever's cached *right now*, before the PATCH —
  // if the prefetch hasn't resolved yet, it's null and no delta badge is shown (rather than a
  // misleading one), same fallback recordPracticeResult already applies.
  function handleAnswered(correct) {
    setCardOpen(true)
    setLevelChange(null)
    const beforeLevel = cardDetails[effectiveSkill.card.id]?.skill?.find(s => s.type === effectiveSkill.type)?.level ?? null
    recordPracticeResult(effectiveSkill, correct, beforeLevel, encounterIdRef.current, current?.model, current?.request, current?.rawResponse)
    setResults(prev => ({ ...prev, [index]: { skill: effectiveSkill, correct } }))
  }

  async function advance() {
    setExplain(null)
    setAddSource(null)
    setCardOpen(false)
    setLevelChange(null)
    const nextIndex = index + 1
    if (nextIndex >= skills.length) {
      setFinished(true)
      return
    }
    const prefetched = await resolvePrefetch(prefetchRef.current.next)
    prefetchRef.current = {}
    setIndex(nextIndex)
    setSentenceCount(1)
    if (prefetched) {
      encounterIdRef.current = crypto.randomUUID()
      setCurrent(prefetched)
      setEasierCount(0)
      setItemHistory([prefetched.rawItem])
      setError(null)
      setLoading(false)
    } else {
      loadCurrent(nextIndex)
    }
  }

  async function handleNochEinSatz() {
    // Unlike "Next"/"Got it" (advance(), which closes both side panels), this swaps in a new
    // sentence for the *same* card — the in-progress Add-source chat is about the sentence that's
    // about to disappear, so it must go too. The Explain thread is untouched: re-explaining the
    // same card across sentences is intentionally allowed to persist (see PracticeExplain.jsx).
    setAddSource(null)
    const prefetched = await resolvePrefetch(prefetchRef.current.same)
    prefetchRef.current.same = null
    setSentenceCount(c => c + 1)
    if (prefetched) {
      encounterIdRef.current = crypto.randomUUID()
      setCurrent(prefetched)
      setEasierCount(0)
      setItemHistory([prefetched.rawItem])
      setError(null)
      setLoading(false)
    } else {
      loadCurrent(index)
    }
  }

  // "More practice" (EndOfSession's button) — fetches a genuinely fresh scheduler-respecting
  // selection (same as PracticeStart's "Quick practice") rather than replaying `practiceSession`'s
  // existing `skills` list unchanged: a skill just answered correctly here has its due_at pushed
  // out, so blindly re-running the same list could immediately re-serve it minutes later, before
  // it was ever due again. Handing the result to `onStartPractice` replaces the parent's
  // `practiceSession` with a new object, which the `[practiceSession]` effect above picks up to do
  // the actual reset + loadCurrent(0).
  async function handleRestart() {
    if (!activeProject) return
    setRestarting(true)
    setRestartError(null)
    try {
      const { skills: newSkills, meta } = await fetchQuickStartSkills(activeProject)
      onStartPractice(newSkills, meta)
    } catch (e) {
      setRestartError(e.message)
    } finally {
      setRestarting(false)
    }
  }

  // Regenerates the item currently on screen for the exact same skill, continuing this skill's
  // conversation (itemHistory) with a request for easier surrounding vocabulary — a genuine
  // multi-turn continuation, not a fresh one-shot regeneration, so the model can react to exactly
  // what it wrote last turn instead of being told about a "previous attempt" it has no memory of
  // (see lib/practiceGenerate.js's `history` param / easierTurnText, and api/practice.js's
  // resolvePracticeRule which pins the chain's problemType so it can't drift mid-conversation).
  // Closes the explain/add-source side panels since both are about the sentence that's about to
  // disappear (same reasoning as handleNochEinSatz). Capped client-side at
  // MAX_EASIER_SENTENCE_ATTEMPTS; each Practice*.jsx component hides its own button once
  // `easierCount` reaches that cap (the server clamps `history` length too, independently).
  async function handleEasierSentence() {
    if (!current || easierCount >= MAX_EASIER_SENTENCE_ATTEMPTS) return
    logTooHard(effectiveSkill, encounterIdRef.current, current.model, current.request, current.rawResponse)
    setExplain(null)
    setAddSource(null)
    setLoading(true)
    setError(null)
    const mySession = sessionKeyRef.current
    try {
      const item = await requestItem(effectiveSkill, { history: itemHistory, problemType: current.problemType })
      if (sessionKeyRef.current !== mySession) return
      setCurrent(item)
      setEasierCount(c => c + 1)
      setItemHistory(prev => [...prev, item.rawItem])
    } catch (e) {
      if (sessionKeyRef.current !== mySession) return
      setError(e.message)
    } finally {
      if (sessionKeyRef.current === mySession) setLoading(false)
    }
  }

  function handleExplain() {
    if (!current || !card) return
    let suggestion, context
    if (current.mode === 'mc_cloze') {
      suggestion = `Why is "${current.answer}" correct here?`
      context = `Sentence: ${current.sentence}\nOptions: ${current.options.join(', ')}\nPracticing: ${card.name}`
    } else if (current.mode === 'spelling') {
      suggestion = `Why is "${current.answer}" correct here?`
      context = `Sentence: ${current.sentence}\nPracticing: ${card.name}`
    } else {
      suggestion = `Can you explain "${card.name}" in this sentence?`
      context = `Sentence: ${current.sentence}\nPracticing: ${card.name}`
    }
    setExplain({ suggestion, context })
  }

  // "Add note" (AddNoteButton, dev/self-use scratch notes — see api/practice-note.js). Keyed off
  // effectiveSkill/current.rawItem so a note always lands on the skill/question actually on
  // screen, same reasoning as recordPracticeResult/logTooHard. Returns the fetch promise so
  // AddNoteButton can show its own saving/error state.
  async function handleAddNote(noteText) {
    if (!current) return
    const res = await apiFetch('/api/practice-note', {
      method: 'POST',
      body: JSON.stringify({
        project_id: activeProject.id,
        card_id: effectiveSkill.card.id,
        skill_type: effectiveSkill.type,
        question: current.rawItem,
        note: noteText,
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || 'Failed to save note')
    }
  }

  function handleAddSource() {
    if (!current) return
    // The Add-source chat never sees the multiple-choice question — just the complete sentence,
    // blank filled in with the correct answer (exemplar items have no blank to begin with).
    const sentence = current.mode === 'mc_cloze' || current.mode === 'spelling'
      ? current.sentence.replace('___', current.answer)
      : current.sentence
    setAddSource({ sentence })
  }

  const total = skills.length
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
                {current?.mode === 'exemplar' && (
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

        {capNotice && !capNoticeDismissed && (
          <div className="px-3 py-1.5 bg-amber-50 border-b border-amber-100 flex items-center justify-between gap-2 shrink-0">
            <p className="text-[11px] text-amber-700">{capNotice}</p>
            <button
              onClick={() => setCapNoticeDismissed(true)}
              aria-label="Dismiss"
              className="text-amber-400 hover:text-amber-600 transition-colors shrink-0"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-hidden">
          {finished ? (
            <EndOfSession skills={skills} results={results} onRestart={handleRestart} restarting={restarting} restartError={restartError} />
          ) : loading ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-xs text-gray-400">Generating…</p>
            </div>
          ) : error ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-4 text-center">
              <p className="text-xs text-red-500">{error || "Couldn't generate a valid item."}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => loadCurrent(index)}
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
          ) : current && current.mode === 'mc_cloze' ? (
            <PracticeMcCloze item={current} onWeiter={advance} onAnswered={handleAnswered} onExplain={handleExplain} onAddSource={handleAddSource} addSourceDisabled={!generatedContext} onEasierSentence={handleEasierSentence} easierCount={easierCount} maxEasierAttempts={MAX_EASIER_SENTENCE_ATTEMPTS} onAddNote={handleAddNote} />
          ) : current && current.mode === 'spelling' ? (
            <PracticeSpelling item={current} onWeiter={advance} onAnswered={handleAnswered} onExplain={handleExplain} onAddSource={handleAddSource} addSourceDisabled={!generatedContext} onEasierSentence={handleEasierSentence} easierCount={easierCount} maxEasierAttempts={MAX_EASIER_SENTENCE_ATTEMPTS} onAddNote={handleAddNote} />
          ) : current && current.mode === 'exemplar' ? (
            <PracticeExemplar item={current} onAnswered={handleAnswered} onNext={advance} onNochEinSatz={handleNochEinSatz} onExplain={handleExplain} onAddSource={handleAddSource} addSourceDisabled={!generatedContext} onEasierSentence={handleEasierSentence} easierCount={easierCount} maxEasierAttempts={MAX_EASIER_SENTENCE_ATTEMPTS} onAddNote={handleAddNote} />
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

      {cardOpen && card && (
        <div className="w-80 sm:w-96 shrink-0 border-l bg-white flex flex-col h-full min-w-0">
          <CardDetailPanel
            card={card}
            activeProject={activeProject}
            onClose={() => setCardOpen(false)}
            highlightSkillType={effectiveSkill?.type}
            prefetchedDetail={cardDetails[card.id] ?? null}
            levelChange={levelChange?.cardId === card.id ? levelChange : null}
            seedInfo={current?.seed ?? null}
            tagCatalog={tagCatalog}
            onNewTags={onNewTags}
            onSelectCard={onSelectCard}
          />
        </div>
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

// `results` is index -> { skill, correct } (see PracticePanel's own state) — a missing entry
// (item skipped via the error state's "Skip") renders neutral, not wrong. `result.skill`, not the
// original `skills[i]`, is what's actually displayed, since a silent server-side substitution
// (see requestItem's comment above) can mean the skill actually assessed at that index differs
// from the one originally requested.
function EndOfSession({ skills, results, onRestart, restarting, restartError }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
      <div>
        <p className="text-sm font-medium text-gray-800">Session complete</p>
        <p className="text-xs text-gray-400 mt-1">{skills.length} skill{skills.length > 1 ? 's' : ''} covered</p>
      </div>
      <div className="flex flex-wrap gap-1 justify-center max-w-xs">
        {skills.map((s, i) => {
          const result = results?.[i]
          const displaySkill = result?.skill ?? s
          const colorClass = !result
            ? 'bg-gray-100 text-gray-600'
            : result.correct
              ? 'bg-green-100 text-green-700'
              : 'bg-red-100 text-red-700'
          return (
            <span key={`${s.card.id}-${s.type}-${i}`} className={`text-[10px] rounded px-1.5 py-0.5 ${colorClass}`}>
              {displaySkill.card.name} · {displaySkill.type}
            </span>
          )
        })}
      </div>
      <button
        onClick={onRestart}
        disabled={restarting}
        className="text-sm font-medium bg-blue-600 text-white rounded-lg px-4 py-1.5 hover:bg-blue-700 disabled:opacity-40 transition-colors"
      >
        {restarting ? 'Loading…' : 'More practice'}
      </button>
      {restartError && <p className="text-xs text-red-500">{restartError}</p>}
    </div>
  )
}
