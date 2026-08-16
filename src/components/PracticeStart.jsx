import { useState } from 'react'
import { apiFetch } from '../apiFetch.js'

// Practice-entry path 2 (plan.md B5): quick-start with no picking. Samples skill rows
// project-wide (skills are the practice unit now, not cards — see lib/practiceRules.js and
// CLAUDE.md's "Skills" section), excluding anything answered correctly in the past
// EXCLUDE_RECENT_DAYS (see api/skills.js), weighted by importance rather than sorted by
// recency — see api/skills.js's `sort=weighted` mode for the actual sampling.
const QUICK_START_COUNT = 10

// "Random" is the same quick-start idea (plan.md B5: "most recently added N, or a random
// selection") but sampling uniformly across every skill in the project instead of just the
// newest ones. No backend random endpoint exists (or is warranted at this app's
// personal-project scale) — /api/skills already reports `total` under offset/limit pagination,
// so true uniform sampling is just N random offsets fetched with limit=1 each, no DB changes
// required.
const RANDOM_COUNT = 10

function randomOffsets(total, n) {
  const count = Math.min(total, n)
  const offsets = new Set()
  while (offsets.size < count) {
    offsets.add(Math.floor(Math.random() * total))
  }
  return [...offsets]
}

function toSkill(row) {
  return { card: row.card, type: row.type }
}

export function PracticeStart({ activeProject, onStart, onBrowse }) {
  const [loading, setLoading] = useState(false)
  const [randomLoading, setRandomLoading] = useState(false)
  const [error, setError] = useState(null)

  async function handleQuickStart() {
    if (!activeProject) return
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        project_id: activeProject.id,
        sort: 'weighted',
        limit: String(QUICK_START_COUNT),
      })
      const res = await apiFetch(`/api/skills?${params}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Failed to load skills')
      const skills = (data.skills ?? []).map(toSkill)
      if (skills.length === 0) {
        setError('No skills yet — save some cards from Learn first.')
        return
      }
      onStart(skills)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleRandomStart() {
    if (!activeProject) return
    setRandomLoading(true)
    setError(null)
    try {
      const countRes = await apiFetch(`/api/skills?${new URLSearchParams({
        project_id: activeProject.id,
        limit: '1',
      })}`)
      const countData = await countRes.json().catch(() => ({}))
      if (!countRes.ok) throw new Error(countData.error ?? 'Failed to load skills')
      const total = countData.total ?? 0
      if (total === 0) {
        setError('No skills yet — save some cards from Learn first.')
        return
      }

      const offsets = randomOffsets(total, RANDOM_COUNT)

      const picks = await Promise.all(offsets.map(async (offset) => {
        const res = await apiFetch(`/api/skills?${new URLSearchParams({
          project_id: activeProject.id,
          limit: '1',
          offset: String(offset),
        })}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error ?? 'Failed to load skills')
        return data.skills?.[0]
      }))

      const skills = picks.filter(Boolean).map(toSkill)
      if (skills.length === 0) {
        setError('No skills yet — save some cards from Learn first.')
        return
      }
      onStart(skills)
    } catch (e) {
      setError(e.message)
    } finally {
      setRandomLoading(false)
    }
  }

  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
      <div>
        <p className="text-sm font-medium text-gray-800">Nothing to practice yet</p>
        <p className="text-xs text-gray-400 mt-1">
          Pick cards from Library, or jump in with your most recent ones.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleQuickStart}
          disabled={loading || !activeProject}
          className="text-sm font-medium bg-blue-600 text-white rounded-lg px-4 py-1.5 hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          {loading ? 'Loading…' : 'Quick practice'}
        </button>
        <button
          onClick={handleRandomStart}
          disabled={randomLoading || !activeProject}
          className="text-sm font-medium bg-purple-600 text-white rounded-lg px-4 py-1.5 hover:bg-purple-700 disabled:opacity-40 transition-colors"
        >
          {randomLoading ? 'Loading…' : 'Random'}
        </button>
        <button
          onClick={onBrowse}
          disabled={!activeProject}
          className="text-sm font-medium text-gray-600 border border-gray-200 rounded-lg px-4 py-1.5 hover:bg-gray-50 disabled:opacity-40 transition-colors"
        >
          Browse cards
        </button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}
