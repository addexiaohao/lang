export function GrabHandle({ onDragStart }) {
  return (
    <div
      className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 flex items-center px-1 mr-1 shrink-0 select-none"
      onMouseDown={onDragStart}
    >
      <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
        <circle cx="3" cy="2" r="1.5" />
        <circle cx="3" cy="7" r="1.5" />
        <circle cx="3" cy="12" r="1.5" />
        <circle cx="7" cy="2" r="1.5" />
        <circle cx="7" cy="7" r="1.5" />
        <circle cx="7" cy="12" r="1.5" />
      </svg>
    </div>
  )
}
