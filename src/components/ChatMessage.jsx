import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import SaveCard from './SaveCard.jsx'
import LinkCard from './LinkCard.jsx'
import TableSaveCard from './TableSaveCard.jsx'
import TableCellSaveCard from './TableCellSaveCard.jsx'
import LinkTableCellCard from './LinkTableCellCard.jsx'
import GermanText from './GermanText.jsx'
import { apiFetch } from '../apiFetch.js'

const TABLE_SCHEMA = {
  source: {
    required: ['original_text'],
    optional: [],
  },
  knowledge_card: {
    required: ['kind', 'name'],
    optional: ['details', 'tags', 'skill', 'importance'],
    enums: { kind: ['vocabulary', 'grammar', 'expression'] },
    ranges: { skill: [1, 10], importance: [1, 10] },
  },
  table: {
    required: ['name', 'axes', 'axis_values'],
    optional: ['tags', 'notes'],
  },
  table_cell: {
    required: ['axis_values'],
    optional: ['skill'],
    ranges: { skill: [0, 10] },
  },
  link_table_cell: {
    required: [],
    optional: ['excerpt', 'note'],
  },
  source_knowledge: {
    required: ['source_id', 'knowledge_card_id'],
    optional: ['excerpt', 'note'],
  },
}

function validateBlock(table, record) {
  const schema = TABLE_SCHEMA[table]
  if (!schema) return { warnings: [], unknownFields: [] }

  const warnings = []
  const unknownFields = []
  const allowed = new Set([...(schema.required ?? []), ...(schema.optional ?? [])])

  for (const field of schema.required ?? []) {
    const v = record[field]
    if (v === undefined || v === null || v === '') {
      warnings.push(`Missing required field: ${field}`)
    }
  }

  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) unknownFields.push(field)
  }
  if (unknownFields.length > 0) {
    warnings.push(`Unknown field${unknownFields.length > 1 ? 's' : ''}: ${unknownFields.join(', ')}`)
  }

  for (const [field, values] of Object.entries(schema.enums ?? {})) {
    if (record[field] !== undefined && !values.includes(record[field])) {
      warnings.push(`"${field}" must be one of: ${values.join(', ')} (got "${record[field]}")`)
    }
  }

  for (const [field, [min, max]] of Object.entries(schema.ranges ?? {})) {
    if (record[field] !== undefined && record[field] !== null) {
      const v = Number(record[field])
      if (isNaN(v) || v < min || v > max) {
        warnings.push(`"${field}" must be between ${min} and ${max}`)
      }
    }
  }

  return { warnings, unknownFields }
}

