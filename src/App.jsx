import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProject } from './ProjectContext.jsx'
import { apiFetch } from './apiFetch.js'
import { supabase } from './supabaseClient.js'
import { Sidebar } from './components/Sidebar.jsx'
import { ProjectSwitcher } from './components/ProjectSwitcher.jsx'
import { SettingsModal } from './components/SettingsModal.jsx'
import { ChatDock } from './components/ChatDock.jsx'
import { Overlay } from './components/Overlay.jsx'
import { ChatPanel } from './components/panels/ChatPanel.jsx'
import { CardDetailPanel } from './components/panels/CardDetailPanel.jsx'
import { TagsPanel } from './components/panels/TagsPanel.jsx'
import { LibraryMode, LIBRARY_DEFAULT_WIDTHS } from './components/modes/LibraryMode.jsx'
import { PracticeMode } from './components/modes/PracticeMode.jsx'

// Three activity modes replace the old entity-based sidebar (plan.md Part B). Library/Learn/
// Practice are all mounted here unconditionally and only *hidden* via CSS `display` depending on
// `mode` — never conditionally rendered with `mode === x && <X/>`. That's what stops a mode
// switch from resetting anything: the chat conversation, an in-progress practice session, and
// Library's scroll/filter/selection state all live inside components that simply never unmount.
const DEFAULT_LIBRARY_LAYOUT = { openPanels: ['cards'], panelWidths: { cards: LIBRARY_DEFAULT_WIDTHS.cards } }

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // localStorage unavailable (private mode, quota) — layout just won't persist.
  }
}

