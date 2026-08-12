import { useState, useEffect } from 'react'
import GermanText from './GermanText.jsx'

// MC cloze exercise body. `item` is a practice.mc_cloze response: { sentence, options, answer, sense_key, translation, option_meanings? }.
// option_meanings (one English gloss per option, vocabulary cards only) is revealed exactly when the translation is.
export default function PracticeMcCloze({ item, onWeiter, onExplain, onAddSource, addSourceDisabled }) {
  const [selected, setSelected] = useState(null)
  const [showTranslation, setShowTranslation] = useState(false)
  const revealed = selected !== null

  useEffect(() => { setSelected(null); setShowTranslation(false) }, [item])

  const [before, after] = item.sentence.split('___')

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-base leading-relaxed text-gray-800">
          <GermanText>{before}</GermanText>
          <span
            className={`inline-block mx-1 px-2 py-0.5 rounded border-b-2 font-medium ${
              !revealed
                ? 'border-gray-300 text-gray-400'
                : selected === item.answer
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-red-500 text-red-700 bg-red-50'
            }`}
          >
            {revealed ? selected : '_____'}
          </span>
          <GermanText>{after}</GermanText>
        </p>

        <div className="mt-5 space-y-2">
          {item.options.map((opt, i) => {
            const isChosen = opt === selected
            const isCorrect = opt === item.answer
            let cls = 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
            if (revealed && isCorrect) cls = 'border-green-500 bg-green-50 text-green-800'
            else if (revealed && isChosen) cls = 'border-red-500 bg-red-50 text-red-800'
            else if (revealed) cls = 'border-gray-200 opacity-50'
            return (
              <button
                key={opt}
                onClick={() => !revealed && setSelected(opt)}
                disabled={revealed}
                className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ${cls}`}
              >
                {opt}
                {showTranslation && item.option_meanings && (
                  <span className="block text-xs font-normal text-gray-400 mt-0.5">{item.option_meanings[i]}</span>
                )}
              </button>
            )
          })}
        </div>

        {revealed && selected !== item.answer && (
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
