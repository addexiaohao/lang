// Prompt regression tests — Swedish project.
// Requires the dev server with the Swedish project active: vercel dev
//
// Philosophy:
//   - Format violations always fail (malformed JSON, missing required fields, bad enum/range).
//   - Content assertions are CONDITIONAL: if a card is present it must be correct,
//     but tests never fail because a card wasn't emitted — that's a judgment call.

import 'dotenv/config'
process.env.TEST_PROJECT_ID = process.env.TEST_PROJECT_ID_SV
import { runChat } from '../helpers/run-chat.js'
import { parseBlocks } from '../helpers/parse-blocks.js'
import {
  assertNoParseErrors,
  assertValidFormat,
  findCards,
  mustHaveTags,
  mustBeKind,
  mustBeAbsent,
  AssertionError,
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

// ── Runner ────────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

for (const tc of cases) {
  process.stdout.write(`  ${tc.name} ... `)
  try {
    const text = await runChat(tc.input)
    const blocks = parseBlocks(text)
    assertNoParseErrors(blocks)
    assertValidFormat(blocks)
    tc.assertions(blocks)
    console.log('PASS')
    passed++
  } catch (e) {
    if (e instanceof AssertionError) {
      console.log(`FAIL\n    ${e.message}`)
      if (e.context) {
        const ctx = JSON.stringify(e.context, null, 2).replace(/\n/g, '\n      ')
        console.log(`      ${ctx}`)
      }
    } else {
      console.log(`ERROR\n    ${e.message}`)
    }
    failed++
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
