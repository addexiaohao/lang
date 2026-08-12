// Practice-generation regression suite — shared by tests/german/practice.test.js and
// tests/swedish/practice.test.js (only the fixture project/cards passed in differ). Calls
// generatePracticeItem() directly against the real Anthropic API, using fixed card/sentence data
// instead of a live Supabase-backed project — see tests/fixtures/cards.js.

import { generatePracticeItem } from '../../lib/practiceGenerate.js'
import { assertBaseItemValid, checkExemplarInflection } from './practice-assert.js'
import { AssertionError } from './assert.js'

export async function runPracticeSuite({ anthropic, ttsLocale, grammarCard, vocabCard }) {
  let passed = 0
  let failed = 0

  async function run(name, fn) {
    process.stdout.write(`  ${name} ... `)
    try {
      await fn()
      console.log('PASS')
      passed++
    } catch (e) {
      if (e instanceof AssertionError) {
        console.log(`FAIL\n    ${e.message}`)
        if (e.context) console.log(`      ${JSON.stringify(e.context, null, 2).replace(/\n/g, '\n      ')}`)
      } else {
        console.log(`ERROR\n    ${e.message}`)
      }
      failed++
    }
  }

  await run('mc_cloze: grammar card produces a valid item', async () => {
    const { card, seedCardNames } = grammarCard
    const item = await generatePracticeItem({
      anthropic, mode: 'mc_cloze',
      promptContext: { ttsLocale, card, avoid: [], seedCardNames },
    })
    assertBaseItemValid('mc_cloze', item, { cardKind: card.kind })
    // "no distractor is ungrammatical for an unrelated reason" is not checked here — see practice-assert.js header.
  })

  await run('mc_cloze: vocabulary card includes option_meanings', async () => {
    const { card, seedCardNames } = vocabCard
    const item = await generatePracticeItem({
      anthropic, mode: 'mc_cloze',
      promptContext: { ttsLocale, card, avoid: [], seedCardNames },
    })
    assertBaseItemValid('mc_cloze', item, { cardKind: card.kind })
  })

  await run('exemplar: vocabulary card produces a valid item', async () => {
    const { card, seedCardNames } = vocabCard
    const item = await generatePracticeItem({
      anthropic, mode: 'exemplar',
      promptContext: { ttsLocale, card, avoid: [], seedCardNames },
    })
    assertBaseItemValid('exemplar', item)
    const warning = checkExemplarInflection(item, card.name)
    if (warning) console.log(`\n    NOTE: ${warning}`)
  })

  await run('exemplar: sense_key diversity across 6 accumulating requests', async () => {
    const { card, seedCardNames } = vocabCard
    const senseKeys = []
    let avoid = []
    for (let i = 0; i < 6; i++) {
      const item = await generatePracticeItem({
        anthropic, mode: 'exemplar',
        promptContext: { ttsLocale, card, avoid, seedCardNames },
      })
      senseKeys.push(item.sense_key)
      avoid = [...avoid, item.sense_key]
    }
    const distinct = new Set(senseKeys).size
    if (distinct < 4) {
      throw new AssertionError(`expected at least 4 distinct sense_keys across 6 requests, got ${distinct}`, senseKeys)
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}
