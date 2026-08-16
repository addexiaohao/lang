import { useState, useEffect } from 'react'
import GermanText from './GermanText.jsx'

// Exemplar feed exercise body. `item` is a practice.exemplar response: { sentence, target_span, translation }.
// Two outcomes: "Got it" (understanding counts as correct, fires onAnswered(true)) or "Don't
// understand" (fires onAnswered(false)). Either way the click just records the result and reveals
// "Next" — a second click advances via onNext.
// `onNochEinSatz` is still accepted and wired up in PracticePanel.jsx (same-card resentence
// prefetch/generation) but currently has no button calling it here — kept in place as a plain
// re-roll for a future use. `onEasierSentence` (TODO.md's "Make sentences easier") is the separate
// mechanism actually driving easier-vocabulary regeneration, shared with mc_cloze/spelling.
export default function PracticeExemplar({ item, onAnswered, onNext, onNochEinSatz, onExplain, onAddSource, addSourceDisabled, onEasierSentence, easierCount = 0, maxEasierAttempts = 0 }) {
  const [showTranslation, setShowTranslation] = useState(false)
  const [answered, setAnswered] = useState(false)
  useEffect(() => { setShowTranslation(false); setAnswered(false) }, [item])

  const positions = [{ start: item.target_span[0], end: item.target_span[1] }]

  function handleGotIt() {
    if (answered) {
      onNext?.()
      return
    }
    setAnswered(true)
    onAnswered?.(true)
  }

  function handleDontUnderstand() {
    if (answered) return
    setAnswered(true)
    onAnswered?.(false)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-base leading-relaxed text-gray-800">
          <GermanText positions={positions} highlightClassName="bg-transparent underline decoration-2 decoration-blue-500 font-semibold">
            {item.sentence}
          </GermanText>
        </p>

        {showTranslation && (
          <p className="mt-3 text-sm text-gray-600 italic">{item.translation}</p>
        )}
      </div>

      <div className="border-t bg-white px-4 py-3 flex items-center justify-between shrink-0 gap-2">
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={onExplain}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            Explain
          </button>
          <button
            onClick={() => setShowTranslation(v => !v)}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            {showTranslation ? 'Hide translation' : 'See translation'}
          </button>
          <button
            onClick={onAddSource}
            disabled={addSourceDisabled}
            title={addSourceDisabled ? 'Loading the generated context…' : undefined}
            className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Add source
          </button>
          {!answered && easierCount < maxEasierAttempts && (
            <button
              onClick={onEasierSentence}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Easier sentence
            </button>
          )}
        </div>
        <div className="flex gap-2 ml-auto shrink-0">
          {!answered && (
            <button
              onClick={handleDontUnderstand}
              className="text-sm font-medium border border-gray-300 text-gray-700 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
            >
              Don't understand
            </button>
          )}
          <button
            onClick={handleGotIt}
            className="text-sm font-medium bg-blue-600 text-white rounded-lg px-4 py-1.5 hover:bg-blue-700 transition-colors"
          >
            {answered ? 'Next' : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  )
}
