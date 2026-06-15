export function getProjectConfig(project) {
  const config = project.config ?? {}
  return {
    ttsLocale: config.tts_locale ?? 'de-DE',
    contextsRequired: config.contexts_required ?? true,
    cardKindsEnabled: config.card_kinds_enabled ?? ['vocabulary', 'grammar', 'expression', 'table'],
  }
}
