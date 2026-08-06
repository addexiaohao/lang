const CURLY_APOSTROPHES = /[‘’‚‛]/g
const CURLY_QUOTES = /[“”„‟«»]/g
const EDGE_CHARS = /^[\s'".,!?;:…\-–—]+|[\s'".,!?;:…\-–—]+$/g

export function normalizeSourceText(text) {
  if (typeof text !== 'string') return ''
  return text
    .normalize('NFC')
    .replace(CURLY_APOSTROPHES, "'")
    .replace(CURLY_QUOTES, '"')
    .toLowerCase()
    .replace(EDGE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function findDuplicateSource(candidates, queryText) {
  const key = normalizeSourceText(queryText)
  if (!key) return null
  return candidates.find(c => normalizeSourceText(c.original_text) === key) ?? null
}
