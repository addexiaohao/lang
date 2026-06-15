import { supabase } from './supabaseAdmin.js'

export class AuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthError'
  }
}

export async function requireUser(req) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthError('Missing or malformed Authorization header')
  }
  const token = authHeader.slice(7)
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) {
    throw new AuthError('Invalid or expired session token')
  }
  return user
}

export async function requireProjectAccess(user_id, project_id) {
  const { data, error } = await supabase
    .from('projects')
    .select('id')
    .eq('id', project_id)
    .eq('user_id', user_id)
    .single()
  if (error || !data) {
    throw new AuthError('Project not found or access denied')
  }
}
