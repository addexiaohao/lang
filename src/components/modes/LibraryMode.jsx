import { useState, useRef, useEffect } from 'react'
import { ResizeHandle } from '../ResizeHandle.jsx'
import { SourcesPanel } from '../panels/SourcesPanel.jsx'
import { SourceDetailPanel } from '../panels/SourceDetailPanel.jsx'
import { CardsPanel } from '../panels/CardsPanel.jsx'
import { CardDetailPanel } from '../panels/CardDetailPanel.jsx'
import { TableDetailPanel } from '../panels/TableDetailPanel.jsx'
import { TagsPanel } from '../panels/TagsPanel.jsx'
import { ContextsPanel } from '../panels/ContextsPanel.jsx'

// The existing multi-panel workspace (plan.md: "unchanged"), extracted verbatim out of App.jsx.
// `layout` ({ openPanels, panelWidths }) and the four selection values are controlled from
// App.jsx so they can be persisted (layout) or reached into from the card peek overlay's
// "Open in Library" hand-off (selectedCard).
export const LIBRARY_DEFAULT_WIDTHS = {
  sources: 300,
  'source-detail': 360,
  cards: 340,
  'card-detail': 360,
  'table-detail': 420,
  tags: 340,
  contexts: 340,
}
const MIN_WIDTH = 100

// Sub-tabs (plan.md Part B): quick shortcuts to open/close Library's top-level list panels,
// alongside the existing drag-reorder/resize multi-panel workspace (unchanged) — a tab here is
// just togglePanel(id) under the hood, so several can be open side by side same as before.
const LIBRARY_TABS = [
  {
    id: 'cards',
    label: 'Cards',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M2 10h20" />
      </svg>
    ),
  },
  {
    id: 'tags',
    label: 'Tags',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
        <path d="M20.59 13.41L11 3.83A2 2 0 009.83 3H4a1 1 0 00-1 1v5.83a2 2 0 00.59 1.41l9.58 9.58a2 2 0 002.83 0l4.59-4.59a2 2 0 000-2.82z" />
        <circle cx="7" cy="7" r="1.25" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: 'sources',
    label: 'Sources',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
        <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    id: 'contexts',
    label: 'Contexts',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
        <circle cx="12" cy="10" r="3" />
      </svg>
    ),
  },
]

