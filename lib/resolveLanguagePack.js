// Server-only: fetch a project's skill_type_def / drill_rule rows + config.language_meta and build
// a LanguagePack. Split out of lib/languagePack.js so that module stays isomorphic (the browser
// instantiates LanguagePack directly from GET /api/language-pack — see src/LanguagePackContext.jsx).

import { LanguagePack, LanguagePackError } from './languagePack.js'

// `client` defaults to the service-role client; scripts pass their own createClient() instance.
export async function resolveLanguagePack(projectId, { client } = {}) {
  if (!client) ({ supabase: client } = await import('./supabaseAdmin.js'))
  const [{ data: project }, { data: skillTypeRows, error: stErr }, { data: drillRuleRows, error: drErr }] =
    await Promise.all([
      client.from('projects').select('config').eq('id', projectId).single(),
      client.from('skill_type_def').select('*').eq('project_id', projectId),
      client.from('drill_rule').select('*').eq('project_id', projectId),
    ])
  if (stErr) throw new LanguagePackError(`skill_type_def fetch failed: ${stErr.message}`)
  if (drErr) throw new LanguagePackError(`drill_rule fetch failed: ${drErr.message}`)

  return new LanguagePack({
    skillTypes: skillTypeRows ?? [],
    drillRules: drillRuleRows ?? [],
    meta: project?.config?.language_meta ?? {},
  })
}
