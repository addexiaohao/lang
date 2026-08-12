import { useState } from 'react'
import { apiFetch } from '../apiFetch.js'

// Practice-entry path 2 (plan.md B5): quick-start with no card picking. Practices the most
// recently added cards. Deliberately no scheduling/spacing logic — see plan.md non-goals.
const QUICK_START_COUNT = 10

// "Random" is the same quick-start idea (plan.md B5: "most recently added N, or a random
// selection") but sampling uniformly across every card in the project instead of just the
// newest ones. No backend random endpoint exists (or is warranted at this app's
// personal-project scale) — /api/knowledge-cards already reports `total` under offset/limit
// pagination, so true uniform sampling is just N random offsets fetched with limit=1 each,
// no DB changes required. `selectionMethod` is fixed to 'random' for now; kept as an explicit
// param so a future picker (by tag, by skill, etc.) has somewhere to plug in without
// reshaping this function.
const RANDOM_COUNT = 10

function randomOffsets(total, n) {
  const count = Math.min(total, n)
  const offsets = new Set()
  while (offsets.size < count) {
    offsets.add(Math.floor(Math.random() * total))
  }
  return [...offsets]
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
        sort: 'recent',
        limit: String(QUICK_START_COUNT),
      })
      const res = await apiFetch(`/api/knowledge-cards?${params}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Failed to load cards')
      const cards = data.cards ?? []
      if (cards.length === 0) {
        setError('No cards yet — save some from Learn first.')
        return
      }
      onStart(cards, 'mc_cloze')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleRandomStart(selectionMethod = 'random') {
    if (!activeProject) return
    setRandomLoading(true)
    setError(null)
    try {
      const countRes = await apiFetch(`/api/knowledge-cards?${new URLSearchParams({
        project_id: activeProject.id,
        limit: '1',
      })}`)
      const countData = await countRes.json().catch(() => ({}))
      if (!countRes.ok) throw new Error(countData.error ?? 'Failed to load cards')
      const total = countData.total ?? 0
      if (total === 0) {
        setError('No cards yet — save some from Learn first.')
        return
      }

      const offsets = selectionMethod === 'random'
        ? randomOffsets(total, RANDOM_COUNT)
        : Array.from({ length: Math.min(total, RANDOM_COUNT) }, (_, i) => i)

      const picks = await Promise.all(offsets.map(async (offset) => {
        const res = await apiFetch(`/api/knowledge-cards?${new URLSearchParams({
          project_id: activeProject.id,
          limit: '1',
          offset: String(offset),
        })}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error ?? 'Failed to load cards')
        return data.cards?.[0]
      }))

      const cards = picks.filter(Boolean)
      if (cards.length === 0) {
        setError('No cards yet — save some from Learn first.')
        return
      }
      onStart(cards, 'mc_cloze')
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
          onClick={() => handleRandomStart()}
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
