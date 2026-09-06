import { useState, useEffect } from 'react'
import { apiFetch } from '../../apiFetch.js'

const DEFAULT_LIMIT = 50

// Raw pass/fail breakdown for the mc_cloze answer-uniqueness check (CLAUDE.md's "Practice
// generation") over the last N mc_cloze practice attempts — see api/mc-cloze-stats.js for the
// three states (succeeded in one pass / failed once and recovered on retry / failed twice and was
// never served) and why they need no row-by-row attribution between practice_attempt and
// mc_cloze_check_failure. Debug mode's "MC-cloze stats" tab.
export function McClozeStatsPanel({ activeProject }) {
  const [limit, setLimit] = useState(DEFAULT_LIMIT)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!activeProject) return
    setLoading(true)
    setError(null)
    apiFetch(`/api/mc-cloze-stats?project_id=${activeProject.id}&limit=${limit}`)
      .then(r => { if (!r.ok) throw new Error('Failed to load stats'); return r.json() })
      .then(setStats)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [activeProject?.id, limit])

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="flex items-center gap-2 mb-4">
        <label className="text-sm text-gray-600">Among the last</label>
        <input
          type="number"
          min={1}
          max={500}
          value={limit}
          onChange={e => setLimit(Math.min(Math.max(Number(e.target.value) || 1, 1), 500))}
          className="w-20 border border-gray-300 rounded px-2 py-1 text-sm"
        />
        <label className="text-sm text-gray-600">mc_cloze generation attempts</label>
      </div>

      {loading && <p className="text-sm text-gray-400">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {!loading && !error && stats && (
        stats.total_attempted === 0 ? (
          <p className="text-sm text-gray-400">No mc_cloze practice attempts found.</p>
        ) : (
          <div className="space-y-3">
            <Row label="Succeeded in one pass" value={stats.succeeded_one_pass} total={stats.total_attempted} color="bg-green-500" />
            <Row label="Failed once, recovered on retry" value={stats.failed_once_recovered} total={stats.total_attempted} color="bg-amber-500" />
            <Row label="Failed twice, never served" value={stats.failed_twice_unserved} total={stats.total_attempted} color="bg-red-500" />
            <p className="text-xs text-gray-400 pt-1">
              Out of {stats.total_attempted} generation attempts — including ones that were never served
              because both the initial check and the retry failed.
            </p>
          </div>
        )
      )}
    </div>
  )
}

function Row({ label, value, total, color }) {
  const pct = total ? Math.round((value / total) * 100) : null
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-sm text-gray-700">{label}</span>
        <span className="text-sm font-medium text-gray-800">
          {value}{total != null && <span className="text-gray-400"> / {total} ({pct}%)</span>}
        </span>
      </div>
      {total != null && (
        <div className="h-1.5 bg-gray-100 rounded overflow-hidden">
          <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}
