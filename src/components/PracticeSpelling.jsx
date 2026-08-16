import { useState, useEffect } from 'react'
import GermanText from './GermanText.jsx'

// Spelling exercise body. `item` is a practice.spelling response: { sentence, answer, meaning, translation }.
// No options — the learner types the exact answer (capitalization, umlauts, etc. all count), graded
// after trimming leading/trailing whitespace only.
export default function PracticeSpelling({ item, onWeiter, onAnswered, onExplain, onAddSource, addSourceDisabled, onEasierSentence, easierCount = 0, maxEasierAttempts = 0 }) {
  const [value, setValue] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [dontKnow, setDontKnow] = useState(false)
  const [showTranslation, setShowTranslation] = useState(false)
  const correct = !dontKnow && value.trim() === item.answer

  useEffect(() => { setValue(''); setRevealed(false); setDontKnow(false); setShowTranslation(false) }, [item])

  const [before, after] = item.sentence.split('___')

  function submit() {
    if (!value.trim() || revealed) return
    setRevealed(true)
    onAnswered?.(value.trim() === item.answer)
  }

  function giveUp() {
    setDontKnow(true)
    setRevealed(true)
    onAnswered?.(false)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-base leading-relaxed text-gray-800">
          <GermanText>{before}</GermanText>
          <span
            className={`inline-block mx-1 px-2 py-0.5 rounded border-b-2 font-medium ${
              !revealed
                ? 'border-gray-300 text-gray-400'
                : correct
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-red-500 text-red-700 bg-red-50'
            }`}
          >
            {revealed ? (dontKnow ? '?' : value.trim()) : '_____'}
          </span>
          <GermanText>{after}</GermanText>
        </p>

        <p className="mt-2 text-sm text-gray-500 italic">{item.meaning}</p>

        {!revealed && (
          <div className="mt-4 flex items-center gap-2">
            <input
              type="text"
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit() }}
              autoFocus
              placeholder="Type your answer…"
              className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-blue-400"
            />
            <button
              onClick={submit}
              disabled={!value.trim()}
              className="text-sm font-medium bg-blue-600 text-white rounded-lg px-3 py-2 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 transition-colors shrink-0"
            >
              Check
            </button>
          </div>
        )}

        {!revealed && (
          <button
            onClick={giveUp}
            className="mt-2 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            Don't know
          </button>
        )}

        {revealed && !correct && (
          <p className="mt-3 text-xs text-gray-500">
            Correct answer: <span className="font-medium text-gray-700">{item.answer}</span>
          </p>
        )}

        {showTranslation && (
          <p className="mt-3 text-sm text-gray-600 italic">{item.translation}</p>
        )}
      </div>

      <div className="border-t bg-white px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onExplain}
            disabled={!revealed}
            className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-0 transition-opacity"
          >
            Why?
          </button>
          <button
            onClick={() => setShowTranslation(v => !v)}
            className="text-xs text-gray-400 hover:text-gray-600 transition-opacity"
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
          {!revealed && easierCount < maxEasierAttempts && (
            <button
              onClick={onEasierSentence}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Easier sentence
            </button>
          )}
        </div>
        <button
          onClick={onWeiter}
          disabled={!revealed}
          className="text-sm font-medium bg-blue-600 text-white rounded-lg px-4 py-1.5 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  )
}
