import { useEffect } from 'react'

// Generic slide-over used for the "peek" overlay (card/source/tag detail from Learn or Practice
// mode) — see plan.md B4. Unlike ChatDock, content here is fine to unmount on close: the panels
// it hosts already fetch fresh on mount by id, so there's no state worth preserving across opens.
export function Overlay({ open, onClose, headerExtra, children }) {
  useEffect(() => {
    if (!open) return
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden="true"
        className="fixed inset-0 bg-black/20 z-40"
      />
      <div className="fixed inset-y-0 right-0 w-[420px] max-w-full bg-white shadow-xl z-50 flex flex-col">
        {headerExtra && (
          <div className="shrink-0 px-3 py-2 border-b bg-gray-50 flex items-center justify-end">
            {headerExtra}
          </div>
        )}
        <div className="flex-1 min-h-0">{children}</div>
      </div>
    </>
  )
}
