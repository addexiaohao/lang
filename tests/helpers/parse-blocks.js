// Parse save:source and save:knowledge_card fenced blocks out of a response string.
export function parseBlocks(text) {
  const blocks = []
  const regex = /```save:(source|knowledge_card)\n([\s\S]*?)```/g
  let match
  while ((match = regex.exec(text)) !== null) {
    const type = match[1]
    const raw = match[2].trim()
    let parsed = null
    let parseError = null
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      parseError = e.message
    }
    blocks.push({ type, raw, parsed, parseError })
  }
  return blocks
}