// Returns an ordered list of { type: 'text', content } and { type: 'block', table, record, ... , blockIndex }
// preserving the order blocks appear in the response.
// Meta fields (ref, source_ref, table_ref, existing_id, etc.) are extracted and stored as segment
// properties; they are stripped from the record so they don't render as editable fields or go to the DB.
function parseSaveBlocks(content) {
  const segments = []
  const regex = /```save:(\w+)\n([\s\S]*?)```/g
  let lastIndex = 0
  let blockIndex = 0
  let match

  let lastSourceBlockIndex = null
  let lastTableBlockIndex = null

  while ((match = regex.exec(content)) !== null) {
    const textBefore = content.slice(lastIndex, match.index).trim()
    if (textBefore) segments.push({ type: 'text', content: textBefore })

    try {
      const rawRecord = JSON.parse(match[2])
      const table = match[1]

      if (table === 'proposed_tags') {
        const tags = Array.isArray(rawRecord) ? rawRecord.filter(t => typeof t === 'string') : []
        segments.push({ type: 'proposed_tags', tags })
      } else {
        // Extract all meta fields up front
        const ref = rawRecord.ref ?? null
        const sourceRef = rawRecord.source_ref ?? null
        const existingId = rawRecord.existing_id ?? null
        const annotatedSentence = rawRecord.annotated_sentence ?? null
        const tableRef = rawRecord.table_ref ?? null
        const existingCellId = rawRecord.existing_cell_id ?? null
        // axis_values for link_table_cell is meta (used for lookup); for other blocks it stays in record
        const axisValuesForLink = table === 'link_table_cell' ? (rawRecord.axis_values ?? null) : null

        const metaKeys = new Set(['ref', 'source_ref', 'existing_id', 'new_tags', 'annotated_sentence', 'table_ref', 'existing_cell_id'])
        if (table === 'link_table_cell') metaKeys.add('axis_values')

        const record = Object.fromEntries(Object.entries(rawRecord).filter(([k]) => !metaKeys.has(k)))

        const { warnings, unknownFields } = validateBlock(table, record)
        const bi = blockIndex++
        if (table === 'source') lastSourceBlockIndex = bi
        if (table === 'table') lastTableBlockIndex = bi

        segments.push({
          type: 'block',
          table,
          record,
          validationWarnings: warnings,
          unknownFields,
          blockIndex: bi,
          sourceGroupIndex: lastSourceBlockIndex,
          tableGroupIndex: lastTableBlockIndex,
          ref,
          sourceRef,
          existingId,
          annotatedSentence,
          tableRef,
          existingCellId,
          axisValuesForLink,  // only set for link_table_cell
        })
      }
    } catch {
      // skip malformed blocks
    }

    lastIndex = match.index + match[0].length
  }

  const textAfter = content.slice(lastIndex).trim()
  if (textAfter) segments.push({ type: 'text', content: textAfter })

  return segments
}

function deriveCellKey(axisValues) {
  return Object.keys(axisValues)
    .sort()
    .map(k => String(axisValues[k]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .join('-')
}

function parseFieldsToRecord(fields, originalRecord) {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => {
      if (typeof originalRecord[k] === 'object' && originalRecord[k] !== null) {
        try { return [k, JSON.parse(v)] } catch { return [k, v] }
      }
      return [k, v]
    })
  )
}

