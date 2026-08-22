// Prompt Iteration Harness — see plan.md. Generates many practice items for one skill (or one
// card's skills) in parallel and prints them densely so variance across samples is visible at a
// glance, instead of one item at a time in the practice UI. Runs against the real database — no
// fixture layer. Calls the exact same generatePracticeItem()/getPracticeRule() code paths
// api/practice.js uses, so what you see here is what the app would actually produce.
//
// There is no scoring here. The wall is the whole tool.
//
//   node scripts/prompt-run.js --skill <skill_id> --n 20
//   node scripts/prompt-run.js --skill <skill_id> --n 20 --prompt practice.mc_cloze.gender
//   node scripts/prompt-run.js --card <name|id> --n 20
//   node scripts/prompt-run.js --skill <skill_id> --compare live drafts/a --n 10
//   node scripts/prompt-run.js --skill <skill_id> --n 20 --mark
//   node scripts/prompt-run.js --skill <skill_id> --watch
//   node scripts/prompt-run.js --skill <skill_id> --n 20 --batch 5   (20 conversations x 5 items
//                                                                     each, diversified within each
//                                                                     conversation — see --batch below)
//
// (also available as `npm run prompt:run --`)

import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { appendFileSync, watch as fsWatch } from 'fs'
import { execFileSync } from 'child_process'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

import { generatePracticeItem, generatePracticeBatch, composePracticePrompt, PracticeGenerationFailedError, DEFAULT_PRACTICE_MODEL } from '../lib/practiceGenerate.js'
import { getPracticeRule, resolvePracticeRule } from '../lib/practiceRules.js'
import { promptKeyFor, ensurePromptFiles, readLivePrompt, resolveVersionSpec, livePromptPath, relativeToRepo } from '../lib/prompts/promptFiles.js'
import { resolveSkillType } from '../lib/skillTypes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
config({ path: resolve(REPO_ROOT, '.env') })

const { VITE_SUPABASE_URL, SUPABASE_SECRET_KEY, ANTHROPIC_API_KEY } = process.env
if (!VITE_SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SECRET_KEY in .env')
  process.exit(1)
}
if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env')
  process.exit(1)
}

const supabase = createClient(VITE_SUPABASE_URL, SUPABASE_SECRET_KEY)
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
const MODEL = process.env.PRACTICE_MODEL || DEFAULT_PRACTICE_MODEL
const NOTES_PATH = resolve(REPO_ROOT, 'prompt-notes.jsonl')

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Mirrors api/practice.js's own seed-pool sampling exactly, so the prompt this harness composes
// matches what the live app would actually send — a fresh random 15 (out of up to 300 candidate
// vocabulary cards) each time this is called, excluding the card under test.
async function fetchSeedCardNames(projectId, excludeCardId) {
  const { data: seedPool } = await supabase
    .from('knowledge_cards')
    .select('name')
    .eq('project_id', projectId)
    .eq('kind', 'vocabulary')
    .neq('id', excludeCardId)
    .limit(300)
  return shuffle(seedPool ?? []).slice(0, 15).map(c => c.name)
}

// ── args ──────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { n: 20 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--skill': args.skill = argv[++i]; break
      case '--card': args.card = argv[++i]; break
      case '--n': args.n = parseInt(argv[++i], 10); break
      case '--prompt': args.prompt = argv[++i]; break
      case '--compare': args.compare = [argv[++i], argv[++i]]; break
      case '--mark': args.mark = true; break
      case '--watch': args.watch = true; break
      case '--terse': args.terse = true; break
      case '--batch': args.batch = parseInt(argv[++i], 10); break
      default: throw new Error(`Unknown argument: ${a}`)
    }
  }
  if (!args.skill && !args.card) throw new Error('--skill or --card is required')
  if (args.skill && args.card) throw new Error('--skill and --card are mutually exclusive')
  if (!Number.isFinite(args.n) || args.n <= 0) throw new Error('--n must be a positive integer')
  if (args.batch !== undefined && (!Number.isFinite(args.batch) || args.batch <= 0)) {
    throw new Error('--batch must be a positive integer')
  }
  return args
}

// ── db resolution ────────────────────────────────────────────────────────────────────────────

