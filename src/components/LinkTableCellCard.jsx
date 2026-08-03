import { forwardRef, useImperativeHandle } from 'react'

const LinkTableCellCard = forwardRef(function LinkTableCellCard({ record, linkState = { status: 'idle' }, sourceId, tableCellId, tableName, axisValues, onLink }, ref) {
  const { status, error } = linkState
  const isLinked = status === 'linked'
  const isLinking = status === 'linking'
  const blocked = !sourceId || !tableCellId
  const isDisabled = isLinking || isLinked || blocked

  const axisChips = axisValues ? Object.entries(axisValues).map(([axis, val]) => `${axis}: ${val}`) : []

  async function handleLink() {
    onLink?.()
  }

  useImperativeHandle(ref, () => ({ save: handleLink }))

  return (
    <div className="border border-purple-200 rounded-xl bg-purple-50 p-3 space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-purple-600 uppercase tracking-wide">Cell Link</span>
        <button
          onClick={handleLink}
          disabled={isDisabled}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            isLinked
              ? 'bg-green-500 text-white cursor-default'
              : isLinking
                ? 'bg-purple-300 text-white cursor-not-allowed'
                : blocked
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-purple-500 text-white hover:bg-purple-600'
          }`}
        >
          {isLinked ? 'Linked' : isLinking ? 'Linking…' : blocked ? (!sourceId ? 'Save source first' : 'Save cell first') : 'Link'}
        </button>
      </div>

      {tableName && (
        <p className="text-xs text-gray-500">Table: <span className="font-medium text-gray-700">{tableName}</span></p>
      )}

      {axisChips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {axisChips.map(chip => (
            <span key={chip} className="px-2 py-0.5 rounded-full text-xs bg-purple-100 text-purple-800 font-mono">{chip}</span>
          ))}
        </div>
      )}

      {record.excerpt && (
        <div>
          <label className="block text-xs mb-0.5 text-gray-500">excerpt</label>
          <p className="text-xs font-mono bg-white border border-gray-200 rounded px-2 py-1">{record.excerpt}</p>
        </div>
      )}

      {record.note && (
        <div>
          <label className="block text-xs mb-0.5 text-gray-500">note</label>
          <p className="text-xs text-gray-700">{record.note}</p>
        </div>
      )}

      {status === 'error' && (
        <p className="text-xs text-red-500">{error}</p>
      )}
    </div>
  )
})

export default LinkTableCellCard
