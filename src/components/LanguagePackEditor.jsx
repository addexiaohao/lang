import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../apiFetch.js'
import { MultiSelectPopover } from './MultiSelectPopover.jsx'
import { useRefreshLanguagePack } from '../LanguagePackContext.jsx'

// In-app editor for a project's language pack (skill_type_def / drill_rule / config.language_meta),
// shown next to the system prompt in SettingsModal. Talks to /api/language-pack. Every change is a
// per-row save (no bulk diff), so partial edits can't corrupt the pack.

const KINDS = ['vocabulary', 'grammar', 'expression']

// ── applies_when <-> form ─────────────────────────────────────────────────────
// The pack stores tag NAMES (not tags.id) — knowledge_cards.tags is a denormalized text[] of
// names, and a rule should survive a tag being renamed/recreated. The editor picks from the
// project's tag catalog but also allows a free-typed name (for a tag you plan to start using).
function appliesToForm(aw) {
  if (aw?.all_tags?.length) return { mode: 'all', tags: aw.all_tags }
  if (aw?.any_tag?.length) return { mode: 'any', tags: aw.any_tag }
  return { mode: 'always', tags: [] }
}
function buildApplies(mode, tagList) {
  const list = [...new Set(tagList.map(s => s.trim()).filter(Boolean))]
  if (mode === 'always' || list.length === 0) return null
  return mode === 'all' ? { all_tags: list } : { any_tag: list }
}
function appliesSummary(aw) {
  if (aw?.all_tags?.length) return `all of: ${aw.all_tags.join(', ')}`
  if (aw?.any_tag?.length) return `any of: ${aw.any_tag.join(', ')}`
  return 'always'
}

// ── small controls ───────────────────────────────────────────────────────────
const inputCls = 'border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400'
const labelCls = 'text-[11px] font-medium text-gray-500 uppercase tracking-wide'

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      {children}
    </label>
  )
}