export default function ChatMessage({ role, content, sourceRefMap = {}, onSourceRegistered, onSourceSaved, contexts = [], forcedContext = null, tagCatalog = [], onNewTags, projectId }) {
  const isUser = role === 'user'
  const segments = useMemo(() => isUser ? [] : parseSaveBlocks(content), [content, isUser])
  const blocks = segments.filter(s => s.type === 'block')
  const [saveStates, setSaveStates] = useState([])
  const [linkStates, setLinkStates] = useState([])

  // Proposed tags declared by the agent at the top of the response
  const proposedTagList = useMemo(() => {
    const names = []
    const seen = new Set()
    for (const seg of segments) {
      if (seg.type === 'proposed_tags') {
        for (const name of seg.tags) {
          if (!seen.has(name)) { seen.add(name); names.push(name) }
        }
      }
    }
    return names
  }, [segments])

  const [proposedTagMeta, setProposedTagMeta] = useState({})

  useEffect(() => {
    setProposedTagMeta(prev => {
      const next = { ...prev }
      let changed = false
      for (const name of proposedTagList) {
        if (!next[name]) { next[name] = { displayName: '' }; changed = true }
      }
      return changed ? next : prev
    })
  }, [proposedTagList])

  const updateProposedTagDisplayName = useCallback((name, displayName) => {
    setProposedTagMeta(prev => ({ ...prev, [name]: { ...prev[name], displayName } }))
  }, [])

  const handleConfirmTag = useCallback(async (name) => {
    const meta = proposedTagMeta[name] ?? {}
    setProposedTagMeta(prev => ({ ...prev, [name]: { ...prev[name], confirming: true } }))
    try {
      await apiFetch('/api/tags', {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          name,
          display_name: meta.displayName || undefined,
        }),
      })
      onNewTags?.()
    } catch {
      setProposedTagMeta(prev => ({ ...prev, [name]: { ...prev[name], confirming: false } }))
    }
  }, [proposedTagMeta, projectId, onNewTags])

  const cardRefs = useRef([])
  // savedSourceIds (state) triggers re-renders so cards unblock visually.
  // savedSourceIdsRef (ref) is read inside handleSave/handleLink to avoid stale closures.
  const [savedSourceIds, setSavedSourceIds] = useState({})
  const savedSourceIdsRef = useRef({})
  const registeredRefsRef = useRef(new Set())
  const registeredSavedRefsRef = useRef(new Set())

  // Table ref tracking: maps table ref → { id, name }
  // Cell ref tracking: maps "{tableRef}:{cellKey}" → table_cell_id
  const [savedTableRefs, setSavedTableRefs] = useState({})
  const savedTableRefsRef = useRef({})
  const [savedCellRefs, setSavedCellRefs] = useState({})
  const savedCellRefsRef = useRef({})

  // User corrections to the agent-emitted annotated_sentence, keyed by blockIndex.
  // Falls back to the parsed block's original annotatedSentence when absent.
  const [editedAnnotatedSentences, setEditedAnnotatedSentences] = useState({})
  const updateAnnotatedSentence = useCallback((bi, value) => {
    setEditedAnnotatedSentences(prev => ({ ...prev, [bi]: value }))
  }, [])

  useEffect(() => {
    if (isUser) return

    setSaveStates(prev => {
      const extended = prev.length < blocks.length
        ? [...prev, ...Array(blocks.length - prev.length).fill({ status: 'idle' })]
        : prev
      // Mark existing sources as already saved so downstream cards are unblocked
      return extended.map((s, i) => {
        const block = blocks[i]
        if (s.status === 'idle' && block?.table === 'source' && block.existingId != null) {
          return { status: 'saved', id: block.existingId }
        }
        return s
      })
    })

    setLinkStates(prev => {
      if (prev.length >= blocks.length) return prev
      return [...prev, ...Array(blocks.length - prev.length).fill({ status: 'idle' })]
    })

    // Pre-register source IDs for sources already in the DB so knowledge cards can use them
    for (const block of blocks) {
      if (block.table === 'source' && block.existingId != null && !registeredSavedRefsRef.current.has(block.blockIndex)) {
        registeredSavedRefsRef.current.add(block.blockIndex)
        savedSourceIdsRef.current[block.blockIndex] = block.existingId
        setSavedSourceIds(prev => ({ ...prev, [block.blockIndex]: block.existingId }))
        if (block.ref != null) onSourceSaved?.(block.ref, block.existingId)
      }
      // Pre-register existing tables so cells are immediately unblocked
      if (block.table === 'table' && block.existingId != null && block.ref != null
          && !savedTableRefsRef.current[block.ref]) {
        const name = block.record.name ?? ''
        savedTableRefsRef.current[block.ref] = { id: block.existingId, name }
        setSavedTableRefs(prev => ({ ...prev, [block.ref]: { id: block.existingId, name } }))
      }
    }
  }, [blocks.length, isUser, onSourceSaved])

  // Register source texts in the conversation-level map as they appear
  useEffect(() => {
    if (isUser) return
    for (const block of blocks) {
      if (block.table === 'source' && block.ref != null && !registeredRefsRef.current.has(block.ref)) {
        registeredRefsRef.current.add(block.ref)
        onSourceRegistered?.(block.ref, block.record.original_text)
      }
    }
  }, [blocks.length, isUser, onSourceRegistered])

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap leading-relaxed bg-blue-500 text-white rounded-br-sm">
          {content}
        </div>
      </div>
    )
  }

  async function handleSave(bi, table, fields) {
    setSaveStates(prev => prev.map((s, i) => i === bi ? { status: 'saving' } : s))
    try {
      const block = blocks.find(b => b.blockIndex === bi)
      let record = parseFieldsToRecord(fields, block.record)
      if (table === 'knowledge_card') {
        const sourceId = block.sourceRef != null
          ? sourceRefMap[block.sourceRef]?.id
          : savedSourceIdsRef.current[block.sourceGroupIndex]
        record = { ...record, source_id: sourceId }
      }
      const annotatedSentence = editedAnnotatedSentences[bi] ?? block.annotatedSentence
      if (annotatedSentence) record = { ...record, annotated_sentence: annotatedSentence }
      const res = await apiFetch('/api/save', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, table, record }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      if (table === 'source') {
        const ref = blocks[bi].ref
        savedSourceIdsRef.current[bi] = data.id
        setSavedSourceIds(prev => ({ ...prev, [bi]: data.id }))
        onSourceSaved?.(ref, data.id)
      }
      setSaveStates(prev => prev.map((s, i) => i === bi ? { status: 'saved', id: data.id } : s))
    } catch (err) {
      setSaveStates(prev => prev.map((s, i) => i === bi ? { status: 'error', error: err.message } : s))
    }
  }

  function handleTableSaved(bi, tableRefKey, tableId, tableName) {
    savedTableRefsRef.current[tableRefKey] = { id: tableId, name: tableName }
    setSavedTableRefs(prev => ({ ...prev, [tableRefKey]: { id: tableId, name: tableName } }))
    setSaveStates(prev => prev.map((s, i) => i === bi ? { status: 'saved', id: tableId } : s))
  }

  function handleCellSaved(bi, tableRefKey, cellKey, cellId) {
    const mapKey = `${tableRefKey}:${cellKey}`
    savedCellRefsRef.current[mapKey] = cellId
    setSavedCellRefs(prev => ({ ...prev, [mapKey]: cellId }))
    setSaveStates(prev => prev.map((s, i) => i === bi ? { status: 'saved', id: cellId } : s))
  }

  async function handleLink(bi, existingCardId = null) {
    const block = blocks.find(b => b.blockIndex === bi)
    const cardId = existingCardId ?? block.existingId
    const sourceId = block.sourceRef != null
      ? sourceRefMap[block.sourceRef]?.id
      : savedSourceIdsRef.current[block.sourceGroupIndex]
    if (!sourceId || !cardId) return
    setLinkStates(prev => prev.map((s, i) => i === bi ? { status: 'linking' } : s))
    try {
      const linkRecord = { source_id: sourceId, knowledge_card_id: cardId }
      const annotatedSentence = editedAnnotatedSentences[bi] ?? block.annotatedSentence
      if (annotatedSentence) linkRecord.annotated_sentence = annotatedSentence
      const res = await apiFetch('/api/save', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, table: 'source_knowledge', record: linkRecord }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setLinkStates(prev => prev.map((s, i) => i === bi ? { status: 'linked' } : s))
    } catch (err) {
      setLinkStates(prev => prev.map((s, i) => i === bi ? { status: 'error', error: err.message } : s))
    }
  }

  async function handleLinkTableCell(bi) {
    const block = blocks.find(b => b.blockIndex === bi)
    const sourceId = block.sourceRef != null
      ? sourceRefMap[block.sourceRef]?.id
      : savedSourceIdsRef.current[block.sourceGroupIndex]

    // Resolve table cell id: prefer existing_cell_id, then look up from savedCellRefs
    let tableCellId = block.existingCellId ?? null
    if (!tableCellId && block.tableRef != null && block.axisValuesForLink) {
      const cellKey = deriveCellKey(block.axisValuesForLink)
      tableCellId = savedCellRefsRef.current[`${block.tableRef}:${cellKey}`] ?? null
    }

    if (!sourceId || !tableCellId) return
    setLinkStates(prev => prev.map((s, i) => i === bi ? { status: 'linking' } : s))
    try {
      const linkRecord = { source_id: sourceId, table_cell_id: tableCellId, excerpt: block.record.excerpt || undefined, note: block.record.note || undefined }
      const res = await apiFetch('/api/save', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, table: 'link_table_cell', record: linkRecord }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setLinkStates(prev => prev.map((s, i) => i === bi ? { status: 'linked' } : s))
    } catch (err) {
      setLinkStates(prev => prev.map((s, i) => i === bi ? { status: 'error', error: err.message } : s))
    }
  }

  // Save in document order: tables before their cells, sources before their cards/links
  async function handleSaveAll() {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      const isLinkBlock = block.table === 'link_card' || block.table === 'link_table_cell'
      if (isLinkBlock) {
        if (linkStates[i]?.status !== 'linked') await cardRefs.current[i]?.save()
      } else if (saveStates[i]?.status !== 'saved') {
        await cardRefs.current[i]?.save()
      }
    }
  }

  const renderableBlocks = blocks.filter(b => b.table !== 'source_knowledge')

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[75%] space-y-2">
        {segments.length === 0 && (
          <div className="rounded-2xl px-4 py-2 text-sm leading-relaxed bg-white text-gray-800 border border-gray-200 rounded-bl-sm shadow-sm prose prose-sm max-w-none">
            <span className="opacity-40 animate-pulse">▍</span>
          </div>
        )}
        {segments.map((segment, i) => {
          if (segment.type === 'text') {
            return (
              <div key={i} className="rounded-2xl px-4 py-2 text-sm leading-relaxed bg-white text-gray-800 border border-gray-200 rounded-bl-sm shadow-sm prose prose-sm max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={{ de: GermanText }}>{segment.content}</ReactMarkdown>
              </div>
            )
          }
          if (segment.type === 'proposed_tags') {
            const catalogNameSet = new Set(tagCatalog.map(t => t.name))
            const pendingTags = segment.tags.filter(name => !catalogNameSet.has(name))
            if (pendingTags.length === 0) return null
            return (
              <div key={i} className="border border-amber-200 rounded-xl bg-amber-50 p-3 space-y-3 text-sm">
                <span className="text-xs font-semibold text-amber-700 uppercase tracking-wide">Proposed Tags</span>
                {pendingTags.map(name => {
                  const meta = proposedTagMeta[name] ?? {}
                  const isConfirming = meta.confirming ?? false
                  return (
                    <div key={name} className="bg-white border border-amber-200 rounded-lg p-3 space-y-2">
                      <div className="text-xs font-mono text-amber-800 bg-amber-100 border border-amber-300 px-2 py-1 rounded break-all">{name}</div>
                      <input
                        className="w-full text-xs border border-amber-200 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:opacity-50"
                        placeholder="display name…"
                        value={meta.displayName ?? ''}
                        onChange={e => updateProposedTagDisplayName(name, e.target.value)}
                        disabled={isConfirming}
                      />
                      <button
                        onClick={() => handleConfirmTag(name)}
                        disabled={isConfirming}
                        className={`w-full py-1.5 text-xs font-medium rounded-md transition-colors ${
                          isConfirming
                            ? 'bg-amber-300 text-amber-900 cursor-not-allowed'
                            : 'bg-amber-500 text-white hover:bg-amber-600'
                        }`}
                      >
                        {isConfirming ? 'Saving…' : 'Confirm'}
                      </button>
                    </div>
                  )
                })}
              </div>
            )
          }
          if (segment.type === 'block') {
            if (segment.table === 'source_knowledge') return null
            const bi = segment.blockIndex

            if (segment.table === 'link_card') {
              const sourceId = segment.sourceRef != null
                ? sourceRefMap[segment.sourceRef]?.id
                : savedSourceIds[segment.sourceGroupIndex]
              return (
                <LinkCard
                  key={i}
                  ref={el => { cardRefs.current[bi] = el }}
                  record={segment.record}
                  linkState={linkStates[bi] ?? { status: 'idle' }}
                  onLink={() => handleLink(bi)}
                  sourceId={sourceId}
                  annotatedSentence={editedAnnotatedSentences[bi] ?? segment.annotatedSentence}
                  onAnnotatedSentenceChange={value => updateAnnotatedSentence(bi, value)}
                />
              )
            }

            if (segment.table === 'table') {
              return (
                <TableSaveCard
                  key={i}
                  ref={el => { cardRefs.current[bi] = el }}
                  record={segment.record}
                  saveState={saveStates[bi] ?? { status: 'idle' }}
                  existingId={segment.existingId}
                  projectId={projectId}
                  onSaved={(id, name) => handleTableSaved(bi, segment.ref, id, name)}
                />
              )
            }

            if (segment.table === 'table_cell') {
              const tableRefKey = segment.tableRef
              const tableData = savedTableRefs[tableRefKey]
              const tableBlocked = !tableData?.id
              return (
                <TableCellSaveCard
                  key={i}
                  ref={el => { cardRefs.current[bi] = el }}
                  record={segment.record}
                  saveState={saveStates[bi] ?? { status: 'idle' }}
                  blocked={tableBlocked}
                  tableName={tableData?.name}
                  tableId={tableData?.id}
                  projectId={projectId}
                  onSaved={(cellId, cellKey) => handleCellSaved(bi, tableRefKey, cellKey, cellId)}
                />
              )
            }

            if (segment.table === 'link_table_cell') {
              const sourceId = segment.sourceRef != null
                ? sourceRefMap[segment.sourceRef]?.id
                : savedSourceIds[segment.sourceGroupIndex]
              const tableRefKey = segment.tableRef
              const tableData = savedTableRefs[tableRefKey]
              let tableCellId = segment.existingCellId ?? null
              if (!tableCellId && tableRefKey && segment.axisValuesForLink) {
                const cellKey = deriveCellKey(segment.axisValuesForLink)
                tableCellId = savedCellRefs[`${tableRefKey}:${cellKey}`] ?? null
              }
              return (
                <LinkTableCellCard
                  key={i}
                  ref={el => { cardRefs.current[bi] = el }}
                  record={segment.record}
                  linkState={linkStates[bi] ?? { status: 'idle' }}
                  sourceId={sourceId}
                  tableCellId={tableCellId}
                  tableName={tableData?.name}
                  axisValues={segment.axisValuesForLink}
                  onLink={() => handleLinkTableCell(bi)}
                />
              )
            }

            return (
              <SaveCard
                key={i}
                ref={el => { cardRefs.current[bi] = el }}
                table={segment.table}
                record={segment.record}
                onSave={(table, fields) => handleSave(bi, table, fields)}
                saveState={saveStates[bi] ?? { status: 'idle' }}
                blocked={segment.table === 'knowledge_card' && !(
                  segment.sourceRef != null
                    ? sourceRefMap[segment.sourceRef]?.id
                    : savedSourceIds[segment.sourceGroupIndex]
                )}
                validationWarnings={segment.validationWarnings ?? []}
                unknownFields={segment.unknownFields ?? []}
                contexts={segment.table === 'source' ? contexts : undefined}
                forcedContext={segment.table === 'source' ? forcedContext : undefined}
                sourceText={segment.table === 'knowledge_card'
                  ? (segment.sourceRef != null
                      ? sourceRefMap[segment.sourceRef]?.text
                      : blocks[segment.sourceGroupIndex]?.record?.original_text)
                  : undefined}
                tagCatalog={tagCatalog}
                proposedTagMeta={proposedTagMeta}
                onNewTags={onNewTags}
                linkState={segment.table === 'knowledge_card' ? (linkStates[bi] ?? { status: 'idle' }) : undefined}
                onLink={segment.table === 'knowledge_card' ? (cardId) => handleLink(bi, cardId) : undefined}
                annotatedSentence={editedAnnotatedSentences[bi] ?? segment.annotatedSentence}
                onAnnotatedSentenceChange={value => updateAnnotatedSentence(bi, value)}
              />
            )
          }
          return null
        })}
        {renderableBlocks.length > 1 && (
          <button
            onClick={handleSaveAll}
            className="w-full py-1.5 text-xs font-medium bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors"
          >
            Save all ({renderableBlocks.length})
          </button>
        )}
      </div>
    </div>
  )
}
