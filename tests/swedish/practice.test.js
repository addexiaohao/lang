// Practice-generation regression tests — Swedish project. Calls the real Anthropic API directly
// with fixed card fixtures (tests/fixtures/cards.js) — no Supabase, no vercel dev server required.

import { makeAnthropic } from '../helpers/anthropic-client.js'
import { runPracticeSuite } from '../helpers/practice-suite.js'
import { SWEDISH_PROJECT } from '../fixtures/projects.js'
import { SWEDISH_GRAMMAR_CARD, SWEDISH_VOCAB_CARD } from '../fixtures/cards.js'

const anthropic = makeAnthropic()
await runPracticeSuite({
  anthropic,
  ttsLocale: SWEDISH_PROJECT.config.ttsLocale,
  grammarCard: SWEDISH_GRAMMAR_CARD,
  vocabCard: SWEDISH_VOCAB_CARD,
})