function AppliesWhenControl({ value, syncKey, tagCatalog = [], onChange }) {
  const initial = appliesToForm(value)
  const [mode, setMode] = useState(initial.mode)
  const [tags, setTags] = useState(initial.tags)     // array of tag names
  const [custom, setCustom] = useState('')
  // Re-sync only when the row identity changes (after a save/reload), NOT on every keystroke.
  useEffect(() => { const f = appliesToForm(value); setMode(f.mode); setTags(f.tags); setCustom('') }, [syncKey])

  function emit(nextMode, nextTags) {
    setMode(nextMode); setTags(nextTags)
    onChange(buildApplies(nextMode, nextTags))
  }
  function toggleTag(name) {
    emit(mode, tags.includes(name) ? tags.filter(t => t !== name) : [...tags, name])
  }
  function addCustom() {
    const t = custom.trim()
    if (t && !tags.includes(t)) emit(mode, [...tags, t])
    setCustom('')
  }

  const selected = new Set(tags)
  const options = [...new Set([...(tagCatalog ?? []).map(t => t.name), ...tags])].sort()
    .map(name => ({ value: name, label: name }))

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2 items-end">
        <Field label="Applies to cards">
          <select className={inputCls} value={mode} onChange={e => emit(e.target.value, tags)}>
            <option value="always">Always (every card of this kind)</option>
            <option value="any">With any of these tags</option>
            <option value="all">With all of these tags</option>
          </select>
        </Field>
        {mode !== 'always' && (
          <div className="flex items-center gap-2 pb-1">
            <MultiSelectPopover label="Pick tags" options={options} selected={selected} onToggle={toggleTag} />
            <input className={inputCls + ' w-40 text-xs'} value={custom} placeholder="+ tag not in catalog"
              onChange={e => setCustom(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustom() } }}
              onBlur={addCustom} />
          </div>
        )}
      </div>
      {mode !== 'always' && tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map(t => (
            <span key={t} className="inline-flex items-center gap-1 text-[11px] bg-gray-100 text-gray-700 rounded px-1.5 py-0.5">
              {t}
              <button className="text-gray-400 hover:text-red-500" onClick={() => toggleTag(t)}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── skill type row ───────────────────────────────────────────────────────────
function SkillTypeRow({ row, siblings, usedKeys, tagCatalog, onSave, onDelete }) {
  const isNew = !row.id
  const [open, setOpen] = useState(isNew)
  const [draft, setDraft] = useState(row)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const locked = !isNew && usedKeys.includes(row.key)

  useEffect(() => { setDraft(row) }, [row])

  const gateOn = !!draft.gate
  const impSel = draft.importance_default === 'inherit' || draft.importance_default == null
    ? 'inherit' : String(draft.importance_default)

  async function save() {
    setBusy(true); setErr(null)
    try { await onSave(draft) ; setOpen(false) }
    catch (e) { setErr(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="border border-gray-200 rounded-lg">
      <div className="flex items-center gap-2 px-3 py-2">
        <button className="text-gray-400 hover:text-gray-700 text-xs w-4" onClick={() => setOpen(o => !o)}>{open ? '▾' : '▸'}</button>
        <span className="text-sm font-medium text-gray-800">{draft.label || '(unnamed)'}</span>
        <code className="text-[11px] text-gray-500">{draft.key || '(no key)'}</code>
        {locked && <span className="text-[10px] text-amber-600" title="referenced by existing skills">🔒 in use</span>}
        <span className="text-[11px] text-gray-400 ml-auto">{appliesSummary(draft.applies_when)}{draft.gate ? ` · gated on ${draft.gate.requires} ≥ ${draft.gate.min_level}` : ''}</span>
        {!isNew && (
          <button className="text-gray-300 hover:text-red-500 text-sm disabled:opacity-30" disabled={locked}
            title={locked ? 'in use — cannot delete' : 'delete'} onClick={() => onDelete(row)}>✕</button>
        )}
      </div>

      {open && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-3 border-t border-gray-100">
          <div className="flex gap-2 flex-wrap">
            <Field label="Label"><input className={inputCls + ' w-44'} value={draft.label ?? ''} onChange={e => setDraft(d => ({ ...d, label: e.target.value }))} /></Field>
            <Field label="Key (stored on skill rows)">
              <input className={inputCls + ' w-44 font-mono'} value={draft.key ?? ''} disabled={locked}
                onChange={e => setDraft(d => ({ ...d, key: e.target.value }))} />
            </Field>
            <Field label="Kind">
              <select className={inputCls} value={draft.kind ?? 'vocabulary'} disabled={locked}
                onChange={e => setDraft(d => ({ ...d, kind: e.target.value }))}>
                {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </Field>
            <Field label="Default importance">
              <select className={inputCls} value={impSel}
                onChange={e => setDraft(d => ({ ...d, importance_default: e.target.value === 'inherit' ? 'inherit' : Number(e.target.value) }))}>
                <option value="inherit">Inherit from card</option>
                {Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </Field>
            <Field label="Display order"><input type="number" className={inputCls + ' w-20'} value={draft.display_order ?? 0}
              onChange={e => setDraft(d => ({ ...d, display_order: Number(e.target.value) }))} /></Field>
          </div>

          <AppliesWhenControl syncKey={row.id ?? row._draftId} value={draft.applies_when} tagCatalog={tagCatalog}
            onChange={v => setDraft(d => ({ ...d, applies_when: v }))} />

          <div className="flex gap-2 items-end">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={gateOn}
                onChange={e => setDraft(d => ({ ...d, gate: e.target.checked ? { requires: siblings[0]?.key ?? '', min_level: 3, state: 'stable' } : null }))} />
              Locked until another skill is learned
            </label>
            {gateOn && (
              <>
                <Field label="Requires">
                  <select className={inputCls} value={draft.gate.requires}
                    onChange={e => setDraft(d => ({ ...d, gate: { ...d.gate, requires: e.target.value } }))}>
                    {siblings.filter(s => s.key !== draft.key).map(s => <option key={s.key} value={s.key}>{s.key}</option>)}
                  </select>
                </Field>
                <Field label="at level ≥">
                  <input type="number" min={1} max={10} className={inputCls + ' w-16'} value={draft.gate.min_level}
                    onChange={e => setDraft(d => ({ ...d, gate: { ...d.gate, min_level: Number(e.target.value) } }))} />
                </Field>
                <span className="text-xs text-gray-500 pb-1">and in a stable state</span>
              </>
            )}
          </div>

          {err && <p className="text-xs text-red-500">{err}</p>}
          <div className="flex gap-2">
            <button className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-40" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : isNew ? 'Create' : 'Save'}
            </button>
            {isNew && <button className="px-3 py-1 text-sm text-gray-500" onClick={() => onDelete(row)}>Discard</button>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── drill rule row ───────────────────────────────────────────────────────────
function DrillRuleRow({ row, skillTypes, questionTypes, weightCurves, tagCatalog, onSave, onDelete }) {
  const isNew = !row.id
  const [open, setOpen] = useState(isNew)
  const [draft, setDraft] = useState(row)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  useEffect(() => { setDraft(row) }, [row])

  async function save() {
    setBusy(true); setErr(null)
    try { await onSave(draft); setOpen(false) }
    catch (e) { setErr(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="border border-gray-200 rounded-lg">
      <div className="flex items-center gap-2 px-3 py-2">
        <button className="text-gray-400 hover:text-gray-700 text-xs w-4" onClick={() => setOpen(o => !o)}>{open ? '▾' : '▸'}</button>
        <span className={`w-1.5 h-1.5 rounded-full ${draft.enabled === false ? 'bg-gray-300' : 'bg-green-500'}`} />
        <span className="text-sm text-gray-800">{draft.question_type}</span>
        <span className="text-[11px] text-gray-400">{draft.weight_curve ?? 'flat'}{draft.require_frame ? ' · frame' : ''}</span>
        <span className="text-[11px] text-gray-400 ml-auto">{appliesSummary(draft.applies_when)}{draft.priority ? ` · prio ${draft.priority}` : ''}</span>
        {!isNew && <button className="text-gray-300 hover:text-red-500 text-sm" title="delete" onClick={() => onDelete(row)}>✕</button>}
      </div>

      {open && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-3 border-t border-gray-100">
          <div className="flex gap-2 flex-wrap items-end">
            <Field label="Skill type">
              <select className={inputCls} value={`${draft.kind}/${draft.skill_type_key}`}
                onChange={e => { const [k, key] = e.target.value.split('/'); setDraft(d => ({ ...d, kind: k, skill_type_key: key })) }}>
                {skillTypes.map(s => <option key={s.id ?? `${s.kind}/${s.key}`} value={`${s.kind}/${s.key}`}>{s.kind} / {s.key}</option>)}
              </select>
            </Field>
            <Field label="Question type">
              <select className={inputCls} value={draft.question_type} onChange={e => setDraft(d => ({ ...d, question_type: e.target.value }))}>
                {questionTypes.map(q => <option key={q} value={q}>{q}</option>)}
              </select>
            </Field>
            <Field label="Weight curve">
              <select className={inputCls} value={draft.weight_curve ?? 'flat'} onChange={e => setDraft(d => ({ ...d, weight_curve: e.target.value }))}>
                {weightCurves.map(w => <option key={w} value={w}>{w}</option>)}
              </select>
            </Field>
            <Field label="Level floor"><input type="number" min={1} max={10} className={inputCls + ' w-16'} value={draft.level_floor ?? ''}
              onChange={e => setDraft(d => ({ ...d, level_floor: e.target.value === '' ? null : Number(e.target.value) }))} /></Field>
            <Field label="Level ceiling"><input type="number" min={1} max={10} className={inputCls + ' w-16'} value={draft.level_ceiling ?? ''}
              onChange={e => setDraft(d => ({ ...d, level_ceiling: e.target.value === '' ? null : Number(e.target.value) }))} /></Field>
            <Field label="Priority"><input type="number" className={inputCls + ' w-16'} value={draft.priority ?? 0}
              onChange={e => setDraft(d => ({ ...d, priority: Number(e.target.value) }))} /></Field>
            <label className="flex items-center gap-1.5 text-sm text-gray-700 pb-1">
              <input type="checkbox" checked={draft.enabled !== false} onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))} /> enabled
            </label>
            <label className="flex items-center gap-1.5 text-sm text-gray-700 pb-1">
              <input type="checkbox" checked={!!draft.require_frame} onChange={e => setDraft(d => ({ ...d, require_frame: e.target.checked }))} /> require frame
            </label>
          </div>

          <AppliesWhenControl syncKey={row.id ?? row._draftId} value={draft.applies_when} tagCatalog={tagCatalog}
            onChange={v => setDraft(d => ({ ...d, applies_when: v }))} />

          <Field label="Extra prompt ({cardName} / {cardStem} are substituted; the question-type task template is always prepended)">
            <textarea className={inputCls + ' font-mono h-40 resize-y'} value={draft.prompt ?? ''} onChange={e => setDraft(d => ({ ...d, prompt: e.target.value }))} />
          </Field>

          {err && <p className="text-xs text-red-500">{err}</p>}
          <div className="flex gap-2">
            <button className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-40" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : isNew ? 'Create' : 'Save'}
            </button>
            {isNew && <button className="px-3 py-1 text-sm text-gray-500" onClick={() => onDelete(row)}>Discard</button>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── main ─────────────────────────────────────────────────────────────────────
export function LanguagePackEditor({ project, tagCatalog = [] }) {
  const refreshLanguagePack = useRefreshLanguagePack()
  const [pack, setPack] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [drafts, setDrafts] = useState([]) // unsaved new rows: { _draftId, target, ...fields }
  const [policy, setPolicy] = useState('')
  const [exemptTags, setExemptTags] = useState('')
  const [metaBusy, setMetaBusy] = useState(false)
  const [metaMsg, setMetaMsg] = useState(null)

  async function load() {
    setLoadErr(null)
    const r = await apiFetch(`/api/language-pack?project_id=${project.id}`)
    const data = await r.json()
    if (!r.ok) { setLoadErr(data.error ?? 'Failed to load'); return }
    setPack(data)
    setPolicy(data.meta?.vocabulary_policy ?? '')
    setExemptTags((data.meta?.sense_exempt_tags ?? []).join(', '))
  }
  useEffect(() => { load() }, [project.id])

  const skillTypesByKind = useMemo(() => {
    const m = { vocabulary: [], grammar: [], expression: [] }
    for (const s of pack?.skill_types ?? []) (m[s.kind] ??= []).push(s)
    return m
  }, [pack])

  const drillsByType = useMemo(() => {
    const m = new Map()
    for (const d of pack?.drill_rules ?? []) {
      const k = `${d.kind}/${d.skill_type_key}`
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(d)
    }
    return m
  }, [pack])

  async function saveRow(target, draft) {
    const isNew = !draft.id
    const path = isNew ? `/api/language-pack?project_id=${project.id}` : `/api/language-pack?project_id=${project.id}&id=${draft.id}`
    const body = isNew ? { target, row: draft } : { target, patch: draft }
    const r = await apiFetch(path, { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify(body) })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error ?? 'Save failed')
    setDrafts(ds => ds.filter(d => d._draftId !== draft._draftId))
    await load()
    refreshLanguagePack() // so SkillBadge / SkillsPanel / CardDetailPanel pick up the change
  }

  async function deleteRow(target, row) {
    if (!row.id) { setDrafts(ds => ds.filter(d => d._draftId !== row._draftId)); return }
    if (!confirm(`Delete this ${target.replace('_', ' ')}?`)) return
    const r = await apiFetch(`/api/language-pack?project_id=${project.id}&id=${row.id}&target=${target}`, { method: 'DELETE' })
    if (!r.ok && r.status !== 204) { const d = await r.json().catch(() => ({})); alert(d.error ?? 'Delete failed'); return }
    await load()
    refreshLanguagePack()
  }

  function addSkillType(kind) {
    setDrafts(ds => [...ds, { _draftId: crypto.randomUUID(), _target: 'skill_type', kind, key: '', label: '', applies_when: null, gate: null, importance_default: 'inherit', display_order: 0 }])
  }
  function addDrillRule(kind, skill_type_key) {
    setDrafts(ds => [...ds, { _draftId: crypto.randomUUID(), _target: 'drill_rule', kind, skill_type_key, question_type: pack.question_types[0], applies_when: null, priority: 0, enabled: true, weight_curve: 'flat', level_floor: null, level_ceiling: null, require_frame: false, prompt: '' }])
  }

  async function saveMeta() {
    setMetaBusy(true); setMetaMsg(null)
    try {
      const r = await apiFetch(`/api/language-pack?project_id=${project.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ meta: { vocabulary_policy: policy, sense_exempt_tags: exemptTags.split(',').map(s => s.trim()).filter(Boolean) } }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? 'Save failed')
      setMetaMsg('Saved.')
      refreshLanguagePack()
    } catch (e) { setMetaMsg(e.message) }
    finally { setMetaBusy(false) }
  }

  if (loadErr) return <p className="text-sm text-red-500">{loadErr}</p>
  if (!pack) return <p className="text-sm text-gray-400">Loading pack…</p>

  const allSkillTypes = pack.skill_types
  const draftSkillTypes = drafts.filter(d => d._target === 'skill_type')
  const draftDrills = drafts.filter(d => d._target === 'drill_rule')

  return (
    <div className="flex flex-col gap-6 text-gray-800">
      {/* Skill types */}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Grammatical features (skill types)</h3>
        <p className="text-xs text-gray-500">Each is one assessable facet a card can have — it carries its own level and schedule. Which cards get it is decided by tags.</p>
        {KINDS.map(kind => (
          <div key={kind} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{kind}</span>
              <button className="text-xs text-blue-600 hover:underline" onClick={() => addSkillType(kind)}>+ add</button>
            </div>
            {[...(skillTypesByKind[kind] ?? []), ...draftSkillTypes.filter(d => d.kind === kind)].map(row => (
              <SkillTypeRow key={row.id ?? row._draftId} row={row} siblings={skillTypesByKind[kind] ?? []}
                usedKeys={pack.used_keys} tagCatalog={tagCatalog}
                onSave={d => saveRow('skill_type', d)} onDelete={r => deleteRow('skill_type', r)} />
            ))}
          </div>
        ))}
      </section>

      {/* Drill rules */}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Drill rules</h3>
        <p className="text-xs text-gray-500">How each skill type is practised: which question type, at what weight, with what extra prompt prose. Multiple rules per skill type are picked by priority then tag match.</p>
        {allSkillTypes.map(st => {
          const key = `${st.kind}/${st.key}`
          const rules = drillsByType.get(key) ?? []
          const rdrafts = draftDrills.filter(d => d.kind === st.kind && d.skill_type_key === st.key)
          return (
            <div key={st.id} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[11px] font-semibold text-gray-500">{st.kind} / {st.key}</span>
                <button className="text-xs text-blue-600 hover:underline" onClick={() => addDrillRule(st.kind, st.key)}>+ add</button>
                {rules.length === 0 && rdrafts.length === 0 && <span className="text-[11px] text-amber-600">no drill — never auto-practised</span>}
              </div>
              {[...rules, ...rdrafts].map(row => (
                <DrillRuleRow key={row.id ?? row._draftId} row={row} skillTypes={allSkillTypes}
                  questionTypes={pack.question_types} weightCurves={pack.weight_curves} tagCatalog={tagCatalog}
                  onSave={d => saveRow('drill_rule', d)} onDelete={r => deleteRow('drill_rule', r)} />
              ))}
            </div>
          )
        })}
      </section>

      {/* Vocabulary policy + sense-exempt */}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Vocabulary policy</h3>
        <p className="text-xs text-gray-500">Hard constraint on every practice sentence's other words. Applied to all question types.</p>
        <textarea className={inputCls + ' h-28 resize-y'} value={policy} onChange={e => setPolicy(e.target.value)} />
        <label className={labelCls}>Sense-exempt tags (never sense-split — comma-separated)</label>
        <input className={inputCls} value={exemptTags} onChange={e => setExemptTags(e.target.value)} placeholder="preposition, particle, article" />
        <div className="flex items-center gap-3">
          <button className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-40 self-start" disabled={metaBusy} onClick={saveMeta}>
            {metaBusy ? 'Saving…' : 'Save vocabulary policy'}
          </button>
          {metaMsg && <span className="text-xs text-gray-500">{metaMsg}</span>}
        </div>
      </section>
    </div>
  )
}
