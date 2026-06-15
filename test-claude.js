import 'dotenv/config'
import { createMessage } from './lib/claude.js'

const response = await createMessage([
  { role: 'user', content: 'Ich habe gestern den ganzen Tag gearbeitet.' },
])

console.log(JSON.stringify(response, null, 2))
