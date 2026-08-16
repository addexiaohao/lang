import { readFileSync } from 'fs';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

const { SUPABASE_ACCESS_TOKEN, VITE_SUPABASE_URL } = process.env;
if (!SUPABASE_ACCESS_TOKEN) {
  console.error('Missing SUPABASE_ACCESS_TOKEN in .env');
  console.error('Create one at https://supabase.com/dashboard/account/tokens');
  process.exit(1);
}

const reset = process.argv.includes('--reset');

const projectRef = new URL(VITE_SUPABASE_URL).hostname.split('.')[0];
const sql = readFileSync(resolve(__dirname, '../schema.sql'), 'utf8');

async function runQuery(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`API error ${res.status}: ${body}`);
    process.exit(1);
  }
}

// schema.sql itself is additive-only (create table if not exists, alter ... add column if not
// exists) — it can never destroy data. --reset is the explicit, opt-in way to wipe the
// reset-friendly tables (data that's regenerable from sources) before reapplying schema.sql, for
// the rare case where a shape change genuinely can't be expressed as an ALTER. Never run this
// against a database with cards you care about unless you mean it.
if (reset) {
  console.log('--reset: dropping knowledge_cards, source_knowledge, skill before reapplying schema.sql...');
  await runQuery(`
    drop table if exists skill;
    drop table if exists source_knowledge;
    drop table if exists knowledge_cards;
  `);
}

await runQuery(sql);

console.log(reset ? 'schema.sql applied successfully (with reset)' : 'schema.sql applied successfully');
