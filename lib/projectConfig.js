export function getProjectConfig(project) {
  const config = project.config ?? {}
  return {
    ttsLocale: project.tts_locale ?? null,
    contextsRequired: project.context_required ?? null,
    cardKindsEnabled: config.card_kinds_enabled ?? ['vocabulary', 'grammar', 'expression'],
  }
}
