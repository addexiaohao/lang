import { useState, useRef, useEffect } from 'react'

function rangesToIndexSet(ranges) {
  const set = new Set()
  for (const { start, end } of ranges) {
    for (let i = start; i < end; i++) set.add(i)
  }
  return set
}

function indexSetToRanges(set) {
  const indices = [...set].sort((a, b) => a - b)
  const ranges = []
  for (const i of indices) {
    const last = ranges[ranges.length - 1]
    if (last && last.end === i) last.end = i + 1
    else ranges.push({ start: i, end: i + 1 })
  }
  return ranges
}

// Lets the user fix up a marked span by clicking or dragging over the plain
// sentence text, toggling each character's highlight on/off (like a highlighter
// pen). `positions` are the current marked ranges local to `text`; `onChange`
// receives the new ranges once the user confirms.
export default function AnnotatedSpanEditor({ text, positions, highlightClassName, onChange, onCancel }) {
  const [selected, setSelected] = useState(() => rangesToIndexSet(positions))
  const draggingRef = useRef(false)
  const paintValueRef = useRef(true)

  useEffect(() => {
    const stopDrag = () => { draggingRef.current = false }
    window.addEventListener('mouseup', stopDrag)
    return () => window.removeEventListener('mouseup', stopDrag)
  }, [])

  function paint(index) {
    setSelected(prev => {
      const next = new Set(prev)
      if (paintValueRef.current) next.add(index)
      else next.delete(index)
      return next
    })
  }

  function handleMouseDown(index) {
    draggingRef.current = true
    paintValueRef.current = !selected.has(index)
    paint(index)
  }

  function handleMouseEnter(index) {
    if (draggingRef.current) paint(index)
  }

  return (
    <div className="space-y-2">
      <p className="text-xs leading-relaxed font-mono select-none cursor-text" onDragStart={e => e.preventDefault()}>
        {text.split('').map((ch, i) => (
          <span
            key={i}
            onMouseDown={() => handleMouseDown(i)}
            onMouseEnter={() => handleMouseEnter(i)}
            className={selected.has(i) ? `${highlightClassName} rounded-sm` : ''}
          >
            {ch}
          </span>
        ))}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(indexSetToRanges(selected))}
          disabled={selected.size === 0}
          className="px-2 py-1 text-xs font-medium rounded-md bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Done
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-1 text-xs font-medium rounded-md bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors"
        >
          Cancel
        </button>
        <span className="text-[10px] text-gray-400">Click or drag to select/deselect text</span>
      </div>
    </div>
  )
}
