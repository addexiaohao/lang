import { useState, useEffect } from 'react'
import { apiFetch } from '../apiFetch.js'
import { useProject } from '../ProjectContext.jsx'

// Manual "add sense" entry point (CardDetailPanel's "+ Add sense" button) — plan.md's word-senses
// build plan scoped out BACKFILLING senses onto existing cards (senses should grow from real
// encounters, not be invented wholesale for old cards), but that's a different thing from wanting a
// direct correction/addition tool for a card you're already looking at.
//
// Two distinct actions, not one — clicking "add sense" on a monosemous card is usually just naming
// the ONE sense that's already there, not a claim that a second, distinct sense exists:
//   - `hasSenseAxis` false: the primary/required action is naming the card's current sense
//     (`existing_sense`). It's pre-filled automatically via `/api/suggest-sense` (lib/senseCheck.js's
//     suggestSense(), grounded in the card's own name/tags and its already-linked source sentences —
//     real evidence, not invention) so the user reviews/edits rather than writing from scratch.
//     Naming a second, already-known sense in the SAME step is optional, behind a toggle — the agent
//     has no signal at all for a sense the user hasn't described, so that part stays hand-typed.
//   - `hasSenseAxis` true: only a new (Nth) sense makes sense here, so that's the only field shown —
//     required, not pre-filled, same reasoning as above.
// Both call PATCH /api/knowledge-cards (see api/knowledge-cards.js's new_sense/existing_sense branch)
// which drives migrate_card_to_senses / append_sense_value — same RPCs the chat save flow uses, just
// with no source link involved.
//
// `unlinkedSourceCount` (only meaningful when `!hasSenseAxis`): how many of the card's ALREADY-linked
// sources have no skill_id yet — i.e. predate any sense distinction. They almost certainly belong to
// the sense being named right now, so this offers to backfill their `source_knowledge.skill_id` in
// the same step — opt-in (checked by default, but visible and uncheckable before Save is clicked),
// never done silently.
export default function AddSenseForm({ card, hasSenseAxis, unlinkedSourceCount = 0, onAdded, onCancel }) {
  const { activeProject } = useProject()

  const [existingKey, setExistingKey] = useState('')
  const [existingGloss, setExistingGloss] = useState('')
  const [existingExample, setExistingExample] = useState('')
  const [suggesting, setSuggesting] = useState(!hasSenseAxis)
  const [suggestError, setSuggestError] = useState(null)
  const [linkExistingSources, setLinkExistingSources] = useState(true)

  const [showSecondSense, setShowSecondSense] = useState(hasSenseAxis)
  const [newKey, setNewKey] = useState('')
  const [newGloss, setNewGloss] = useState('')
  const [newExample, setNewExample] = useState('')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (hasSenseAxis || !activeProject) return
    let cancelled = false
    setSuggesting(true)
    setSuggestError(null)
    apiFetch('/api/suggest-sense', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: activeProject.id, card_id: card.id }),
    })
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText)
        return r.json()
      })
      .then(({ key, gloss }) => {
        if (cancelled) return
        setExistingKey(key)
        setExistingGloss(gloss)
      })
      .catch(e => { if (!cancelled) setSuggestError(String(e.message || e)) })
      .finally(() => { if (!cancelled) setSuggesting(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSenseAxis, card.id, activeProject?.id])

  const needsExisting = !hasSenseAxis
  const existingValid = !needsExisting || (existingKey.trim() && existingGloss.trim())
  const newSenseFilled = newKey.trim() || newGloss.trim()
  const newSenseValid = hasSenseAxis
    ? (newKey.trim() && newGloss.trim())
    : (!showSecondSense || !newSenseFilled || (newKey.trim() && newGloss.trim()))
  const valid = existingValid && newSenseValid && (hasSenseAxis ? newKey.trim() && newGloss.trim() : true)

  async function handleSubmit() {
    if (!valid || !activeProject || saving) return
    setSaving(true)
    setError(null)
    try {
      const body = {}
      if (needsExisting) {
        body.existing_sense = { key: existingKey.trim(), gloss: existingGloss.trim(), example: existingExample.trim() || undefined }
        if (unlinkedSourceCount > 0) body.link_existing_sources = linkExistingSources
      }
      if (hasSenseAxis || (showSecondSense && newSenseFilled)) {
        body.new_sense = { key: newKey.trim(), gloss: newGloss.trim(), example: newExample.trim() || undefined }
      }
      const r = await apiFetch(`/api/knowledge-cards?project_id=${activeProject.id}&id=${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data.error || r.statusText)
      }
      onAdded()
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setSaving(false)
    }
  }

  const inputClass = 'w-full text-xs border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-purple-400 disabled:opacity-50 disabled:bg-gray-50'

  return (
    <div className="rounded-md bg-white border border-purple-200 px-2 py-2 space-y-1.5 text-xs">
      {needsExisting && (
        <>
          <p className="text-[10px] font-semibold text-purple-500 uppercase tracking-wide">
            This card's sense{suggesting && <span className="ml-1.5 normal-case font-normal text-gray-400">suggesting…</span>}
          </p>
          <input className={inputClass} placeholder="key (e.g. seating)" value={existingKey} disabled={suggesting} onChange={e => setExistingKey(e.target.value)} />
          <input className={inputClass} placeholder="gloss for this sense" value={existingGloss} disabled={suggesting} onChange={e => setExistingGloss(e.target.value)} />
          <input className={inputClass} placeholder="example sentence (optional)" value={existingExample} disabled={suggesting} onChange={e => setExistingExample(e.target.value)} />
          {suggestError && <p className="text-amber-600 text-[10px]">Couldn't auto-suggest ({suggestError}) — fill in by hand.</p>}
          {unlinkedSourceCount > 0 && (
            <label className="flex items-start gap-1.5 pt-1 cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={linkExistingSources} onChange={e => setLinkExistingSources(e.target.checked)} />
              <span className="text-[11px] text-gray-600">
                Also link {unlinkedSourceCount} existing source{unlinkedSourceCount === 1 ? '' : 's'} on this card to this sense
              </span>
            </label>
          )}
        </>
      )}

      {needsExisting && !showSecondSense && (
        <button type="button" onClick={() => setShowSecondSense(true)} className="text-[10px] text-purple-500 hover:text-purple-700 font-medium pt-1">
          + This card also has a second, distinct sense
        </button>
      )}

      {(hasSenseAxis || showSecondSense) && (
        <>
          <p className="text-[10px] font-semibold text-purple-500 uppercase tracking-wide pt-1">New sense</p>
          <input className={inputClass} placeholder="key (e.g. financial)" value={newKey} onChange={e => setNewKey(e.target.value)} />
          <input className={inputClass} placeholder="gloss for this sense" value={newGloss} onChange={e => setNewGloss(e.target.value)} />
          <input className={inputClass} placeholder="example sentence (optional)" value={newExample} onChange={e => setNewExample(e.target.value)} />
        </>
      )}

      {error && <p className="text-red-500">{error}</p>}
      <div className="flex gap-1.5 pt-1">
        <button
          type="button"
          disabled={!valid || saving || suggesting}
          onClick={handleSubmit}
          className="px-2 py-1 text-xs font-medium rounded bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-1 text-xs font-medium rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
