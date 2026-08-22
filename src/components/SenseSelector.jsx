import { useState, useEffect } from 'react'
import { apiFetch } from '../apiFetch.js'
import { axisValueKey, axisValueGloss, axisValueExample, hasSenseAxis, senseValues } from '../../lib/skillTypes.js'
import { useProject } from '../ProjectContext.jsx'

// Word-senses save flow (plan.md — "Word Senses" §3): the choice a user makes when a save:link_card
// block matches an existing vocabulary card that might have (or need) more than one sense. Renders
// nothing for a non-vocabulary match, or a vocabulary match the model gave no sense signal for and
// that has no senses on file yet (the ordinary, single-sense case — no decision to surface).
//
// `proposal` is what the model already decided (parsed from the block's new_sense/existing_sense/
// sense_key/sense_flag fields by ChatMessage.jsx) — pre-selected as a default, never forced.
// `onChange(fields | null)` reports the extra fields to merge into the source_knowledge POST body:
// `{ sense_key }`, `{ new_sense, existing_sense? }`, or null for "plain link, no sense fields".
export default function SenseSelector({ existingId, kind, proposal, onChange }) {
  const { activeProject } = useProject()
  const [existingCard, setExistingCard] = useState(null)

  useEffect(() => {
    if (kind !== 'vocabulary' || !existingId || !activeProject) return
    apiFetch(`/api/knowledge-cards?project_id=${activeProject.id}&id=${existingId}`)
      .then(r => r.ok ? r.json() : null)
      .then(setExistingCard)
      .catch(() => {})
  }, [existingId, kind, activeProject?.id])

  const senses = existingCard && hasSenseAxis(existingCard)
    ? senseValues(existingCard).map(v => ({ key: axisValueKey(v), gloss: axisValueGloss(v), example: axisValueExample(v) }))
    : null

  const hasProposal = !!(proposal?.senseKey || proposal?.newSense || proposal?.senseFlag)
  const show = kind === 'vocabulary' && (hasProposal || (senses && senses.length > 0))

  const [mode, setMode] = useState(proposal?.newSense ? 'new' : 'existing')
  const [selectedKey, setSelectedKey] = useState(proposal?.senseKey ?? senses?.[0]?.key ?? null)
  const [newKey, setNewKey] = useState(proposal?.newSense?.key ?? '')
  const [newGloss, setNewGloss] = useState(proposal?.newSense?.gloss ?? '')
  const [existingKey, setExistingKey] = useState(proposal?.existingSense?.key ?? '')
  const [existingGloss, setExistingGloss] = useState(proposal?.existingSense?.gloss ?? '')

  // Once senses load asynchronously, adopt the model's proposed key as the default selection if the
  // radio state hasn't been touched by the user yet.
  useEffect(() => {
    if (senses?.length && selectedKey == null) setSelectedKey(proposal?.senseKey ?? senses[0].key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [senses])

  const needsExisting = !(senses && senses.length > 0)
  const newSenseValid = newKey.trim() && newGloss.trim() && (!needsExisting || (existingKey.trim() && existingGloss.trim()))

  useEffect(() => {
    if (!show) { onChange(null); return }
    if (mode === 'existing') {
      onChange(selectedKey ? { sense_key: selectedKey } : null)
    } else if (newSenseValid) {
      const fields = { new_sense: { key: newKey.trim(), gloss: newGloss.trim(), example: proposal?.newSense?.example ?? '' } }
      if (needsExisting) fields.existing_sense = { key: existingKey.trim(), gloss: existingGloss.trim(), example: proposal?.existingSense?.example ?? '' }
      onChange(fields)
    } else {
      onChange(undefined) // signals "incomplete new-sense entry" — caller should disable Link
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, mode, selectedKey, newKey, newGloss, existingKey, existingGloss])

  const [refiningKey, setRefiningKey] = useState(null)
  const [refineDraft, setRefineDraft] = useState('')
  const [refining, setRefining] = useState(false)

  async function saveRefinedGloss(key) {
    if (!existingCard || !activeProject || !refineDraft.trim()) return
    setRefining(true)
    try {
      const r = await apiFetch(`/api/knowledge-cards?project_id=${activeProject.id}&id=${existingCard.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sense_key: key, sense_gloss: refineDraft.trim() }),
      })
      if (r.ok) {
        const updated = await r.json()
        setExistingCard(prev => prev ? { ...prev, details: updated.details } : prev)
      }
    } finally {
      setRefining(false)
      setRefiningKey(null)
    }
  }

  if (!show) return null

  return (
    <div className="rounded-md bg-white border border-purple-200 px-2 py-1.5 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-purple-500 uppercase tracking-wide">Which sense?</span>
        {proposal?.senseFlag === 'stretched' && (
          <span className="text-[10px] text-amber-600">borderline call — review</span>
        )}
      </div>

      {senses?.map(s => (
        <div key={s.key} className="text-xs">
          <label className="flex items-start gap-1.5 cursor-pointer">
            <input type="radio" className="mt-0.5" checked={mode === 'existing' && selectedKey === s.key} onChange={() => { setMode('existing'); setSelectedKey(s.key) }} />
            <span className="flex-1">
              <span className="font-medium text-gray-700">{s.key}</span>
              {s.gloss && <span className="text-gray-500"> — {s.gloss}</span>}
              {s.example && <span className="block text-gray-400 italic">"{s.example}"</span>}
            </span>
            {refiningKey !== s.key && (
              <button type="button" onClick={() => { setRefiningKey(s.key); setRefineDraft(s.gloss ?? '') }} className="shrink-0 text-[10px] text-blue-500 hover:text-blue-700 font-medium">
                Refine gloss
              </button>
            )}
          </label>
          {refiningKey === s.key && (
            <div className="flex items-start gap-1.5 mt-1 ml-5">
              <textarea autoFocus rows={2} className="flex-1 text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400" value={refineDraft} onChange={e => setRefineDraft(e.target.value)} />
              <div className="flex flex-col gap-1 shrink-0">
                <button type="button" disabled={refining || !refineDraft.trim()} onClick={() => saveRefinedGloss(s.key)} className="text-[10px] px-2 py-0.5 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40">
                  Save
                </button>
                <button type="button" onClick={() => setRefiningKey(null)} className="text-[10px] px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      <label className="flex items-start gap-1.5 text-xs cursor-pointer">
        <input type="radio" className="mt-0.5" checked={mode === 'new'} onChange={() => setMode('new')} />
        <span className="flex-1 space-y-1">
          <span className="font-medium text-gray-700">New sense</span>
          {mode === 'new' && (
            <span className="block space-y-1">
              <input className="w-full text-xs border border-gray-200 rounded px-1.5 py-0.5" placeholder="key (e.g. financial)" value={newKey} onChange={e => setNewKey(e.target.value)} />
              <input className="w-full text-xs border border-gray-200 rounded px-1.5 py-0.5" placeholder="gloss for this sense" value={newGloss} onChange={e => setNewGloss(e.target.value)} />
              {needsExisting && (
                <>
                  <p className="text-[10px] text-amber-600">First split of this card — also name the sense already on file:</p>
                  <input className="w-full text-xs border border-gray-200 rounded px-1.5 py-0.5" placeholder="key for the existing sense" value={existingKey} onChange={e => setExistingKey(e.target.value)} />
                  <input className="w-full text-xs border border-gray-200 rounded px-1.5 py-0.5" placeholder="gloss for the existing sense" value={existingGloss} onChange={e => setExistingGloss(e.target.value)} />
                </>
              )}
            </span>
          )}
        </span>
      </label>
    </div>
  )
}
