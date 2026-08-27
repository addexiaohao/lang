import { useState } from 'react'
import { CardSearchBar } from './CardSearchBar.jsx'
import { relateCard, createCardGroup, addCardToGroup, groupDisplayName } from '../cardGroupActions.js'

// "Relate to…" for a card that already has a real id (plan.md — "Card Groups") — relating happens
// immediately, resolved via the same §2 rule CardDetailPanel's "Relate this card…" uses. Shared by
// LinkCard.jsx (an existing card matched via search_knowledge_cards) and SaveCard.jsx (a
// just-proposed card, but only once it's actually been saved and has a real id — see
// RelateToStaged there for the pre-save picker, which stages instead of resolving immediately).
export function RelateToControl({ activeProject, cardId, cardName }) {
  const [open, setOpen] = useState(false)
  const [pendingTarget, setPendingTarget] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [justRelated, setJustRelated] = useState(false)

  async function pick(targetCard) {
    setError(null)
    setBusy(true)
    try {
      const result = await relateCard(activeProject.id, cardId, targetCard.id)
      if (result.resolved) {
        setOpen(false)
        setJustRelated(true)
      } else {
        setPendingTarget({ ...targetCard, groups: result.groups })
      }
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  async function confirmGroupChoice(groupId) {
    if (!pendingTarget) return
    setBusy(true)
    setError(null)
    try {
      if (groupId === 'new') await createCardGroup(activeProject.id, [cardId, pendingTarget.id])
      else await addCardToGroup(activeProject.id, groupId, pendingTarget.id)
      setPendingTarget(null)
      setOpen(false)
      setJustRelated(true)
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  if (!activeProject || !cardId) return null

  return (
    <div className="text-xs">
      {!open ? (
        <button
          type="button"
          onClick={() => { setOpen(true); setJustRelated(false) }}
          className="text-purple-600 hover:text-purple-800 font-medium"
        >
          {justRelated ? 'Related ✓ — relate to another…' : 'Relate to…'}
        </button>
      ) : (
        <div className="space-y-1.5">
          <CardSearchBar
            activeProject={activeProject}
            excludeIds={[cardId]}
            onSelect={pick}
            placeholder="Search for a card to relate…"
            autoFocus
          />
          {pendingTarget && (
            <div className="border border-purple-300 bg-purple-100 rounded-lg p-2 space-y-1">
              <p className="text-[10px] text-gray-600">"{cardName}" is in several groups — add "{pendingTarget.name}" to which one?</p>
              {pendingTarget.groups.map(g => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => confirmGroupChoice(g.id)}
                  disabled={busy}
                  className="w-full text-left text-[10px] px-2 py-1 rounded bg-white border border-gray-200 hover:border-purple-300 transition-colors disabled:opacity-50"
                >
                  {groupDisplayName(g)}
                </button>
              ))}
              <button
                type="button"
                onClick={() => confirmGroupChoice('new')}
                disabled={busy}
                className="w-full text-left text-[10px] px-2 py-1 rounded bg-white border border-gray-200 hover:border-purple-300 transition-colors disabled:opacity-50"
              >
                + Create a new group
              </button>
              <button type="button" onClick={() => setPendingTarget(null)} className="text-[10px] text-gray-400 hover:text-gray-600">Cancel</button>
            </div>
          )}
          {error && <p className="text-[10px] text-red-500">{error}</p>}
          <button type="button" onClick={() => { setOpen(false); setPendingTarget(null); setError(null) }} className="text-[10px] text-gray-400 hover:text-gray-600">
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
