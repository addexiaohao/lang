// Default tool executor for the chat prompt test suite — returns "nothing found" for every
// tool call, i.e. a deterministic fresh-session scenario (no pre-existing sources/cards/tables
// to deduplicate against). A test case can override this per-case (see prompt-suite.js) to
// exercise the dedup / link_card path with a fixed canned match instead.
export async function noopExecuteTool() {
  return []
}