async function resolveSkillById(skillId) {
  const { data, error } = await supabase
    .from('skill')
    .select('id, type, sense_type, level, card_id, knowledge_cards!inner(id, name, kind, tags, details, project_id)')
    .eq('id', skillId)
    .single()
  if (error || !data) throw new Error(`Skill ${skillId} not found`)
  const card = data.knowledge_cards
  const { data: project } = await supabase.from('projects').select('tts_locale').eq('id', card.project_id).single()
  // A sense skill's DB type is always literally 'meaning' — resolveSkillType() gives back its real
  // identity (the sense key), same as every other read path (see lib/skillTypes.js).
  return { skillType: resolveSkillType(data), level: data.level ?? 1, card, ttsLocale: project?.tts_locale }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function resolveCardSkills(nameOrId) {
  let card
  if (UUID_RE.test(nameOrId)) {
    const { data } = await supabase.from('knowledge_cards').select('id, name, kind, tags, details, project_id').eq('id', nameOrId).single()
    card = data
  } else {
    const { data } = await supabase.from('knowledge_cards').select('id, name, kind, tags, details, project_id').ilike('name', nameOrId).limit(1)
    card = data?.[0]
  }
  if (!card) throw new Error(`Card "${nameOrId}" not found`)
  const { data: project } = await supabase.from('projects').select('tts_locale').eq('id', card.project_id).single()
  const { data: skills } = await supabase.from('skill').select('id, type, sense_type, level').eq('card_id', card.id)
  return { card, ttsLocale: project?.tts_locale, skills: (skills ?? []).map(s => ({ ...s, type: resolveSkillType(s) })) }
}

// Resolves { problemType, questionType, extraPrompt, promptKey } for one skill, honoring --prompt
// (a full promptKey like "practice.mc_cloze.gender", or bare problemType like "mc_cloze") if given,
// then applies the on-disk override from prompts/<promptKey>/prompt.md if present (see
// lib/prompts/promptFiles.js) — seeding that file from the current hardcoded extraPrompt on first
// use so there's always a live copy to edit.
function resolveRule({ skillType, level, cardName, cardTags, promptOverride }) {
  let rule
  if (promptOverride) {
    const parts = promptOverride.split('.')
    const problemType = parts.length >= 3 ? parts[1] : promptOverride
    rule = resolvePracticeRule(skillType, problemType, { cardName, cardTags })
    if (!rule) throw new Error(`No problem type "${problemType}" configured for skill type "${skillType}"`)
  } else {
    rule = getPracticeRule(skillType, level, { cardName, cardTags })
    if (!rule) throw new Error(`No practiceable problem type configured for skill type "${skillType}" at level ${level}`)
  }
  const promptKey = promptKeyFor(skillType, rule.problemType)
  const { seeded, promptPath } = ensurePromptFiles(promptKey, rule.extraPrompt)
  if (seeded) console.error(`(seeded ${relativeToRepo(promptPath)} from the current prompt)`)
  const override = readLivePrompt(promptKey)
  return { ...rule, extraPrompt: override ?? rule.extraPrompt, promptKey }
}

// ── generation ───────────────────────────────────────────────────────────────────────────────

async function generateOne({ mode, promptContext }) {
  try {
    const item = await generatePracticeItem({ anthropic, model: MODEL, mode, promptContext })
    return { ok: true, item }
  } catch (e) {
    const message = e instanceof PracticeGenerationFailedError ? (e.detail || e.message) : e.message
    return { ok: false, error: message }
  }
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────

function pad(i) {
  return i.toString().padStart(2)
}

// `used_seed_words` (optional, item-reported — see the "Other vocabulary already known" section of
// the composed prompt) is shown on its own line so seed-list usage is visible per item, not just
// in aggregate — useful for spotting a prompt that's cramming the seed list into every sentence.
function seedLine(item) {
  return item.used_seed_words?.length ? `    seeds: ${item.used_seed_words.join(', ')}` : null
}

function renderItem(index, mode, result, terse) {
  if (!result.ok) return `${pad(index)}  [error] ${result.error}`
  const item = result.item
  if (mode === 'mc_cloze') {
    const lines = [`${pad(index)}  ${item.sentence}`]
    if (!terse) {
      if (item.frame) lines.push(`    frame: ${item.frame}`)
      lines.push(`    ${item.options.join(' / ').padEnd(58)} → ${item.answer}`)
      if (item.distractor_reasons?.length) {
        for (const { option, reason } of item.distractor_reasons) lines.push(`    ✗ ${option}: ${reason}`)
      }
      const seeds = seedLine(item)
      if (seeds) lines.push(seeds)
    }
    return lines.join('\n')
  }
  if (mode === 'spelling') {
    const lines = [`${pad(index)}  ${item.sentence}`]
    if (!terse) {
      lines.push(`    ${item.meaning.padEnd(58)} → ${item.answer}`)
      const seeds = seedLine(item)
      if (seeds) lines.push(seeds)
    }
    return lines.join('\n')
  }
  // exemplar — single line, target word bracketed
  const [s, e] = item.target_span
  const marked = item.sentence.slice(0, s) + '[' + item.sentence.slice(s, e) + ']' + item.sentence.slice(e)
  const lines = [`${pad(index)}  ${marked}`]
  if (!terse) {
    const seeds = seedLine(item)
    if (seeds) lines.push(seeds)
  }
  return lines.join('\n')
}

function oneLineItem(mode, result) {
  if (!result.ok) return `[error] ${result.error}`
  const item = result.item
  if (mode === 'exemplar') {
    const [s, e] = item.target_span
    return item.sentence.slice(0, s) + '[' + item.sentence.slice(s, e) + ']' + item.sentence.slice(e)
  }
  return item.sentence
}

function header({ promptKey, cardName, skillType, level, n, elapsed, extra = '' }) {
  return `${promptKey} · ${cardName} · ${skillType} ${level} · ${n} samples${extra} · ${elapsed}s`
}

// The exact system prompt this run will send — composed via the same compose() call
// generatePracticeItem() itself uses, so what's printed is guaranteed to match what's sent, not a
// re-derived approximation of it.
function printPromptBlock(promptKey, mode, promptContext) {
  const rule = '─'.repeat(78)
  const text = composePracticePrompt(mode, promptContext).trim()
  console.log(rule)
  console.log(`prompt · ${promptKey}`)
  console.log(rule)
  console.log(text)
  console.log(rule)
  console.log('')
}

// ── run modes ────────────────────────────────────────────────────────────────────────────────

// ctx.batchSize, if set, generates ctx.n CONVERSATIONS of ctx.batchSize items each (via
// generatePracticeBatch) instead of ctx.n independent one-shot items — see --batch. Each
// conversation is printed as its own labeled group so within-conversation diversity (forced by
// diversifyTurnText) and across-conversation diversity (still independent draws, still possibly
// collapsing to similar territory) can both be judged by eye. Without batchSize, behaves exactly
// as before: ctx.n independent single-item generations, unlabeled.
//
// Each conversation (a --batch group, or a single one-shot item without --batch) draws its own
// fresh seedCardNames sample — mirroring api/practice.js, where every live request re-samples from
// the pool independently. Sharing one sample across the whole run would mean every conversation in
// a --batch run "already knows" the exact same other words, which understates how varied real
// sessions look.
async function runOnce(ctx) {
  const previewSeeds = await fetchSeedCardNames(ctx.promptContext.card.project_id, ctx.promptContext.card.id)
  printPromptBlock(ctx.promptKey, ctx.mode, { ...ctx.promptContext, seedCardNames: previewSeeds })
  const start = Date.now()
  // Each conversation's own draw is kept alongside its results (not just handed to generation and
  // discarded) so the wall can print what that conversation was actually offered, not just what the
  // model claims to have used (renderItem's `seeds:` line, sourced from `used_seed_words`).
  const runs = await Promise.all(Array.from({ length: ctx.n }, async () => {
    const seedCardNames = await fetchSeedCardNames(ctx.promptContext.card.project_id, ctx.promptContext.card.id)
    const promptContext = { ...ctx.promptContext, seedCardNames }
    const batch = ctx.batchSize
      ? await generatePracticeBatch({ anthropic, model: MODEL, mode: ctx.mode, promptContext, batchSize: ctx.batchSize })
      : [await generateOne({ mode: ctx.mode, promptContext })]
    return { seedCardNames, batch }
  }))
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  const results = runs.flatMap(r => r.batch)
  const extra = ctx.batchSize ? ` (${ctx.n} conversations × ${ctx.batchSize})` : ''
  console.log(header({ promptKey: ctx.promptKey, cardName: ctx.cardName, skillType: ctx.skillType, level: ctx.level, n: results.length, elapsed, extra }))
  console.log('')
  let index = 1
  runs.forEach(({ seedCardNames, batch }, i) => {
    const seedsLabel = seedCardNames.length ? seedCardNames.join(', ') : '(none)'
    console.log(ctx.batchSize ? `  ── conversation ${i + 1} · seeds: ${seedsLabel} ──` : `  ── seeds: ${seedsLabel} ──`)
    batch.forEach(r => { console.log(renderItem(index, ctx.mode, r, ctx.terse)); index++ })
  })
  return results
}

async function buildSkillContext(args, resolved) {
  const { skillType, level, card, ttsLocale } = resolved
  const rule = resolveRule({ skillType, level, cardName: card.name, cardTags: card.tags, promptOverride: args.prompt })
  // seedCardNames is filled in per-conversation by runOnce, not here — see its comment.
  const promptContext = { ttsLocale, card, skillType, problemType: rule.problemType, extraPrompt: rule.extraPrompt, seedCardNames: [] }
  return {
    mode: rule.questionType, promptContext, n: args.n, terse: args.terse,
    promptKey: rule.promptKey, cardName: card.name, skillType, level,
    batchSize: args.batch,
  }
}

async function runCardMode(args) {
  const { card, ttsLocale, skills } = await resolveCardSkills(args.card)
  const practiceable = skills
    .map(s => ({ ...s, rule: getPracticeRule(s.type, s.level ?? 1, { cardName: card.name, cardTags: card.tags }) }))
    .filter(s => s.rule)
  if (practiceable.length === 0) throw new Error(`Card "${card.name}" has no skills with a configured problem type`)

  // seedCardNames is filled in per-conversation by runOnce, not here — see its comment.
  const base = Math.floor(args.n / practiceable.length)
  let extra = args.n % practiceable.length

  for (const s of practiceable) {
    const count = base + (extra > 0 ? 1 : 0)
    if (extra > 0) extra--
    if (count === 0) continue
    const promptKey = promptKeyFor(s.type, s.rule.problemType)
    const { seeded, promptPath } = ensurePromptFiles(promptKey, s.rule.extraPrompt)
    if (seeded) console.error(`(seeded ${relativeToRepo(promptPath)} from the current prompt)`)
    const extraPrompt = readLivePrompt(promptKey) ?? s.rule.extraPrompt
    const promptContext = { ttsLocale, card, skillType: s.type, problemType: s.rule.problemType, extraPrompt, seedCardNames: [] }
    await runOnce({
      mode: s.rule.questionType, promptContext, n: count, terse: args.terse,
      promptKey, cardName: card.name, skillType: s.type, level: s.level ?? 1, batchSize: args.batch,
    })
    console.log('')
  }
}

// Deliberately never prints the composed prompt (unlike runOnce) — doing so before the A/B reveal
// would let the user recognize their own draft's wording and unblind the comparison.
async function runCompare(args, resolved) {
  const { skillType, level, card, ttsLocale } = resolved
  const rule = args.prompt
    ? resolvePracticeRule(skillType, args.prompt.split('.')[1] ?? args.prompt, { cardName: card.name, cardTags: card.tags })
    : getPracticeRule(skillType, level, { cardName: card.name, cardTags: card.tags })
  if (!rule) throw new Error(`No practiceable problem type configured for skill type "${skillType}"`)
  const promptKey = promptKeyFor(skillType, rule.problemType)
  ensurePromptFiles(promptKey, rule.extraPrompt)

  const specs = args.compare
  const versions = specs.map(s => resolveVersionSpec(promptKey, s))

  // Which physical version is "A" vs "B" is randomized and only revealed after the wall prints —
  // otherwise the user sees what they expect to see in whichever one they know was just edited.
  const order = Math.random() < 0.5 ? [0, 1] : [1, 0]
  const labeled = { A: versions[order[0]], B: versions[order[1]] }
  const labeledSpec = { A: specs[order[0]], B: specs[order[1]] }

  // One fresh seed-word sample per pair index, shared between A and B at that index — real seed
  // pools (same as api/practice.js), but drawn once per index rather than once per label so a
  // difference between A and B is never just a different seed draw.
  const seeds = await Promise.all(Array.from({ length: args.n }, () => fetchSeedCardNames(card.project_id, card.id)))

  const start = Date.now()
  const pairs = await Promise.all(seeds.map(seedCardNames => Promise.all(['A', 'B'].map(async label => {
    const promptContext = { ttsLocale, card, skillType, problemType: rule.problemType, extraPrompt: labeled[label].text, seedCardNames }
    const result = await generateOne({ mode: rule.questionType, promptContext })
    return { label, result }
  }))))
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)

  console.log(header({ promptKey, cardName: card.name, skillType, level, n: args.n, elapsed, extra: ' (compare)' }))
  console.log('')
  pairs.forEach((pair, i) => {
    console.log(pad(i + 1))
    pair.forEach(({ label, result }) => console.log(`   ${label}  ${oneLineItem(rule.questionType, result)}`))
    console.log('')
  })
  console.log(`A = ${labeledSpec.A}, B = ${labeledSpec.B}`)
}

// ── --mark ───────────────────────────────────────────────────────────────────────────────────

// Stdin readers for --mark. Interactive (TTY): raw byte-by-byte mode for the whole flow, so a
// single keypress needs no Enter — mode is set once and never toggled mid-session, since toggling
// raw on/off per read risks two listeners racing for the same bytes. A note (after 'b') is read the
// same way, accumulating bytes until Enter. Non-TTY (piped — scripting/testing this flow): line-
// buffered instead, since raw mode isn't available; a chunk may contain more than one line, or a
// partial one, so leftover bytes are held across calls rather than discarded.

function rawReadByte() {
  return new Promise(resolve => process.stdin.once('data', buf => resolve(buf.toString())))
}

async function rawReadLine() {
  let line = ''
  while (true) {
    const chunk = await rawReadByte()
    if (chunk === '\u0003') process.exit(130) // Ctrl+C
    if (chunk.includes('\r') || chunk.includes('\n')) {
      line += chunk.split(/[\r\n]/)[0]
      process.stdout.write('\n')
      return line
    }
    if (chunk === '\u007f' || chunk === '\b') {
      line = line.slice(0, -1)
      process.stdout.write('\b \b')
    } else {
      line += chunk
      process.stdout.write(chunk)
    }
  }
}

let pipedBuf = ''
const pipedLines = []
const pipedResolvers = []
let pipedListening = false
function pipedReadLine() {
  process.stdin.resume()
  if (!pipedListening) {
    pipedListening = true
    process.stdin.on('data', chunk => {
      pipedBuf += chunk.toString()
      let idx
      while ((idx = pipedBuf.indexOf('\n')) !== -1) {
        pipedLines.push(pipedBuf.slice(0, idx).replace(/\r$/, ''))
        pipedBuf = pipedBuf.slice(idx + 1)
      }
      while (pipedLines.length > 0 && pipedResolvers.length > 0) {
        pipedResolvers.shift()(pipedLines.shift())
      }
    })
  }
  if (pipedLines.length > 0) return Promise.resolve(pipedLines.shift())
  return new Promise(resolve => pipedResolvers.push(resolve))
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

async function markFlow(results, ctx) {
  const sha = gitSha()
  const interactive = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function'
  const readKey = interactive ? rawReadByte : pipedReadLine
  const readNote = interactive ? rawReadLine : pipedReadLine

  if (interactive) process.stdin.setRawMode(true)
  process.stdin.resume()

  console.log('\n--mark: k=keep  h=hard  b=bad  s=skip  q=quit\n')
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (!r.ok) continue
    console.log(renderItem(i + 1, ctx.mode, r, true))
    process.stdout.write('    > ')
    const key = (await readKey()).trim().toLowerCase()
    console.log(key)
    if (key === 'q') break
    if (key !== 'k' && key !== 'h' && key !== 'b') continue // skip / unrecognized
    let note = ''
    if (key === 'b') {
      process.stdout.write('    note: ')
      note = await readNote()
    }
    const verdict = key === 'k' ? 'keep' : key === 'h' ? 'hard' : 'bad'
    const entry = {
      sentence: r.item.sentence,
      verdict, note,
      prompt_id: ctx.promptKey,
      card: ctx.cardName,
      skill_type: ctx.skillType,
      git_sha: sha,
      timestamp: new Date().toISOString(),
    }
    appendFileSync(NOTES_PATH, JSON.stringify(entry) + '\n')
  }

  if (interactive) process.stdin.setRawMode(false)
  process.stdin.pause()
}

// ── --watch ──────────────────────────────────────────────────────────────────────────────────

async function watchFlow(ctx) {
  const promptPath = livePromptPath(ctx.promptKey)
  console.log(`\nwatching ${relativeToRepo(promptPath)} — edit and save to re-run. Ctrl+C to stop.`)
  let running = false
  let pending = false
  let timer = null
  const trigger = async () => {
    if (running) { pending = true; return }
    running = true
    do {
      pending = false
      ctx.promptContext.extraPrompt = readLivePrompt(ctx.promptKey) ?? ctx.promptContext.extraPrompt
      console.log('\n' + '─'.repeat(40))
      await runOnce(ctx)
    } while (pending)
    running = false
  }
  fsWatch(promptPath, () => {
    clearTimeout(timer)
    timer = setTimeout(trigger, 150)
  })
  await new Promise(() => {}) // keep the process alive
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.card) {
    if (args.compare) throw new Error('--compare requires --skill, not --card')
    await runCardMode(args)
    return
  }

  const resolved = await resolveSkillById(args.skill)

  if (args.compare) {
    await runCompare(args, resolved)
    return
  }

  const ctx = await buildSkillContext(args, resolved)
  const results = await runOnce(ctx)

  if (args.mark) await markFlow(results, ctx)
  if (args.watch) await watchFlow(ctx)
}

main().catch(e => {
  console.error(e.message)
  process.exit(1)
})
