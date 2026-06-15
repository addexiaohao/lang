// Swap this file to use a different TTS provider (e.g. cloud API, ElevenLabs).
// The rest of the app imports only `speak` and `cancel`.
const synth = typeof window !== 'undefined' ? window.speechSynthesis : null

export function speak(text, lang = 'de-DE') {
  if (!synth || !text.trim()) return
  synth.cancel()
  const utt = new SpeechSynthesisUtterance(text)
  utt.lang = lang
  synth.speak(utt)
}

export function cancel() {
  synth?.cancel()
}