export function LibraryMode({
  activeProject, contexts, setContexts, tagCatalog, onNewTags,
  layout, onLayoutChange,
  selectedSource, setSelectedSource,
  selectedCard, setSelectedCard,
  selectedTable, setSelectedTable,
  selectedTag, setSelectedTag,
  onAppendToChat, onStartPractice,
}) {
  const { openPanels, panelWidths } = layout
  const [draggingIndex, setDraggingIndex] = useState(null)
  const [dragOverIndex, setDragOverIndex] = useState(null)
  const dragRef = useRef({ from: null, to: null })
  const panelContainerRef = useRef(null)

  function setOpenPanels(updater) {
    onLayoutChange(prev => ({
      ...prev,
      openPanels: typeof updater === 'function' ? updater(prev.openPanels) : updater,
    }))
  }

  function setPanelWidths(updater) {
    onLayoutChange(prev => ({
      ...prev,
      panelWidths: typeof updater === 'function' ? updater(prev.panelWidths) : updater,
    }))
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
          setSelectedTable(null)
          return prev.filter(p => p !== id && p !== 'card-detail' && p !== 'table-detail')
        }
        if (id === 'tags') {
          setSelectedTag(null)
          return prev.filter(p => p !== id)
        }
        return prev.filter(p => p !== id)
      }
      setPanelWidths(w => ({ ...w, [id]: LIBRARY_DEFAULT_WIDTHS[id] ?? 360 }))
      return [...prev, id]
    })
  }

  function handleSelectCard(card) {
    setSelectedCard(card)
    setOpenPanels(prev => {
      if (!prev.includes('card-detail')) {
        setPanelWidths(w => ({ ...w, 'card-detail': LIBRARY_DEFAULT_WIDTHS['card-detail'] }))
        return [...prev, 'card-detail']
      }
      return prev
    })
  }

  function handleCloseCardDetail() {
    setSelectedCard(null)
    setOpenPanels(prev => prev.filter(p => p !== 'card-detail'))
  }

  function handleSelectTable(table) {
    setSelectedTable(table)
    setOpenPanels(prev => {
      if (!prev.includes('table-detail')) {
        setPanelWidths(w => ({ ...w, 'table-detail': LIBRARY_DEFAULT_WIDTHS['table-detail'] }))
        return [...prev, 'table-detail']
      }
      return prev
    })
  }

  function handleCloseTableDetail() {
    setSelectedTable(null)
    setOpenPanels(prev => prev.filter(p => p !== 'table-detail'))
  }

  function handleSelectTag(tagName) {
    setSelectedTag(tagName)
    if (!tagName) return
    setOpenPanels(prev => {
      if (!prev.includes('tags')) {
        setPanelWidths(w => ({ ...w, tags: LIBRARY_DEFAULT_WIDTHS.tags }))
        return [...prev, 'tags']
      }
      return prev
    })
  }

  function handleSelectSource(source) {
    setSelectedSource(source)
    setOpenPanels(prev => {
      if (!prev.includes('source-detail')) {
        setPanelWidths(w => ({ ...w, 'source-detail': LIBRARY_DEFAULT_WIDTHS['source-detail'] }))
        return [...prev, 'source-detail']
      }
      return prev
    })
  }

  function handleCloseSourceDetail() {
    setSelectedSource(null)
    setOpenPanels(prev => prev.filter(p => p !== 'source-detail'))
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
      const leftW = (prev[leftId] ?? LIBRARY_DEFAULT_WIDTHS[leftId] ?? 360) + dx
      if (leftW < MIN_WIDTH) return prev
      const rightIsLast = openPanels[openPanels.length - 1] === rightId
      if (rightIsLast) {
        const containerW = panelContainerRef.current?.offsetWidth ?? 0
        const handleTotalW = (openPanels.length - 1) * 4
        const nonLastTotalW = openPanels.slice(0, -1).reduce((sum, id) => {
          return sum + (id === leftId ? leftW : (prev[id] ?? LIBRARY_DEFAULT_WIDTHS[id] ?? 360))
        }, 0)
        if (containerW - nonLastTotalW - handleTotalW < MIN_WIDTH) return prev
        return { ...prev, [leftId]: leftW }
      }
      const rightW = (prev[rightId] ?? LIBRARY_DEFAULT_WIDTHS[rightId] ?? 360) - dx
      if (rightW < MIN_WIDTH) return prev
      return { ...prev, [leftId]: leftW, [rightId]: rightW }
    })
  }

  function renderPanel(id, onDragStart, onClose) {
    switch (id) {
      case 'sources':
        return (
          <SourcesPanel
            activeProject={activeProject}
            onSelectSource={handleSelectSource}
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
            onClose={handleCloseSourceDetail}
            onAppendToChat={onAppendToChat}
            onDragStart={onDragStart}
            onSelectTable={handleSelectTable}
          />
        )
      case 'cards':
        return (
          <CardsPanel
            activeProject={activeProject}
            onSelectCard={handleSelectCard}
            selectedCardId={selectedCard?.id}
            onSelectTable={handleSelectTable}
            selectedTableId={selectedTable?.id}
            onDragStart={onDragStart}
            onClose={onClose}
            onStartPractice={onStartPractice}
          />
        )
      case 'card-detail':
        return (
          <CardDetailPanel
            card={selectedCard}
            activeProject={activeProject}
            onClose={handleCloseCardDetail}
            onAppendToChat={onAppendToChat}
            onDragStart={onDragStart}
            onSelectTag={handleSelectTag}
          />
        )
      case 'table-detail':
        return (
          <TableDetailPanel
            table={selectedTable}
            activeProject={activeProject}
            onClose={handleCloseTableDetail}
            onAppendToChat={onAppendToChat}
            onDragStart={onDragStart}
            onSelectTag={handleSelectTag}
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
            onSelectTag={handleSelectTag}
            onSelectCard={handleSelectCard}
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

  const panelElements = []
  openPanels.forEach((panelId, i) => {
    const width = panelWidths[panelId] ?? LIBRARY_DEFAULT_WIDTHS[panelId] ?? 360
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
        {renderPanel(panelId, onDragStart, onClose)}
      </div>
    )
  })

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="w-10 shrink-0 border-r border-gray-100 bg-gray-50 flex flex-col items-center py-2 gap-1">
        {LIBRARY_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => togglePanel(tab.id)}
            title={tab.label}
            aria-label={tab.label}
            className={`p-2 rounded-lg transition-colors ${
              openPanels.includes(tab.id) ? 'bg-blue-50 text-blue-600' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
            }`}
          >
            {tab.icon}
          </button>
        ))}
      </div>
      <div ref={panelContainerRef} className="flex flex-1 min-w-0 h-full overflow-hidden">
        {panelElements}
      </div>
    </div>
  )
}
