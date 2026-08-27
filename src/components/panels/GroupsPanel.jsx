import { useState, useEffect } from 'react'
import { apiFetch } from '../../apiFetch.js'
import { CardSearchBar } from '../CardSearchBar.jsx'

const KIND_COLORS = {
  vocabulary: 'bg-green-100 text-green-700',
  grammar: 'bg-purple-100 text-purple-700',
  expression: 'bg-orange-100 text-orange-700',
}

function groupDisplayName(group) {
  return group.name || group.members.map(m => m.name).join(' · ')
}

// Groups panel (plan.md — "Card Groups" §3): list of every group in the project, parallel to
// TagsPanel — same list/detail ("group tab") toggle shape, list-view header/back-button styling
// copied from that file so the two panels read as siblings.
export function GroupsPanel({ activeProject, onDragStart, onClose, onSelectCard }) {
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [selectedGroupId, setSelectedGroupId] = useState(null)

  const [showNewGroup, setShowNewGroup] = useState(false)
  const [newGroupMembers, setNewGroupMembers] = useState([])
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)

  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [editingNote, setEditingNote] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [editingMemberKey, setEditingMemberKey] = useState(null)
  const [memberNoteDraft, setMemberNoteDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [detailError, setDetailError] = useState(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  function refetch() {
    if (!activeProject) return
    setLoading(true)
    setError(null)
    apiFetch(`/api/card-groups?${new URLSearchParams({ project_id: activeProject.id })}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(data => setGroups(data.groups ?? []))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    setSelectedGroupId(null)
    setShowNewGroup(false)
    setNewGroupMembers([])
    setCreateError(null)
    refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id])

  async function handleCreateGroup() {
    if (newGroupMembers.length < 2 || !activeProject) return
    setCreating(true)
    setCreateError(null)
    try {
      const r = await apiFetch('/api/card-groups', {
        method: 'POST',
        body: JSON.stringify({ project_id: activeProject.id, member_card_ids: newGroupMembers.map(c => c.id) }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error || 'Failed to create group')
      setShowNewGroup(false)
      setNewGroupMembers([])
      refetch()
      setSelectedGroupId(data.id)
    } catch (e) {
      setCreateError(String(e.message || e))
    } finally {
      setCreating(false)
    }
  }

  function selectGroup(group) {
    setSelectedGroupId(group.id)
    setEditingName(false)
    setEditingNote(false)
    setEditingMemberKey(null)
    setConfirmingDelete(false)
    setDetailError(null)
  }

  function handleBack() {
    setSelectedGroupId(null)
    setConfirmingDelete(false)
  }

  async function patchGroup(update) {
    setBusy(true)
    setDetailError(null)
    try {
      const r = await apiFetch(`/api/card-groups?id=${selectedGroupId}`, { method: 'PATCH', body: JSON.stringify(update) })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error || 'Failed to update group')
      setGroups(prev => prev.map(g => g.id === data.id ? data : g))
    } catch (e) {
      setDetailError(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  async function addMember(card) {
    setBusy(true)
    setDetailError(null)
    try {
      const r = await apiFetch('/api/card-group-members', {
        method: 'POST',
        body: JSON.stringify({ project_id: activeProject.id, group_id: selectedGroupId, card_id: card.id }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error || 'Failed to add member')
      setGroups(prev => prev.map(g => g.id === data.id ? data : g))
    } catch (e) {
      setDetailError(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  async function removeMember(cardId) {
    setBusy(true)
    setDetailError(null)
    try {
      const r = await apiFetch(`/api/card-group-members?${new URLSearchParams({ project_id: activeProject.id, group_id: selectedGroupId, card_id: cardId })}`, { method: 'DELETE' })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error || 'Failed to remove member')
      setGroups(prev => prev.map(g => g.id === data.id ? data : g))
    } catch (e) {
      setDetailError(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  async function saveMemberNote(cardId) {
    setBusy(true)
    setDetailError(null)
    try {
      const r = await apiFetch('/api/card-group-members', {
        method: 'PATCH',
        body: JSON.stringify({ project_id: activeProject.id, group_id: selectedGroupId, card_id: cardId, note: memberNoteDraft }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error || 'Failed to update note')
      setGroups(prev => prev.map(g => g.id === data.id ? data : g))
      setEditingMemberKey(null)
    } catch (e) {
      setDetailError(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    setDetailError(null)
    try {
      const r = await apiFetch(`/api/card-groups?id=${selectedGroupId}`, { method: 'DELETE' })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to delete group')
      }
      setGroups(prev => prev.filter(g => g.id !== selectedGroupId))
      setSelectedGroupId(null)
    } catch (e) {
      setDetailError(String(e.message || e))
    } finally {
      setDeleting(false)
    }
  }

  const selectedGroup = groups.find(g => g.id === selectedGroupId) ?? null

  // List view
  if (!selectedGroup) {
    return (
      <div className="flex flex-col h-full min-w-0">
        <div
          className="px-3 py-2 border-b bg-white shrink-0 flex items-center cursor-grab active:cursor-grabbing select-none"
          onMouseDown={onDragStart}
        >
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Groups</span>
          <span className="ml-2 text-[10px] text-gray-400">{groups.length}</span>
          <button
            onClick={() => { setShowNewGroup(v => !v); setCreateError(null) }}
            onMouseDown={e => e.stopPropagation()}
            aria-label="New group"
            title="New group"
            className={`ml-auto text-gray-400 hover:text-gray-600 transition-colors shrink-0 ${showNewGroup ? 'text-purple-500 hover:text-purple-600' : ''}`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          {onClose && (
            <button
              onClick={onClose}
              onMouseDown={e => e.stopPropagation()}
              aria-label="Close"
              className="ml-2 text-gray-400 hover:text-gray-600 transition-colors shrink-0"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {showNewGroup && (
          <div className="px-3 py-3 border-b bg-gray-50 shrink-0 space-y-1.5">
            <p className="text-[10px] text-gray-500">Add at least two cards — a set that only makes sense against each other.</p>
            {newGroupMembers.length > 0 && (
              <ul className="text-[10px] text-gray-600 space-y-0.5 max-h-20 overflow-y-auto">
                {newGroupMembers.map(c => (
                  <li key={c.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{c.name}</span>
                    <button onClick={() => setNewGroupMembers(prev => prev.filter(m => m.id !== c.id))} className="text-gray-300 hover:text-red-500 shrink-0">×</button>
                  </li>
                ))}
              </ul>
            )}
            <CardSearchBar
              activeProject={activeProject}
              excludeIds={newGroupMembers.map(c => c.id)}
              onSelect={c => setNewGroupMembers(prev => [...prev, c])}
              placeholder="Search for a card to add…"
            />
            {createError && <p className="text-[10px] text-red-500">{createError}</p>}
            <div className="flex gap-2">
              <button
                onClick={handleCreateGroup}
                disabled={creating || newGroupMembers.length < 2}
                className="flex-1 px-3 py-1.5 rounded-lg bg-purple-500 text-white text-sm hover:bg-purple-600 disabled:opacity-40 transition-colors"
              >
                {creating ? 'Creating…' : 'Create group'}
              </button>
              <button
                type="button"
                onClick={() => { setShowNewGroup(false); setNewGroupMembers([]); setCreateError(null) }}
                className="px-3 py-1.5 rounded-lg text-gray-500 text-sm hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {loading && <p className="text-xs text-gray-400 text-center mt-8">Loading…</p>}
          {error && <p className="text-xs text-red-500 text-center mt-8">{error}</p>}
          {!loading && !error && groups.length === 0 && (
            <p className="text-xs text-gray-400 text-center mt-8">No groups yet.</p>
          )}
          {groups.map(group => (
            <button
              key={group.id}
              onClick={() => selectGroup(group)}
              className="w-full text-left px-3 py-2.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-gray-800 font-medium truncate">{groupDisplayName(group)}</span>
                <span className="text-[10px] text-gray-400 shrink-0">{group.members.length} card{group.members.length === 1 ? '' : 's'}</span>
              </div>
              {group.note && <p className="text-[11px] text-gray-400 mt-0.5 leading-snug truncate">{group.note}</p>}
            </button>
          ))}
        </div>
      </div>
    )
  }

  // Group tab (detail view)
  return (
    <div className="flex flex-col h-full min-w-0">
      <div
        className="px-3 py-2 border-b bg-white shrink-0 flex items-center gap-2 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={onDragStart}
      >
        <button
          onClick={handleBack}
          onMouseDown={e => e.stopPropagation()}
          className="text-gray-400 hover:text-gray-600 transition-colors shrink-0"
          title="Back to groups"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="text-xs font-semibold text-gray-700 truncate flex-1">{groupDisplayName(selectedGroup)}</span>
        {onClose && (
          <button
            onClick={onClose}
            onMouseDown={e => e.stopPropagation()}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-600 transition-colors shrink-0"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Name</span>
            {!editingName && (
              <button onClick={() => { setEditingName(true); setNameDraft(selectedGroup.name ?? '') }} className="text-[10px] text-purple-500 hover:text-purple-700 font-medium">
                Rename
              </button>
            )}
          </div>
          {editingName ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                className="flex-1 text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-purple-400"
                placeholder={selectedGroup.members.map(m => m.name).join(' · ')}
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                disabled={busy}
              />
              <button onClick={() => { patchGroup({ name: nameDraft }); setEditingName(false) }} disabled={busy} className="text-[10px] px-2 py-1 rounded bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50">Save</button>
              <button onClick={() => setEditingName(false)} className="text-[10px] px-2 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50">Cancel</button>
            </div>
          ) : (
            <p className="text-sm text-gray-800">{groupDisplayName(selectedGroup)}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Shared axis of comparison</span>
            {!editingNote && (
              <button onClick={() => { setEditingNote(true); setNoteDraft(selectedGroup.note ?? '') }} className="text-[10px] text-purple-500 hover:text-purple-700 font-medium">
                Edit
              </button>
            )}
          </div>
          {editingNote ? (
            <div className="space-y-1.5">
              <textarea
                autoFocus
                rows={2}
                className="w-full text-sm border border-gray-300 rounded px-2 py-1 resize-y focus:outline-none focus:ring-1 focus:ring-purple-400"
                placeholder={'e.g. "both mean \'to know\'; the split is knowledge-of-facts vs. familiarity-with"'}
                value={noteDraft}
                onChange={e => setNoteDraft(e.target.value)}
                disabled={busy}
              />
              <div className="flex gap-1.5">
                <button onClick={() => { patchGroup({ note: noteDraft }); setEditingNote(false) }} disabled={busy} className="text-[10px] px-2 py-1 rounded bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50">Save</button>
                <button onClick={() => setEditingNote(false)} className="text-[10px] px-2 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50">Cancel</button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-600 italic">{selectedGroup.note || '(no note yet)'}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Members</span>
          <div className="space-y-1.5">
            {selectedGroup.members.map(member => {
              const isEditingMember = editingMemberKey === member.card_id
              return (
                <div key={member.card_id} className="border border-gray-200 rounded-lg p-2 bg-white">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {onSelectCard ? (
                        <button onClick={() => onSelectCard({ id: member.card_id, name: member.name, kind: member.kind })} className="text-xs font-medium text-gray-800 hover:text-purple-600 truncate transition-colors">
                          {member.name}
                        </button>
                      ) : (
                        <span className="text-xs font-medium text-gray-800 truncate">{member.name}</span>
                      )}
                      <span className={`text-[9px] rounded px-1 py-0.5 shrink-0 ${KIND_COLORS[member.kind] ?? 'bg-gray-100 text-gray-600'}`}>{member.kind}</span>
                    </div>
                    <button
                      onClick={() => removeMember(member.card_id)}
                      disabled={busy}
                      title="Remove from group"
                      className="text-gray-300 hover:text-red-500 disabled:cursor-wait shrink-0"
                    >
                      ×
                    </button>
                  </div>
                  {isEditingMember ? (
                    <div className="flex items-start gap-1.5 mt-1.5">
                      <textarea
                        autoFocus
                        rows={2}
                        className="flex-1 text-xs border border-gray-200 rounded px-1.5 py-1 resize-y focus:outline-none focus:ring-1 focus:ring-purple-400"
                        value={memberNoteDraft}
                        onChange={e => setMemberNoteDraft(e.target.value)}
                      />
                      <div className="flex flex-col gap-1 shrink-0">
                        <button onClick={() => saveMemberNote(member.card_id)} disabled={busy} className="text-[10px] px-2 py-0.5 rounded bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50">Save</button>
                        <button onClick={() => setEditingMemberKey(null)} className="text-[10px] px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setEditingMemberKey(member.card_id); setMemberNoteDraft(member.note ?? '') }}
                      className="text-[11px] text-gray-400 italic mt-1 hover:text-gray-600 transition-colors text-left"
                    >
                      {member.note || 'add a note about what distinguishes this member…'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <CardSearchBar
            activeProject={activeProject}
            excludeIds={selectedGroup.members.map(m => m.card_id)}
            onSelect={addMember}
            placeholder="Add another member…"
          />
        </div>

        {detailError && <p className="text-[10px] text-red-500">{detailError}</p>}

        <div className="border-t pt-3">
          {confirmingDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-600 flex-1">Delete this group? Cards themselves are untouched.</span>
              <button onClick={handleDelete} disabled={deleting} className="text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded px-2 py-1 shrink-0 transition-colors">
                {deleting ? 'Deleting…' : 'Confirm delete'}
              </button>
              <button onClick={() => setConfirmingDelete(false)} disabled={deleting} className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-60 rounded px-2 py-1 shrink-0 transition-colors">
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmingDelete(true)} className="text-xs font-medium text-red-600 hover:text-red-700 transition-colors">
              Delete group
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
