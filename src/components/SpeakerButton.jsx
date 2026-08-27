import { speak } from '../tts.js'

// Small icon button that speaks `text` on click. Stops propagation so it can be
// dropped inside a clickable row/button without also triggering that click.
export default function SpeakerButton({ text, lang, title = 'Speak', className = '' }) {
  if (!text) return null
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); speak(text, lang) }}
      title={title}
      className={`shrink-0 text-gray-400 hover:text-amber-600 transition-colors ${className}`}
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M10 3.75a.75.75 0 00-1.264-.546L4.703 7H3.167a.75.75 0 00-.7.48A6.985 6.985 0 002 10c0 .887.165 1.737.468 2.52.111.29.39.48.7.48h1.535l4.033 3.796A.75.75 0 0010 16.25V3.75zM15.95 5.05a.75.75 0 00-1.06 1.061 5.5 5.5 0 010 7.778.75.75 0 001.06 1.06 7 7 0 000-9.899zM13.829 7.172a.75.75 0 00-1.061 1.06 2.5 2.5 0 010 3.536.75.75 0 001.06 1.06 4 4 0 000-5.656z" />
      </svg>
    </button>
  )
}
