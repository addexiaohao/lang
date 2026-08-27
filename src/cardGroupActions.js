import { apiFetch } from './apiFetch.js'

// Shared Card Groups operations (plan.md — "Card Groups") — the same handful of API calls used by
// CardDetailPanel's "Relate this card…" and, now, the chat save flow's "Relate to…" on a proposed
// card (SaveCard.jsx/LinkCard.jsx). Centralized so the §2 resolution rule (below) has exactly one
// implementation.

export async function fetchCardGroups(projectId, cardId) {
  const r = await apiFetch(`/api/card-groups?${new URLSearchParams({ project_id: projectId, card_id: cardId })}`)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || r.statusText)
  return data.groups ?? []
}

export async function createCardGroup(projectId, memberCardIds) {
  const r = await apiFetch('/api/card-groups', {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, member_card_ids: memberCardIds }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || r.statusText)
  return data
}

export async function addCardToGroup(projectId, groupId, cardId) {
  const r = await apiFetch('/api/card-group-members', {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, group_id: groupId, card_id: cardId }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || r.statusText)
  return data
}

// The resolution rule from plan.md §2: relating `cardId` to `targetId` — no group yet -> create
// one with both; exactly one -> add the target to it; several -> ambiguous, the caller must ask
// the user which (returns `{ resolved: false, groups }` instead of guessing).
export async function relateCard(projectId, cardId, targetId) {
  const groups = await fetchCardGroups(projectId, cardId)
  if (groups.length === 0) {
    await createCardGroup(projectId, [cardId, targetId])
    return { resolved: true }
  }
  if (groups.length === 1) {
    await addCardToGroup(projectId, groups[0].id, targetId)
    return { resolved: true }
  }
  return { resolved: false, groups }
}

export function groupDisplayName(group) {
  return group.name || group.members.map(m => m.name).join(' · ')
}
