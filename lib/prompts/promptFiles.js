// Prompt Iteration Harness's on-disk prompt staging area — see plan.md §6. The addressable unit is
// one (skillType, problemType) combo from lib/practiceRules.js's SKILL_PROBLEM_TYPES — each gets a
// directory prompts/<promptKey>/ holding prompt.md (the live extraPrompt text — kept in sync BY
// HAND with the corresponding row's `prompt` field in practiceRules.js when a change is accepted;
// this file is the diffable, editable staging copy, not itself read by the running app), drafts/
// (gitignored scratch, compared via `prompt:run --compare`), and NOTES.md (what was tried and
// rejected, and why).
//
// Only scripts/prompt-run.js reads these files. api/practice.js and lib/practiceRules.js are
// unaffected — accepting a prompt change still means hand-editing SKILL_PROBLEM_TYPES and bumping
// the relevant registry.js version string, same as before this tool existed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../..')
const PROMPTS_ROOT = resolve(REPO_ROOT, 'prompts')

export function promptKeyFor(skillType, problemType) {
  return `practice.${problemType}.${skillType}`
}

function promptDir(promptKey) {
  return resolve(PROMPTS_ROOT, promptKey)
}

export function livePromptPath(promptKey) {
  return resolve(promptDir(promptKey), 'prompt.md')
}

export function relativeToRepo(path) {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length + 1) : path
}

// Creates prompts/<promptKey>/{prompt.md, drafts/, NOTES.md} the first time this prompt is run
// through the harness, seeding prompt.md from whatever extraPrompt is currently hardcoded in
// lib/practiceRules.js — so there's always a live file to read/edit/diff from the very first run.
// No-op (does not overwrite) if prompt.md already exists.
export function ensurePromptFiles(promptKey, currentExtraPrompt) {
  const dir = promptDir(promptKey)
  const promptPath = livePromptPath(promptKey)
  let seeded = false
  if (!existsSync(promptPath)) {
    mkdirSync(resolve(dir, 'drafts'), { recursive: true })
    writeFileSync(promptPath, (currentExtraPrompt ?? '').trim() + '\n')
    const notesPath = resolve(dir, 'NOTES.md')
    if (!existsSync(notesPath)) writeFileSync(notesPath, `# ${promptKey}\n\nWhat was tried and rejected, and why.\n`)
    seeded = true
  }
  return { dir, promptPath, seeded }
}

export function readLivePrompt(promptKey) {
  const p = livePromptPath(promptKey)
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null
}

// Resolves a --compare version spec to prompt text:
//   'live'        -> prompts/<promptKey>/prompt.md
//   a relative path (e.g. "drafts/a") -> that path under the prompt's own directory, ".md" implied
//   anything else -> tried as a git ref against the live path (`git show <ref>:prompts/<key>/prompt.md`)
export function resolveVersionSpec(promptKey, spec) {
  if (spec === 'live') {
    const text = readLivePrompt(promptKey)
    if (text == null) throw new Error(`No live prompt.md for ${promptKey} yet — run prompt:run --skill once first.`)
    return { label: 'live', text }
  }
  const dir = promptDir(promptKey)
  const asPath = resolve(dir, spec.endsWith('.md') ? spec : `${spec}.md`)
  if (existsSync(asPath)) {
    return { label: spec, text: readFileSync(asPath, 'utf8').trim() }
  }
  try {
    const relPath = `prompts/${promptKey}/prompt.md`
    const text = execFileSync('git', ['show', `${spec}:${relPath}`], { cwd: REPO_ROOT, encoding: 'utf8' })
    return { label: spec, text: text.trim() }
  } catch {
    throw new Error(`Could not resolve prompt version "${spec}" as a draft path under prompts/${promptKey}/ or as a git ref`)
  }
}
