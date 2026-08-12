// Chat prompt regression runner — shared by tests/german/prompt.test.js and
// tests/swedish/prompt.test.js. Composes chat.distill from a fixture project (no Supabase), then
// drives the real tool-call loop (lib/chatLoop.js) against the real Anthropic API. Each case may
// supply its own executeTool to simulate a dedup match; otherwise defaults to "nothing found".

import { compose } from '../../lib/prompts/registry.js'
import { runChatLoop, CHAT_MODEL } from '../../lib/chatLoop.js'
import { noopExecuteTool } from './fixture-tools.js'
import { parseBlocks } from './parse-blocks.js'
import { assertNoParseErrors, assertValidFormat, AssertionError } from './assert.js'

export async function runPromptCases({ anthropic, project, cases }) {
  const systemPrompt = compose('chat.distill', { config: project.config, userPrompt: project.userPrompt, tags: project.tags })

  let passed = 0
  let failed = 0

  for (const tc of cases) {
    process.stdout.write(`  ${tc.name} ... `)
    try {
      const { text } = await runChatLoop({
        anthropic,
        model: CHAT_MODEL,
        systemPrompt,
        messages: [{ role: 'user', content: tc.input }],
        executeTool: tc.executeTool ?? noopExecuteTool,
      })
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
  if (failed > 0) process.exitCode = 1
}
