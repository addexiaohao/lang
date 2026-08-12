// Prompt regression tests — Swedish project. Calls the real Anthropic API directly with a fixed
// project fixture (tests/fixtures/projects.js) — no Supabase, no vercel dev server required.
//
// Philosophy:
//   - Format violations always fail (malformed JSON, missing required fields, bad enum/range).
//   - Content assertions are CONDITIONAL: if a card is present it must be correct,
//     but tests never fail because a card wasn't emitted — that's a judgment call.

import { makeAnthropic } from '../helpers/anthropic-client.js'
import { runPromptCases } from '../helpers/prompt-suite.js'
import { SWEDISH_PROJECT } from '../fixtures/projects.js'
import {
  findCards,
  mustHaveTags,
  mustBeKind,
  mustBeAbsent,
} from '../helpers/assert.js'

const cases = [
  {
    name: 'particle verb and compound noun',
    input: 'Jag slår upp ordet i ordlistan',
    assertions(blocks) {
      // slå upp is a particle verb — must not be tagged as a plain verb
      for (const card of findCards(blocks, /^slå upp$/i)) {
        mustHaveTags(card, ['particle-verb'])
      }

      // ord (word) is an ett-word
      for (const card of findCards(blocks, /^ord$/i)) {
        mustHaveTags(card, ['ett-word'])
        mustBeKind(card, 'vocabulary')
      }

      // ordlista is a compound — save the roots (ord, lista), not the compound itself
      mustBeAbsent(blocks, /^ordlista[n]?$/i, 'save the component roots (ord, lista) instead')
    },
  },

  {
    name: 'irregular verb skriva with ett-word noun',
    input: 'Hon skriver ett brev till sin kompis varje vecka',
    assertions(blocks) {
      // skriva: past = skrev (irregular), supine = skrivit (irregular)
      for (const card of findCards(blocks, /^skriva$/i)) {
        mustHaveTags(card, ['irregular-past', 'irregular-supine'])
      }

      // brev (letter) is an ett-word
      for (const card of findCards(blocks, /^brev$/i)) {
        mustHaveTags(card, ['ett-word'])
        mustBeKind(card, 'vocabulary')
      }

      // till used as a preposition toward a recipient/destination → grammar card
      for (const card of findCards(blocks, /^till\b/i)) {
        mustBeKind(card, 'grammar')
      }
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
await runPromptCases({ anthropic, project: SWEDISH_PROJECT, cases })
