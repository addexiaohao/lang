import { useState } from 'react'
import { PracticePanel } from '../panels/PracticePanel.jsx'
import { PracticeStart } from '../PracticeStart.jsx'
import { CardsPanel } from '../panels/CardsPanel.jsx'

// Single centered item, no side panels (plan.md mode table). Mounted once at the App level
// regardless of which mode is active — see App.jsx's always-mount/CSS-visibility approach — so an
// in-progress session survives a trip to Library and back with the same item and progress
// (plan.md B2). When there's no session, `browsing` swaps the centered card between the
// quick-start empty state and a full CardsPanel (same multi-select + Practice footer Library
// uses) so cards can be picked without leaving Practice — the card->practice pathway itself
// (onStartPractice) is unchanged either way.
export function PracticeMode({
  activeProject, practiceSession, onStartPractice, onEndSession,
  onSelectCard, peekCardId,
  generatedContext, tagCatalog, onNewTags,
}) {
  const [browsing, setBrowsing] = useState(false)
  // How many of PracticePanel's docked side panels (Why?/Explain, Add source) are open right now
  // — both can be open together, each its own column, so this is a count (0/1/2), not a boolean.
  const [openSidePanels, setOpenSidePanels] = useState(0)

  return (
    <div className="h-full w-full flex items-center justify-center bg-gray-50 overflow-hidden">
      {/* This outer slot's width is constant regardless of `openSidePanels` — it reserves room for
          the widest possible box (base box + both docked side panels) and stays centered by the
          parent's justify-center. The box itself left-aligns inside it, so growing the box
          (Why?/Add source) only extends its right edge — the base practice content never shifts left. */}
      <div className="w-full h-full md:h-[85%] md:my-auto md:max-w-7xl flex justify-start">
        <div className={`w-full h-full bg-white md:rounded-xl md:shadow-sm overflow-hidden flex flex-col ${
          openSidePanels >= 2 ? 'md:max-w-6xl' : openSidePanels === 1 ? 'md:max-w-3xl' : browsing && !practiceSession ? 'md:max-w-2xl' : 'md:max-w-xl'
        }`}>
          {practiceSession ? (
            <PracticePanel
              activeProject={activeProject}
              practiceSession={practiceSession}
              onClose={onEndSession}
              onSidePanelCountChange={setOpenSidePanels}
              generatedContext={generatedContext}
              tagCatalog={tagCatalog}
              onNewTags={onNewTags}
            />
          ) : browsing ? (
            <CardsPanel
              activeProject={activeProject}
              onSelectCard={onSelectCard}
              selectedCardId={peekCardId}
              onClose={() => setBrowsing(false)}
              onStartPractice={onStartPractice}
            />
          ) : (
            <PracticeStart activeProject={activeProject} onStart={onStartPractice} onBrowse={() => setBrowsing(true)} />
          )}
        </div>
      </div>
    </div>
  )
}
