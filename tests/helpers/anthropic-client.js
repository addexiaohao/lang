import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'

export function makeAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY required in .env')
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}
