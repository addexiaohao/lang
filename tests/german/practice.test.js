// Practice-generation regression tests — German project. Calls the real Anthropic API directly
// with fixed card fixtures (tests/fixtures/cards.js) — no Supabase, no vercel dev server required.

import { makeAnthropic } from '../helpers/anthropic-client.js'
import { runPracticeSuite } from '../helpers/practice-suite.js'
import { GERMAN_PROJECT } from '../fixtures/projects.js'
import { GERMAN_GRAMMAR_CARD, GERMAN_VOCAB_CARD } from '../fixtures/cards.js'

const anthropic = makeAnthropic()
await runPracticeSuite({
  anthropic,
  ttsLocale: GERMAN_PROJECT.config.ttsLocale,
  grammarCard: GERMAN_GRAMMAR_CARD,
  vocabCard: GERMAN_VOCAB_CARD,
})
