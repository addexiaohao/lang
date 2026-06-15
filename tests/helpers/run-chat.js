// Send a single-turn chat message to the local dev server and return the full response text.
// Requires: vercel dev (runs on :3000 by default)
//
// Required env vars (in .env):
//   VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY — Supabase project
//   SUPABASE_SECRET_KEY                              — service role key (generates token without password)
//   TEST_EMAIL                                       — account to authenticate as
//   TEST_PROJECT_ID                                  — set by each test file from TEST_PROJECT_ID_DE / TEST_PROJECT_ID_SV

import { createClient } from '@supabase/supabase-js'

let cachedToken = null

async function getToken() {
  if (cachedToken) return cachedToken

  const url = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  const serviceKey = process.env.SUPABASE_SECRET_KEY
  const email = process.env.TEST_EMAIL

  if (!url || !serviceKey || !email) {
    throw new Error('VITE_SUPABASE_URL, SUPABASE_SECRET_KEY, and TEST_EMAIL are required in .env')
  }

  // Admin client generates a magic link without sending email and without needing the password
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkError) throw new Error(`generateLink failed: ${linkError.message}`)

  // Exchange the OTP for a real session using the anon client
  const anon = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: sessionData, error: sessionError } = await anon.auth.verifyOtp({
    email,
    token: linkData.properties.email_otp,
    type: 'email',
  })
  if (sessionError) throw new Error(`verifyOtp failed: ${sessionError.message}`)

  cachedToken = sessionData.session.access_token
  return cachedToken
}

export async function runChat(input, { serverUrl = 'http://localhost:3000', projectId } = {}) {
  const token = await getToken()
  const project_id = projectId ?? process.env.TEST_PROJECT_ID
  if (!project_id) throw new Error('project_id required — set TEST_PROJECT_ID_DE / TEST_PROJECT_ID_SV in .env')

  const res = await fetch(`${serverUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ project_id, messages: [{ role: 'user', content: input }] }),
  })
  if (!res.ok) throw new Error(`Server responded ${res.status}`)
  return res.text()
}
