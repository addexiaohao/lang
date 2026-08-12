// Prompt regression tests — German project. Calls the real Anthropic API directly with a fixed
// project fixture (tests/fixtures/projects.js) — no Supabase, no vercel dev server required.
//
// Philosophy:
//   - Format violations always fail (malformed JSON, missing required fields, bad enum/range).
//   - Content assertions are CONDITIONAL: if a card is present it must be correct,
//     but tests never fail because a card wasn't emitted — that's a judgment call.

import { makeAnthropic } from '../helpers/anthropic-client.js'
import { runPromptCases } from '../helpers/prompt-suite.js'
import { GERMAN_PROJECT } from '../fixtures/projects.js'
import {
  findCards,
  mustHaveTags,
  mustNotHaveTags,
  mustBeKind,
  mustBeAbsent,
} from '../helpers/assert.js'

// The real system_prompt (see fixtures/projects.js) splits every preposition into two cards:
// one vocabulary card for the bare lemma, and one grammar/"production" card per (lemma +
// use-case) pair, identified by a specific function tag — not by name, since production-card
// names are free text ("nach + place name"). Find by tag for that reason.
function findCardsByTag(blocks, tag) {
  return blocks
    .filter(b => b.type === 'knowledge_card' && b.parsed)
    .map(b => b.parsed)
    .filter(c => (c.tags ?? []).includes(tag))
}

const cases = [
  {
    name: 'Christmas holidays sentence',
    input: 'In den Weihnachtsferien zogen wir nach Florida',
    assertions(blocks) {
      // ziehen is a strong verb; the sentence only uses the simple-past form (zogen), so only
      // assert the tag for the form actually evidenced in the example — the model tags what it
      // sees in context, not a full irregularity paradigm pulled from general knowledge, and
      // that's the behavior we want (don't assert grammatical facts beyond the given text).
      for (const card of findCards(blocks, /^ziehen$/i)) {
        mustHaveTags(card, ['verb-irregular-simple-past'])
      }

      // Weihnachtsferien is plural-only — no gender tag
      for (const card of findCards(blocks, /weihnachtsferien/i)) {
        mustNotHaveTags(card, ['noun-feminine', 'noun-masculine', 'noun-neuter'])
      }

      // "nach" the bare lemma is a vocabulary card (system prompt's PREPOSITIONS rule 1)
      for (const card of findCards(blocks, /^nach$/i)) {
        mustBeKind(card, 'vocabulary')
        mustHaveTags(card, ['preposition'])
      }

      // "nach Florida" (destination) is a separate production/grammar card, found by its
      // function tag rather than its exact wording (system prompt's PREPOSITIONS rule 2)
      for (const card of findCardsByTag(blocks, 'production-which-preposition-destination')) {
        mustBeKind(card, 'grammar')
        mustHaveTags(card, ['production', 'production-which-preposition'])
      }

      // compound noun — only its roots (Weihnachten, Ferien) should be saved, not the compound itself
      mustBeAbsent(blocks, /^weihnachtsferien$/i, 'save the component roots instead')
    },
  },

  // Add more cases here. Template:
  //
  // {
  //   name: '...',
  //   input: '...',
  //   assertions(blocks) {
  //     for (const card of findCards(blocks, /pattern/i)) {
  //       mustHaveTags(card, [...])
  //       mustBeKind(card, 'vocabulary')
  //     }
  //   },
  // },
]

const anthropic = makeAnthropic()
await runPromptCases({ anthropic, project: GERMAN_PROJECT, cases })
