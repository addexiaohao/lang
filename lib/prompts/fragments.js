// Shared prompt fragments — written once, composed into multiple prompts by lib/prompts/registry.js.

// Project/language identity: context requirement + inline TTS tagging conventions.
export function langProject(config) {
  const { ttsLocale, contextsRequired } = config
  const sections = []

  if (contextsRequired) {
    sections.push(`## Context\nEach source represents text encountered in a specific context (e.g. a TV show episode, a book chapter, a conversation partner). The user selects the context for each source card before it can be saved.`)
  }

  if (ttsLocale) {
    const langTag = ttsLocale.split('-')[0]
    sections.push(`## Inline target-language text\n\nWhenever you write a target-language word or phrase in your prose (NOT inside save blocks), wrap it in <${langTag}>…</${langTag}> tags so the user can click each word to hear pronunciation.\n\nDo NOT use <${langTag}> tags inside save blocks — only in prose.`)
    sections.push(noScaffolding(languageName(ttsLocale)))
  }

  return sections.join('\n\n')
}

// Keeps generated/quoted target-language text free of English meta-commentary or padding.
export function noScaffolding(lang) {
  if (!lang) return ''
  return `## No English scaffolding\n\n${lang} text you write — inline prose spans, quoted sentences, save-block fields — must be pure ${lang}: no English preambles ("Here's a sentence for you:"), no meta-commentary, no bracketed translations unless the schema explicitly asks for them.`
}

// Card kinds and what each means.
export function taxonomyCards() {
  return `\
## Kind values

- **vocabulary** — any single word or lemma
- **grammar** — a productive pattern (e.g. "Perfekt with haben")
- **expression** — fixed chunk learned whole; \`details: { register }\`

Do NOT use \`save:knowledge_card\` for paradigm tables — see the **Tables** section below.`
}

// The canonical function-tag catalog, rendered for a project's current tags.
export function tagsCatalog(tags) {
  const tagNames = tags.length > 0 ? tags.map(t => t.name).join(', ') : '(none yet)'
  return `## Tag catalog\n\nExisting tags — use these verbatim, exact spelling. Do NOT invent variations (e.g. if the catalog has \`verb-irregular\`, do not use \`irregular\`):\n\n${tagNames}\n\nIf you need tags not listed above, you MUST declare them in a \`save:proposed_tags\` block at the **very beginning** of your response, before any prose:\n\n\`\`\`save:proposed_tags\n["new-tag-1", "new-tag-2"]\n\`\`\`\n\nThen use those names in \`tags\` arrays normally. Omit the block if all tags you need are already in the catalog.`
}

// Human-readable language name derived from a project's tts_locale (e.g. "de-DE" -> "German").
// Returns null if no locale is set.
export function languageName(ttsLocale) {
  if (!ttsLocale) return null
  const langCode = ttsLocale.split('-')[0]
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(langCode)
  } catch {
    return langCode
  }
}