export default function App() {
  const { activeProject, loading: projectsLoading } = useProject()
  const [contexts, setContexts] = useState([])
  const [tagCatalog, setTagCatalog] = useState([])
  const navigate = useNavigate()

  const [mode, setMode] = useState('learn')
  const [libraryLayout, setLibraryLayout] = useState(DEFAULT_LIBRARY_LAYOUT)

  // Library's own selection state — lifted here (rather than local to LibraryMode) only so the
  // card peek overlay's "Open in Library" hand-off can reach into it.
  const [selectedSource, setSelectedSource] = useState(null)
  const [selectedCard, setSelectedCard] = useState(null)
  const [selectedTag, setSelectedTag] = useState(null)

  // Practice session is deliberately NOT persisted to localStorage — see PracticePanel.jsx's own
  // "reload and it's gone, by design" comment. Surviving mode switches (via always-mount) is the
  // whole requirement; surviving a reload isn't.
  const [practiceSession, setPracticeSession] = useState(null)
  const [peek, setPeek] = useState(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const chatPanelRef = useRef(null)

  useEffect(() => {
    if (!activeProject) return
    apiFetch(`/api/contexts?project_id=${activeProject.id}`)
      .then(r => r.ok ? r.json() : [])
      .then(async list => {
        // The "generated" context marks sources whose text the LLM produced itself (Practice's
        // "Add source" chat), rather than something the user encountered — it's a plain row in
        // `contexts` like any other, just one the frontend creates on demand and never offers as
        // a manual pick (filtered out of `pickableContexts` below).
        if (!list.some(c => c.name === 'generated')) {
          try {
            const res = await apiFetch('/api/contexts', {
              method: 'POST',
              body: JSON.stringify({ project_id: activeProject.id, name: 'generated' }),
            })
            if (res.ok) list = [...list, await res.json()]
          } catch {
            // best-effort; the Add-source chat just stays disabled until this succeeds
          }
        }
        setContexts(list)
      })
      .catch(() => {})
    apiFetch(`/api/tags?project_id=${activeProject.id}&limit=300`)
      .then(r => r.ok ? r.json() : [])
      .then(setTagCatalog)
      .catch(() => {})
  }, [activeProject?.id])

  // The one context users are never allowed to hand-pick — see effect above.
  const generatedContext = contexts.find(c => c.name === 'generated') ?? null
  const pickableContexts = contexts.filter(c => c.name !== 'generated')

  const refreshTagCatalog = useCallback(() => {
    if (!activeProject) return
    apiFetch(`/api/tags?project_id=${activeProject.id}&limit=300`)
      .then(r => r.ok ? r.json() : [])
      .then(setTagCatalog)
      .catch(() => {})
  }, [activeProject?.id])

  // Hydrate mode + per-mode layout from localStorage, and clear ephemeral state, on project switch.
  useEffect(() => {
    if (!activeProject) return
    const id = activeProject.id
    setMode(loadJSON(`lang:mode:${id}`, 'learn'))
    setLibraryLayout(loadJSON(`lang:layout:library:${id}`, DEFAULT_LIBRARY_LAYOUT))
    setSelectedSource(null)
    setSelectedCard(null)
    setSelectedTag(null)
    setPeek(null)
    setPracticeSession(null)
    setDrawerOpen(false)
  }, [activeProject?.id])

  useEffect(() => {
    if (activeProject) saveJSON(`lang:mode:${activeProject.id}`, mode)
  }, [mode, activeProject?.id])

  useEffect(() => {
    if (activeProject) saveJSON(`lang:layout:library:${activeProject.id}`, libraryLayout)
  }, [libraryLayout, activeProject?.id])

  async function handleLogout() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  // The only cross-mode hand-off in the app (plan.md B5): Library's card multi-select + "Practice"
  // footer, and Practice's own quick-start, both funnel through here. `skills` is a list of
  // { card, type } pairs — practice is generated per-skill now, not per-card (see
  // lib/practiceRules.js and CLAUDE.md's "Skills" section); each skill's question type is decided
  // server-side by the rule registry, not chosen here.
  function handleStartPractice(skills) {
    setPracticeSession({ skills })
    setMode('practice')
  }

  function handleEndPracticeSession() {
    setPracticeSession(null)
  }

  // Reveals chat: already visible in Learn; opens the drawer everywhere else. Used by Practice's
  // Explain/Why? buttons, the chat FAB, and every panel's "add to chat" action.
  function revealChat(text) {
    if (mode !== 'learn') setDrawerOpen(true)
    if (text) {
      chatPanelRef.current?.clearMessages()
      setChatInput(text)
    }
  }

  function openPeekCard(card, highlightSkillType) { setPeek({ type: 'card', card, highlightSkillType }) }
  function openPeekTag(tagName) { setPeek({ type: 'tag', tagName }) }
  function closePeek() { setPeek(null) }
  function handlePeekCardRenamed(cardId, newName) {
    setPeek(prev => (prev?.type === 'card' && prev.card.id === cardId) ? { ...prev, card: { ...prev.card, name: newName } } : prev)
  }

  // Card peek overlay's "Open in Library" (plan.md B4): switches mode, makes sure Library has the
  // right panels open, and hands the card to Library's own selection state.
  function handleOpenPeekInLibrary() {
    if (peek?.type !== 'card') return
    const card = peek.card
    setMode('library')
    setLibraryLayout(prev => {
      let openPanels = prev.openPanels
      if (!openPanels.includes('cards')) openPanels = [...openPanels, 'cards']
      if (!openPanels.includes('card-detail')) openPanels = [...openPanels, 'card-detail']
      return { ...prev, openPanels }
    })
    setSelectedCard(card)
    setPeek(null)
  }

  // Clicking a source inside the card peek overlay (Practice mode's card browser has no source
  // panel of its own) — same hand-off shape as "Open in Library" above, but for a source.
  function handleOpenSourceInLibrary(source) {
    setMode('library')
    setLibraryLayout(prev => {
      let openPanels = prev.openPanels
      if (!openPanels.includes('sources')) openPanels = [...openPanels, 'sources']
      if (!openPanels.includes('source-detail')) openPanels = [...openPanels, 'source-detail']
      return { ...prev, openPanels }
    })
    setSelectedSource(source)
    setPeek(null)
  }

  if (projectsLoading) return null

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        mode={mode}
        onModeChange={setMode}
        onOpenSettings={() => setShowSettings(true)}
        onLogout={handleLogout}
        header={<ProjectSwitcher />}
      />

      <div className="flex flex-1 overflow-hidden relative">
        <div style={{ display: mode === 'library' ? 'flex' : 'none' }} className="flex-1 min-w-0 h-full overflow-hidden">
          <LibraryMode
            activeProject={activeProject}
            contexts={contexts}
            setContexts={setContexts}
            tagCatalog={tagCatalog}
            onNewTags={refreshTagCatalog}
            layout={libraryLayout}
            onLayoutChange={setLibraryLayout}
            selectedSource={selectedSource} setSelectedSource={setSelectedSource}
            selectedCard={selectedCard} setSelectedCard={setSelectedCard}
            selectedTag={selectedTag} setSelectedTag={setSelectedTag}
            onAppendToChat={revealChat}
            onStartPractice={handleStartPractice}
          />
        </div>

        <div style={{ display: mode === 'practice' ? 'flex' : 'none' }} className="flex-1 h-full overflow-hidden">
          <PracticeMode
            activeProject={activeProject}
            practiceSession={practiceSession}
            onStartPractice={handleStartPractice}
            onEndSession={handleEndPracticeSession}
            onSelectCard={openPeekCard}
            peekCardId={peek?.type === 'card' ? peek.card.id : null}
            generatedContext={generatedContext}
            tagCatalog={tagCatalog}
            onNewTags={refreshTagCatalog}
          />
        </div>

        <ChatDock
          variant={mode === 'learn' ? 'column' : 'drawer'}
          open={drawerOpen}
          onBackdropClick={() => setDrawerOpen(false)}
        >
          <ChatPanel
            ref={chatPanelRef}
            activeProject={activeProject}
            contexts={pickableContexts}
            tagCatalog={tagCatalog}
            onNewTags={refreshTagCatalog}
            input={chatInput}
            onInputChange={setChatInput}
            onClose={mode === 'learn' ? undefined : () => setDrawerOpen(false)}
          />
        </ChatDock>

        {mode !== 'learn' && (
          <button
            onClick={() => setDrawerOpen(o => !o)}
            aria-label="Toggle chat"
            title="Chat"
            className={`fixed bottom-6 right-6 z-30 w-12 h-12 rounded-full bg-blue-600 text-white shadow-lg flex items-center justify-center hover:bg-blue-700 transition-transform ${
              drawerOpen ? 'scale-0' : 'scale-100'
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
          </button>
        )}

        <Overlay
          open={peek != null}
          onClose={closePeek}
          headerExtra={peek?.type === 'card' ? (
            <button
              onClick={handleOpenPeekInLibrary}
              className="text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors"
            >
              Open in Library
            </button>
          ) : null}
        >
          {peek?.type === 'card' && (
            <CardDetailPanel
              card={peek.card}
              activeProject={activeProject}
              onClose={closePeek}
              onDeleted={closePeek}
              onRenamed={handlePeekCardRenamed}
              onAppendToChat={revealChat}
              onSelectTag={openPeekTag}
              onSelectSource={handleOpenSourceInLibrary}
              highlightSkillType={peek.highlightSkillType}
            />
          )}
          {peek?.type === 'tag' && (
            <TagsPanel
              activeProject={activeProject}
              tagCatalog={tagCatalog}
              onNewTags={refreshTagCatalog}
              onClose={closePeek}
              selectedTag={peek.tagName}
              onSelectTag={openPeekTag}
              onSelectCard={openPeekCard}
              selectedCardId={null}
            />
          )}
        </Overlay>

        {showSettings && activeProject && (
          <SettingsModal project={activeProject} onClose={() => setShowSettings(false)} />
        )}
      </div>
    </div>
  )
}
