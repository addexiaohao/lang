import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProject } from './ProjectContext.jsx'
import { apiFetch } from './apiFetch.js'
import { supabase } from './supabaseClient.js'
import { Sidebar } from './components/Sidebar.jsx'
import { ResizeHandle } from './components/ResizeHandle.jsx'
import { ProjectSwitcher } from './components/ProjectSwitcher.jsx'
import { ChatPanel } from './components/panels/ChatPanel.jsx'
import { SourcesPanel } from './components/panels/SourcesPanel.jsx'
import { SourceDetailPanel } from './components/panels/SourceDetailPanel.jsx'
import { ContextsPanel } from './components/panels/ContextsPanel.jsx'
import { TagsPanel } from './components/panels/TagsPanel.jsx'
import { CardsPanel } from './components/panels/CardsPanel.jsx'
import { CardDetailPanel } from './components/panels/CardDetailPanel.jsx'

const DEFAULT_WIDTHS = {
  chat: 560,
  sources: 300,
  'source-detail': 360,
  cards: 340,
  'card-detail': 360,
  tags: 340,
  contexts: 340,
}
const MIN_WIDTH = 100

export default function App() {
  const { activeProject, loading: projectsLoading } = useProject()
  const [contexts, setContexts] = useState([])
  const [tagCatalog, setTagCatalog] = useState([])
  const navigate = useNavigate()

  const [openPanels, setOpenPanels] = useState(['chat'])
  const [panelWidths, setPanelWidths] = useState({ chat: DEFAULT_WIDTHS.chat })
  const [selectedSource, setSelectedSource] = useState(null)
  const [selectedCard, setSelectedCard] = useState(null)
  const [selectedTag, setSelectedTag] = useState(null)
  const [chatInput, setChatInput] = useState('')
  const [draggingIndex, setDraggingIndex] = useState(null)
  const [dragOverIndex, setDragOverIndex] = useState(null)
  const dragRef = useRef({ from: null, to: null })
  const panelContainerRef = useRef(null)

  useEffect(() => {
    if (!activeProject) return
    apiFetch(`/api/contexts?project_id=${activeProject.id}`)
      .then(r => r.ok ? r.json() : [])
      .then(setContexts)
      .catch(() => {})
    apiFetch(`/api/tags?project_id=${activeProject.id}&limit=300`)
      .then(r => r.ok ? r.json() : [])
      .then(setTagCatalog)
      .catch(() => {})
  }, [activeProject?.id])

  const refreshTagCatalog = useCallback(() => {
    if (!activeProject) return
    apiFetch(`/api/tags?project_id=${activeProject.id}&limit=300`)
      .then(r => r.ok ? r.json() : [])
      .then(setTagCatalog)
      .catch(() => {})
  }, [activeProject?.id])

  async function handleLogout() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  function togglePanel(id) {
    setOpenPanels(prev => {
      if (prev.includes(id)) {
        if (id === 'sources') {
          setSelectedSource(null)
          return prev.filter(p => p !== id && p !== 'source-detail')
        }
        if (id === 'cards') {
          setSelectedCard(null)
          return prev.filter(p => p !== id && p !== 'card-detail')
        }
        if (id === 'tags') {
          setSelectedTag(null)
          return prev.filter(p => p !== id)
        }
        return prev.filter(p => p !== id)
      }
      setPanelWidths(w => ({ ...w, [id]: DEFAULT_WIDTHS[id] ?? 360 }))
      return [...prev, id]
    })
  }

  function handleSelectCard(card) {
    setSelectedCard(card)
    setOpenPanels(prev => {
      if (!prev.includes('card-detail')) {
        setPanelWidths(w => ({ ...w, 'card-detail': DEFAULT_WIDTHS['card-detail'] }))
        return [...prev, 'card-detail']
      }
      return prev
    })
  }

  function handleCloseCardDetail() {
    setSelectedCard(null)
    setOpenPanels(prev => prev.filter(p => p !== 'card-detail'))
  }

  function handleSelectTag(tagName) {
    setSelectedTag(tagName)
    if (!tagName) return
    setOpenPanels(prev => {
      if (!prev.includes('tags')) {
        setPanelWidths(w => ({ ...w, tags: DEFAULT_WIDTHS.tags }))
        return [...prev, 'tags']
      }
      return prev
    })
  }

  function handleSelectSource(source) {
    setSelectedSource(source)
    setOpenPanels(prev => {
      if (!prev.includes('source-detail')) {
        setPanelWidths(w => ({ ...w, 'source-detail': DEFAULT_WIDTHS['source-detail'] }))
        return [...prev, 'source-detail']
      }
      return prev
    })
  }

  function handleCloseSourceDetail() {
    setSelectedSource(null)
    setOpenPanels(prev => prev.filter(p => p !== 'source-detail'))
  }

  function handleAppendToChat(text) {
    setOpenPanels(prev => {
      if (prev.includes('chat')) return prev
      setPanelWidths(w => ({ ...w, chat: DEFAULT_WIDTHS.chat }))
      return ['chat', ...prev]
    })
    setChatInput(prev => prev ? prev + '\n' + text : text)
  }

  function handlePanelDragStart(index, e) {
    e.preventDefault()
    setDraggingIndex(index)
    setDragOverIndex(index)
    dragRef.current = { from: index, to: index }

    function onMouseUp() {
      document.removeEventListener('mouseup', onMouseUp)
      const { from, to } = dragRef.current
      setDraggingIndex(null)
      setDragOverIndex(null)
      if (from !== to) {
        setOpenPanels(prev => {
          const next = [...prev]
          const [item] = next.splice(from, 1)
          next.splice(to, 0, item)
          return next
        })
      }
    }

    document.addEventListener('mouseup', onMouseUp)
  }

  function handleDragOver(index) {
    setDragOverIndex(index)
    dragRef.current.to = index
  }

  useEffect(() => {
    if (draggingIndex != null) {
      document.body.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'
    } else {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [draggingIndex])

  function handleResize(leftId, rightId, dx) {
    setPanelWidths(prev => {
      const leftW = (prev[leftId] ?? DEFAULT_WIDTHS[leftId] ?? 360) + dx
      if (leftW < MIN_WIDTH) return prev
      const rightIsLast = openPanels[openPanels.length - 1] === rightId
      if (rightIsLast) {
        const containerW = panelContainerRef.current?.offsetWidth ?? 0
        const handleTotalW = (openPanels.length - 1) * 4
        const nonLastTotalW = openPanels.slice(0, -1).reduce((sum, id) => {
          return sum + (id === leftId ? leftW : (prev[id] ?? DEFAULT_WIDTHS[id] ?? 360))
        }, 0)
        if (containerW - nonLastTotalW - handleTotalW < MIN_WIDTH) return prev
        return { ...prev, [leftId]: leftW }
      }
      const rightW = (prev[rightId] ?? DEFAULT_WIDTHS[rightId] ?? 360) - dx
      if (rightW < MIN_WIDTH) return prev
      return { ...prev, [leftId]: leftW, [rightId]: rightW }
    })
  }

  if (projectsLoading) return null

  // Build interleaved [panel, handle, panel, handle, panel] list
  const panelElements = []
  openPanels.forEach((panelId, i) => {
    const width = panelWidths[panelId] ?? DEFAULT_WIDTHS[panelId] ?? 360
    const isDragging = draggingIndex === i
    const isDropTarget = draggingIndex != null && dragOverIndex === i && dragOverIndex !== draggingIndex

    if (i > 0) {
      panelElements.push(
        <ResizeHandle
          key={`resize-${i}`}
          onDrag={dx => handleResize(openPanels[i - 1], panelId, dx)}
        />
      )
    }

    const isLast = i === openPanels.length - 1
    const onDragStart = (e) => handlePanelDragStart(i, e)
    const onClose = panelId === 'source-detail' ? handleCloseSourceDetail : () => togglePanel(panelId)

    panelElements.push(
      <div
        key={panelId}
        className={`relative overflow-hidden ${isLast ? 'flex-1' : 'border-r border-gray-200 shrink-0'} ${isDragging ? 'opacity-50' : ''}`}
        style={isLast ? { minWidth: MIN_WIDTH } : { width, minWidth: MIN_WIDTH }}
        onMouseEnter={() => draggingIndex != null && draggingIndex !== i && handleDragOver(i)}
      >
        {isDropTarget && (
          <div className="absolute inset-y-0 left-0 w-0.5 bg-blue-500 z-20 pointer-events-none" />
        )}
        {renderPanel(panelId, {
          activeProject,
          contexts,
          setContexts,
          tagCatalog,
          onNewTags: refreshTagCatalog,
          selectedSource,
          onSelectSource: handleSelectSource,
          onCloseSourceDetail: handleCloseSourceDetail,
          selectedCard,
          onSelectCard: handleSelectCard,
          onCloseCardDetail: handleCloseCardDetail,
          selectedTag,
          onSelectTag: handleSelectTag,
          chatInput,
          onChatInputChange: setChatInput,
          onAppendToChat: handleAppendToChat,
          onDragStart,
          onClose,
        })}
      </div>
    )
  })

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        openPanels={openPanels}
        onToggle={togglePanel}
        onLogout={handleLogout}
        header={<ProjectSwitcher />}
      />
      <div ref={panelContainerRef} className="flex flex-1 overflow-hidden">
        {panelElements}
      </div>
    </div>
  )
}

function renderPanel(id, props) {
  const {
    activeProject, contexts, setContexts, tagCatalog, onNewTags,
    selectedSource, onSelectSource,
    selectedCard, onSelectCard, onCloseCardDetail,
    selectedTag, onSelectTag,
    chatInput, onChatInputChange, onAppendToChat, onDragStart, onClose,
  } = props

  switch (id) {
    case 'chat':
      return (
        <ChatPanel
          activeProject={activeProject}
          contexts={contexts}
          tagCatalog={tagCatalog}
          onNewTags={onNewTags}
          input={chatInput}
          onInputChange={onChatInputChange}
          onDragStart={onDragStart}
          onClose={onClose}
        />
      )
    case 'sources':
      return (
        <SourcesPanel
          activeProject={activeProject}
          onSelectSource={onSelectSource}
          selectedSourceId={selectedSource?.id}
          onAppendToChat={onAppendToChat}
          onDragStart={onDragStart}
          onClose={onClose}
        />
      )
    case 'source-detail':
      return (
        <SourceDetailPanel
          source={selectedSource}
          activeProject={activeProject}
          onClose={onClose}
          onAppendToChat={onAppendToChat}
          onDragStart={onDragStart}
        />
      )
    case 'cards':
      return (
        <CardsPanel
          activeProject={activeProject}
          onSelectCard={onSelectCard}
          selectedCardId={selectedCard?.id}
          onDragStart={onDragStart}
          onClose={onClose}
        />
      )
    case 'card-detail':
      return (
        <CardDetailPanel
          card={selectedCard}
          activeProject={activeProject}
          onClose={onCloseCardDetail}
          onAppendToChat={onAppendToChat}
          onDragStart={onDragStart}
          onSelectTag={onSelectTag}
        />
      )
    case 'tags':
      return (
        <TagsPanel
          activeProject={activeProject}
          tagCatalog={tagCatalog}
          onNewTags={onNewTags}
          onDragStart={onDragStart}
          onClose={onClose}
          selectedTag={selectedTag}
          onSelectTag={onSelectTag}
          onSelectCard={onSelectCard}
          selectedCardId={selectedCard?.id}
        />
      )
    case 'contexts':
      return (
        <ContextsPanel
          activeProject={activeProject}
          contexts={contexts}
          setContexts={setContexts}
          onDragStart={onDragStart}
          onClose={onClose}
        />
      )
    default:
      return null
  }
}
