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

const projectRef = new URL(VITE_SUPABASE_URL).hostname.split('.')[0];
const sql = readFileSync(resolve(__dirname, '../schema.sql'), 'utf8');

const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${SUPABASE_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: sql }),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`API error ${res.status}: ${body}`);
  process.exit(1);
}

console.log('schema.sql applied successfully');
