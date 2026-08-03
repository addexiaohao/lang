import { useRef } from 'react'

export function ResizeHandle({ onDrag }) {
  const startXRef = useRef(null)

  function onMouseDown(e) {
    e.preventDefault()
    startXRef.current = e.clientX

    function onMouseMove(e) {
      const dx = e.clientX - startXRef.current
      startXRef.current = e.clientX
      onDrag(dx)
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 shrink-0 cursor-col-resize bg-gray-200 hover:bg-blue-400 active:bg-blue-500 transition-colors"
    />
  )
}
