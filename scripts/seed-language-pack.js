// Seed a project's language pack (skill_type_def + drill_rule rows) from a code template, so the
// switch to pack-driven skill/practice code (plan-language-packs.md phase 2) causes NO observable
// behavior change on an existing project. Run once per project after `npm run migrate`.
//
// Usage:
//   node scripts/seed-language-pack.js --project <uuid> [--pack german] [--dry-run]
//   npm run seed:pack -- --project <uuid>
//
// Idempotent:
//   - skill_type_def: upsert on (project_id, kind, key) — labels/gates/rules refreshed in place,
//     `key` never changes, so existing `skill` rows (which reference the key via skill.type) are
//     untouched.
//   - drill_rule: has no natural unique key (multiple rows per (kind, skill_type, question_type),
//     disambiguated by applies_when/priority), so all rows for the project are deleted and
//     reinserted. drill_rule holds no state — pure config — so this is safe.

import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import GERMAN_SEED from '../lib/languagePacks/germanSeed.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../.env') })

const PACKS = { german: GERMAN_SEED }

function arg(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : undefined
}
const dryRun = process.argv.includes('--dry-run')
const projectId = arg('--project')
const packName = arg('--pack') ?? 'german'

if (!projectId) {
  console.error('Missing --project <uuid>')
  process.exit(1)
}
const pack = PACKS[packName]
if (!pack) {
  console.error(`Unknown --pack "${packName}". Known: ${Object.keys(PACKS).join(', ')}`)
  process.exit(1)
}

const { VITE_SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
if (!VITE_SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SECRET_KEY in .env')
  process.exit(1)
}
const supabase = createClient(VITE_SUPABASE_URL, SUPABASE_SECRET_KEY)

async function main() {
  const { data: project, error: projErr } = await supabase
    .from('projects').select('id, name, config').eq('id', projectId).single()
  if (projErr || !project) {
    console.error(`Project ${projectId} not found: ${projErr?.message ?? 'no row'}`)
    process.exit(1)
  }

  // meta (vocabulary policy + sense-exempt word classes) has no table — it lives in
  // projects.config.language_meta, read by lib/languagePack.js's resolveLanguagePack.
  const languageMeta = {
    vocabulary_policy: pack.meta.vocabulary_policy,
    sense_exempt_tags: pack.meta.sense_exempt_tags,
  }
  const nextConfig = { ...(project.config ?? {}), language_meta: languageMeta }

  const skillTypeRows = pack.skill_types.map(st => ({
    project_id: projectId,
    key: st.key,
    kind: st.kind,
    label: st.label,
    applies_when: st.applies_when ?? null,
    gate: st.gate ?? null,
    importance_default: st.importance_default ?? 'inherit',
    display_order: st.display_order ?? 0,
  }))

  const drillRuleRows = pack.drill_rules.map(dr => ({
    project_id: projectId,
    kind: dr.kind,
    skill_type_key: dr.skill_type_key,
    question_type: dr.question_type,
    applies_when: dr.applies_when ?? null,
    priority: dr.priority ?? 0,
    enabled: dr.enabled ?? true,
    weight_curve: dr.weight_curve ?? 'flat',
    level_floor: dr.level_floor ?? null,
    level_ceiling: dr.level_ceiling ?? null,
    require_frame: dr.require_frame ?? false,
    prompt: dr.prompt ?? '',
  }))

  console.log(`Project: ${project.name} (${project.id})`)
  console.log(`Pack: ${packName} — ${skillTypeRows.length} skill types, ${drillRuleRows.length} drill rules`)
  console.log(`config.language_meta.sense_exempt_tags: ${languageMeta.sense_exempt_tags.join(', ')}`)
  console.log(`config.language_meta.vocabulary_policy: ${languageMeta.vocabulary_policy.length} chars`)

  if (dryRun) {
    console.log('\n[dry run] Would upsert skill_type_def:')
    for (const r of skillTypeRows) console.log(`  ${r.kind}/${r.key}  applies_when=${JSON.stringify(r.applies_when)}  gate=${JSON.stringify(r.gate)}`)
    console.log('[dry run] Would replace drill_rule with:')
    for (const r of drillRuleRows) console.log(`  ${r.kind}/${r.skill_type_key}/${r.question_type}  prio=${r.priority}  frame=${r.require_frame}  applies_when=${JSON.stringify(r.applies_when)}  prompt=${r.prompt ? `${r.prompt.length} chars` : 'empty'}`)
    console.log('[dry run] Would merge projects.config.language_meta')
    console.log('\n[dry run] No writes performed.')
    return
  }

  const { error: cfgErr } = await supabase.from('projects').update({ config: nextConfig }).eq('id', projectId)
  if (cfgErr) {
    console.error('Failed to update projects.config.language_meta:', cfgErr.message)
    process.exit(1)
  }

  const { error: stErr } = await supabase
    .from('skill_type_def')
    .upsert(skillTypeRows, { onConflict: 'project_id,kind,key' })
  if (stErr) {
    console.error('Failed to upsert skill_type_def:', stErr.message)
    process.exit(1)
  }

  const { error: delErr } = await supabase.from('drill_rule').delete().eq('project_id', projectId)
  if (delErr) {
    console.error('Failed to clear drill_rule:', delErr.message)
    process.exit(1)
  }
  const { error: drErr } = await supabase.from('drill_rule').insert(drillRuleRows)
  if (drErr) {
    console.error('Failed to insert drill_rule:', drErr.message)
    process.exit(1)
  }

  console.log('\nSeed complete.')
}

main()
