import { useState, useRef, useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import SaveCard from './SaveCard.jsx'
import LinkCard from './LinkCard.jsx'
import GermanText from './GermanText.jsx'
import { apiFetch } from '../apiFetch.js'

const TABLE_SCHEMA = {
  source: {
    required: ['original_text'],
    optional: [],
  },
  knowledge_card: {
    required: ['kind', 'name'],
    optional: ['details', 'tags', 'new_tags', 'skill', 'importance', 'axes', 'cells'],
    enums: { kind: ['vocabulary', 'grammar', 'expression', 'table'] },
    ranges: { skill: [1, 10], importance: [1, 10] },
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
// ref/source_ref are extracted from records and stored as segment properties; they are stripped from
// the record passed to SaveCard so they don't render as fields or get sent to the DB.
function parseSaveBlocks(content) {
  const segments = []
  const regex = /```save:(\w+)\n([\s\S]*?)```/g
  let lastIndex = 0
  let blockIndex = 0
  let match

  let lastSourceBlockIndex = null

  while ((match = regex.exec(content)) !== null) {
    const textBefore = content.slice(lastIndex, match.index).trim()
    if (textBefore) segments.push({ type: 'text', content: textBefore })

    try {
      const rawRecord = JSON.parse(match[2])
      const table = match[1]

      // Extract linking fields — not stored to DB, not shown in the card UI
      const ref = rawRecord.ref ?? null
      const sourceRef = rawRecord.source_ref ?? null
      const existingId = rawRecord.existing_id ?? null
      const { ref: _r, source_ref: _s, existing_id: _e, ...record } = rawRecord

      const { warnings, unknownFields } = validateBlock(table, record)
      const bi = blockIndex++
      if (table === 'source') lastSourceBlockIndex = bi
      segments.push({
        type: 'block',
        table,
        record,
        validationWarnings: warnings,
        unknownFields,
        blockIndex: bi,
        sourceGroupIndex: lastSourceBlockIndex, // fallback for same-message cards without source_ref
        ref,        // source's own conversation-wide id (source blocks only)
        sourceRef,  // which source this card belongs to (knowledge_card/link_card blocks only)
        existingId, // set when this item is already in the DB (existing source or existing card)
      })
    } catch {
      // skip malformed blocks
    }

    lastIndex = match.index + match[0].length
  }

  const textAfter = content.slice(lastIndex).trim()
  if (textAfter) segments.push({ type: 'text', content: textAfter })

  return segments
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

export default function ChatMessage({ role, content, sourceRefMap = {}, onSourceRegistered, onSourceSaved, contexts = [], tagCatalog = [], onNewTags, projectId }) {
  const isUser = role === 'user'
  const segments = useMemo(() => isUser ? [] : parseSaveBlocks(content), [content, isUser])
  const blocks = segments.filter(s => s.type === 'block')
  const [saveStates, setSaveStates] = useState([])
  const [linkStates, setLinkStates] = useState([])
  const cardRefs = useRef([])
  // savedSourceIds (state) triggers re-renders so cards unblock visually.
  // savedSourceIdsRef (ref) is read inside handleSave/handleLink to avoid stale closures.
  const [savedSourceIds, setSavedSourceIds] = useState({})
  const savedSourceIdsRef = useRef({})
  const registeredRefsRef = useRef(new Set())
  const registeredSavedRefsRef = useRef(new Set())

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

  async function handleLink(bi, existingCardId = null) {
    const block = blocks.find(b => b.blockIndex === bi)
    const cardId = existingCardId ?? block.existingId
    const sourceId = block.sourceRef != null
      ? sourceRefMap[block.sourceRef]?.id
      : savedSourceIdsRef.current[block.sourceGroupIndex]
    if (!sourceId || !cardId) return
    setLinkStates(prev => prev.map((s, i) => i === bi ? { status: 'linking' } : s))
    try {
      const res = await apiFetch('/api/save', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, table: 'source_knowledge', record: { source_id: sourceId, knowledge_card_id: cardId } }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setLinkStates(prev => prev.map((s, i) => i === bi ? { status: 'linked' } : s))
    } catch (err) {
      setLinkStates(prev => prev.map((s, i) => i === bi ? { status: 'error', error: err.message } : s))
    }
  }

  // Save in document order: each source is saved before its own knowledge cards and link cards
  async function handleSaveAll() {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      if (block.table === 'link_card') {
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
                sourceText={segment.table === 'knowledge_card'
                  ? (segment.sourceRef != null
                      ? sourceRefMap[segment.sourceRef]?.text
                      : blocks[segment.sourceGroupIndex]?.record?.original_text)
                  : undefined}
                tagCatalog={tagCatalog}
                onNewTags={onNewTags}
                linkState={segment.table === 'knowledge_card' ? (linkStates[bi] ?? { status: 'idle' }) : undefined}
                onLink={segment.table === 'knowledge_card' ? (cardId) => handleLink(bi, cardId) : undefined}
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
