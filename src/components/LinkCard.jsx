import { forwardRef, useImperativeHandle } from 'react'

const LinkCard = forwardRef(function LinkCard({ record, linkState = { status: 'idle' }, onLink, sourceId }, ref) {
  useImperativeHandle(ref, () => ({ save: onLink }))

  const { status, error } = linkState
  const isLinked = status === 'linked'
  const isLinking = status === 'linking'
  const isDisabled = !sourceId || isLinking || isLinked

  const tags = Array.isArray(record.tags) ? record.tags : []

  return (
    <div className="border border-purple-200 rounded-xl bg-purple-50 p-3 space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-purple-600 uppercase tracking-wide">
          Existing Card
        </span>
        <button
          onClick={onLink}
          disabled={isDisabled}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            isLinked
              ? 'bg-green-500 text-white cursor-default'
              : !sourceId
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : isLinking
                  ? 'bg-purple-300 text-white cursor-not-allowed'
                  : 'bg-purple-500 text-white hover:bg-purple-600'
          }`}
        >
          {isLinked ? 'Linked' : isLinking ? 'Linking…' : !sourceId ? 'Save source first' : 'Link to source'}
        </button>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-800">{record.name}</span>
          <span className="text-xs text-gray-500 bg-white border border-gray-200 px-1.5 py-0.5 rounded">
            {record.kind}
          </span>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map(tag => (
              <span key={tag} className="px-1.5 py-0.5 rounded-full text-xs bg-purple-100 text-purple-700">
                {tag}
              </span>
            ))}
          </div>
        )}
        {(record.skill != null || record.importance != null) && (
          <div className="flex gap-3 text-xs text-gray-500">
            {record.skill != null && <span>skill: {record.skill}</span>}
            {record.importance != null && <span>importance: {record.importance}</span>}
          </div>
        )}
      </div>

      {status === 'error' && (
        <p className="text-xs text-red-500">{error}</p>
      )}
    </div>
  )
})

export default LinkCard
