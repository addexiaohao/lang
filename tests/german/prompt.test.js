// Prompt regression tests — German project.
// Requires the dev server with the German project active: vercel dev
//
// Philosophy:
//   - Format violations always fail (malformed JSON, missing required fields, bad enum/range).
//   - Content assertions are CONDITIONAL: if a card is present it must be correct,
//     but tests never fail because a card wasn't emitted — that's a judgment call.

import 'dotenv/config'
process.env.TEST_PROJECT_ID = process.env.TEST_PROJECT_ID_DE
import { runChat } from '../helpers/run-chat.js'
import { parseBlocks } from '../helpers/parse-blocks.js'
import {
  assertNoParseErrors,
  assertValidFormat,
  findCards,
  mustHaveTags,
  mustNotHaveTags,
  mustBeKind,
  mustBeAbsent,
  AssertionError,
} from '../helpers/assert.js'

const cases = [
  {
    name: 'Christmas holidays sentence',
    input: 'In den Weihnachtsferien zogen wir nach Florida',
    assertions(blocks) {
      // ziehen is a strong verb: irregular simple-past (zog) and past-participle (gezogen)
      for (const card of findCards(blocks, /^ziehen$/i)) {
        mustHaveTags(card, ['irregular-simple-past', 'irregular-past-participle'])
      }

      // Weihnachtsferien is plural-only — no gender tag
      for (const card of findCards(blocks, /weihnachtsferien/i)) {
        mustNotHaveTags(card, ['fem', 'masc', 'neut'])
      }

      // nach used as directional preposition → should be saved as a usage-pattern grammar card
      for (const card of findCards(blocks, /^nach\b/i)) {
        mustBeKind(card, 'grammar')
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
