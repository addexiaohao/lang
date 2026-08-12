// Hosts a single, always-mounted <ChatPanel/> (passed as children) and repositions it purely via
// CSS depending on mode — inline as the Learn-mode column, or as a slide-over drawer everywhere
// else. This is what "one chat, two mountings" means: the component underneath never remounts,
// so its conversation state survives every mode switch and drawer open/close.
//
// The two wrapper divs below are ALWAYS both rendered, in the same order, every render — only
// their className changes with `variant`/`open`. This keeps the returned tree shape identical
// across variant changes, which is what stops React from unmounting/remounting `children` when
// the mode switches (a conditionally-rendered backdrop would shift the content div's position
// in the tree and reset it).
export function ChatDock({ variant, open, onBackdropClick, children }) {
  const isDrawer = variant !== 'column'
  const backdropVisible = isDrawer && open

  return (
    <>
      <div
        onClick={backdropVisible ? onBackdropClick : undefined}
        aria-hidden="true"
        className={`fixed inset-0 bg-black/20 z-40 transition-opacity duration-200 ${
          backdropVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />
      <div
        className={
          isDrawer
            ? `fixed inset-y-0 right-0 w-[420px] max-w-full bg-white shadow-xl z-50 transition-transform duration-200 ${
                open ? 'translate-x-0' : 'translate-x-full pointer-events-none'
              }`
            : 'flex-1 min-w-0 h-full'
        }
      >
        {children}
      </div>
    </>
  )
}
