import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import SaveCard from './SaveCard.jsx'
import LinkCard from './LinkCard.jsx'
import GermanText from './GermanText.jsx'
import { apiFetch } from '../apiFetch.js'
import { createCardGroup, addCardToGroup, fetchCardGroups } from '../cardGroupActions.js'

const TABLE_SCHEMA = {
  source: {
    required: ['original_text'],
    optional: [],
  },
  knowledge_card: {
    required: ['kind', 'name'],
    optional: ['details', 'tags', 'importance'],
    enums: { kind: ['vocabulary', 'grammar', 'expression'] },
    ranges: { importance: [0, 10] },
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
        // Word-senses save flow (plan.md — "Word Senses" §3, lib/prompts/registry.js's "Word
        // senses" section) — only ever set on a save:link_card block. Bundled as one object so
        // LinkCard/SenseSelector can treat "no sense signal at all" as a single falsy check.
        const senseProposal = (rawRecord.new_sense || rawRecord.existing_sense || rawRecord.sense_key || rawRecord.sense_flag)
          ? {
              newSense: rawRecord.new_sense ?? null,
              existingSense: rawRecord.existing_sense ?? null,
              senseKey: rawRecord.sense_key ?? null,
              senseFlag: rawRecord.sense_flag ?? null,
            }
          : null

        const metaKeys = new Set(['ref', 'source_ref', 'existing_id', 'new_tags', 'annotated_sentence', 'new_sense', 'existing_sense', 'sense_key', 'sense_flag'])

        const record = Object.fromEntries(Object.entries(rawRecord).filter(([k]) => !metaKeys.has(k)))

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
          sourceGroupIndex: lastSourceBlockIndex,
          ref,
          sourceRef,
          existingId,
          annotatedSentence,
          senseProposal,
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

  // Tags a user types into a card's own "+ new tag" dropdown (as opposed to
  // ones the LLM declared up front via save:proposed_tags), keyed by blockIndex.
  const [cardExtraTags, setCardExtraTags] = useState({})
  const handleAddNewTag = useCallback((bi, name) => {
    setProposedTagMeta(prev => prev[name] ? prev : { ...prev, [name]: { displayName: '' } })
    setCardExtraTags(prev => {
      const existing = prev[bi] ?? []
      if (existing.includes(name)) return prev
      return { ...prev, [bi]: [...existing, name] }
    })
  }, [])

  const catalogNameSet = useMemo(() => new Set(tagCatalog.map(t => t.name)), [tagCatalog])

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

  // User corrections to the agent-emitted annotated_sentence, keyed by blockIndex.
  // Falls back to the parsed block's original annotatedSentence when absent.
  const [editedAnnotatedSentences, setEditedAnnotatedSentences] = useState({})
  const updateAnnotatedSentence = useCallback((bi, value) => {
    setEditedAnnotatedSentences(prev => ({ ...prev, [bi]: value }))
  }, [])

  // "Relate to…" on a proposed save:knowledge_card block (plan.md — "Card Groups"): the target
  // card(s) picked before the new card even exists (SaveCard.jsx's RelateToStaged), keyed by
  // blockIndex. Applied for real in handleSave once the card is actually saved and its id is
  // known — see applyStagedRelates below. relateStates tracks that deferred step's own
  // relating/done/error status, separate from saveStates (which is about the card save itself).
  const [relateTargets, setRelateTargets] = useState({})
  const [relateStates, setRelateStates] = useState({})
  const updateRelateTargets = useCallback((bi, targets) => {
    setRelateTargets(prev => ({ ...prev, [bi]: targets }))
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

  // A brand-new card can't already belong to a group, so unlike CardDetailPanel's/LinkCard's
  // "Relate this card…" there's no 0/1/many ambiguity to resolve here — the first staged target
  // always creates a fresh group with the new card, and any further staged targets just join that
  // same group.
  async function applyStagedRelates(newCardId, targets) {
    if (!targets || targets.length === 0) return
    await createCardGroup(projectId, [newCardId, targets[0].id])
    if (targets.length > 1) {
      const groups = await fetchCardGroups(projectId, newCardId)
      const groupId = groups[0]?.id
      if (groupId) {
        for (const t of targets.slice(1)) await addCardToGroup(projectId, groupId, t.id)
      }
    }
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
      if (table === 'knowledge_card' && relateTargets[bi]?.length) {
        setRelateStates(prev => ({ ...prev, [bi]: { status: 'relating' } }))
        try {
          await applyStagedRelates(data.id, relateTargets[bi])
          setRelateStates(prev => ({ ...prev, [bi]: { status: 'done' } }))
        } catch (e) {
          setRelateStates(prev => ({ ...prev, [bi]: { status: 'error', error: String(e.message || e) } }))
        }
      }
    } catch (err) {
      setSaveStates(prev => prev.map((s, i) => i === bi ? { status: 'error', error: err.message } : s))
    }
  }

  async function handleLink(bi, existingCardId = null, senseFields = null) {
    const block = blocks.find(b => b.blockIndex === bi)
    const cardId = existingCardId ?? block.existingId
    const sourceId = block.sourceRef != null
      ? sourceRefMap[block.sourceRef]?.id
      : savedSourceIdsRef.current[block.sourceGroupIndex]
    if (!sourceId || !cardId) return
    setLinkStates(prev => prev.map((s, i) => i === bi ? { status: 'linking' } : s))
    try {
      const linkRecord = { source_id: sourceId, knowledge_card_id: cardId, ...(senseFields ?? {}) }
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

  // Save in document order: sources before their cards/links
  async function handleSaveAll() {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      const isLinkBlock = block.table === 'link_card'
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
            // Declared by the LLM up front, but intentionally not rendered here —
            // each new tag instead surfaces just above the card(s) that use it, below.
            return null
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
                  onLink={senseFields => handleLink(bi, null, senseFields)}
                  existingId={segment.existingId}
                  senseProposal={segment.senseProposal}
                  sourceId={sourceId}
                  annotatedSentence={editedAnnotatedSentences[bi] ?? segment.annotatedSentence}
                  onAnnotatedSentenceChange={value => updateAnnotatedSentence(bi, value)}
                />
              )
            }

            const isKnowledgeCard = segment.table === 'knowledge_card'
            const cardTags = isKnowledgeCard && Array.isArray(segment.record.tags) ? segment.record.tags : []
            const extraTags = cardExtraTags[bi] ?? []
            const pendingTagsForCard = isKnowledgeCard
              ? [...new Set([...cardTags, ...extraTags])].filter(name => !catalogNameSet.has(name))
              : []

            return (
              <div key={i} className="space-y-2">
                {pendingTagsForCard.map(name => {
                  const meta = proposedTagMeta[name] ?? {}
                  const isConfirming = meta.confirming ?? false
                  return (
                    <div key={name} className="border border-amber-200 rounded-xl bg-amber-50 p-3 space-y-2 text-sm">
                      <span className="text-xs font-semibold text-amber-700 uppercase tracking-wide">New tag</span>
                      <div className="bg-white border border-amber-200 rounded-lg p-3 space-y-2">
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
                    </div>
                  )
                })}
                <SaveCard
                  ref={el => { cardRefs.current[bi] = el }}
                  table={segment.table}
                  record={segment.record}
                  onSave={(table, fields) => handleSave(bi, table, fields)}
                  saveState={saveStates[bi] ?? { status: 'idle' }}
                  blocked={isKnowledgeCard && !(
                    segment.sourceRef != null
                      ? sourceRefMap[segment.sourceRef]?.id
                      : savedSourceIds[segment.sourceGroupIndex]
                  )}
                  validationWarnings={segment.validationWarnings ?? []}
                  unknownFields={segment.unknownFields ?? []}
                  contexts={segment.table === 'source' ? contexts : undefined}
                  forcedContext={segment.table === 'source' ? forcedContext : undefined}
                  sourceText={isKnowledgeCard
                    ? (segment.sourceRef != null
                        ? sourceRefMap[segment.sourceRef]?.text
                        : blocks[segment.sourceGroupIndex]?.record?.original_text)
                    : undefined}
                  tagCatalog={tagCatalog}
                  proposedTagMeta={proposedTagMeta}
                  onNewTags={onNewTags}
                  onAddNewTag={isKnowledgeCard ? (name) => handleAddNewTag(bi, name) : undefined}
                  linkState={isKnowledgeCard ? (linkStates[bi] ?? { status: 'idle' }) : undefined}
                  onLink={isKnowledgeCard ? (cardId) => handleLink(bi, cardId) : undefined}
                  annotatedSentence={editedAnnotatedSentences[bi] ?? segment.annotatedSentence}
                  onAnnotatedSentenceChange={value => updateAnnotatedSentence(bi, value)}
                  relateTargets={isKnowledgeCard ? relateTargets[bi] : undefined}
                  onRelateTargetsChange={isKnowledgeCard ? (targets) => updateRelateTargets(bi, targets) : undefined}
                  relateState={isKnowledgeCard ? relateStates[bi] : undefined}
                />
              </div>
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
