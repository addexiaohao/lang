import { apiFetch } from './apiFetch.js'

// Shared by PracticeStart.jsx's "Quick practice" button and PracticePanel.jsx's "More practice"
// (end-of-session) button — both need the same fresh, scheduler-respecting selection
// (api/skills.js's `sort=weighted`, backed by lib/practiceSelection.js). Previously "Practice
// again" just replayed PracticePanel's existing `skills` prop with local state reset, which meant
// a skill just answered correctly (due_at pushed a day-plus out) could immediately reappear —
// the replayed list never re-checked due_at/cooldown at all. Re-fetching here instead of reusing
// the old selection is the fix.
export const QUICK_START_COUNT = 10

export async function fetchQuickStartSkills(activeProject, count = QUICK_START_COUNT) {
  const params = new URLSearchParams({
    project_id: activeProject.id,
    sort: 'weighted',
    limit: String(count),
  })
  const res = await apiFetch(`/api/skills?${params}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'Failed to load skills')
  const skills = (data.skills ?? []).map((row) => ({ card: row.card, type: row.type }))
  if (skills.length === 0) throw new Error('No skills yet — save some cards from Learn first.')
  const meta = data.cap_hit
    ? { capNotice: `Working through ${data.relearning_count} tricky ones — no new words until this shrinks.` }
    : undefined
  return { skills, meta }
}
