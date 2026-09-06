import { useState, useEffect } from 'react'
import GermanText from './GermanText.jsx'
import SpeakerButton from './SpeakerButton.jsx'
import AddNoteButton from './AddNoteButton.jsx'
import { speak } from '../tts.js'
import { useProject } from '../ProjectContext.jsx'
import { getProjectConfig } from '../../lib/projectConfig.js'

// MC cloze exercise body. `item` is a practice.mc_cloze response: { sentence, options, answer, translation, option_meanings?, revealTranslation? }.
// option_meanings (one English gloss per option) is revealed exactly when the translation is (the
// "See translation" toggle below) — unchanged for every item.
//
// revealTranslation items (production-which-preposition/conjunction — see PracticePanel.jsx) test
// PRODUCING the right word for a stated meaning, so `translation` is ALSO always shown up front,
// independent of the toggle — everything else (the toggle, option_meanings) behaves exactly as for
// any other item, including showing the same translation a second time if "See translation" is
// pressed.
export default function PracticeMcCloze({ item, onWeiter, onAnswered, onExplain, onAddSource, addSourceDisabled, onEasierSentence, easierCount = 0, maxEasierAttempts = 0, onAddNote }) {
  const { activeProject } = useProject()
  const { ttsLocale } = getProjectConfig(activeProject ?? {})
  const [selected, setSelected] = useState(null)
  const [dontKnow, setDontKnow] = useState(false)
  const [showTranslation, setShowTranslation] = useState(false)
  const revealed = selected !== null || dontKnow
  const correct = selected === item.answer

  useEffect(() => { setSelected(null); setDontKnow(false); setShowTranslation(false) }, [item])

  const [before, after] = item.sentence.split('___')

  function choose(opt) {
    if (revealed) return
    setSelected(opt)
    onAnswered?.(opt === item.answer)
  }

  function giveUp() {
    setDontKnow(true)
    onAnswered?.(false)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4">
        {item.revealTranslation && (
          <p className="mb-3 text-sm text-gray-600 italic">Meaning to produce: "{item.translation}"</p>
        )}
        <p className="text-base leading-relaxed text-gray-800">
          <GermanText>{before}</GermanText>
          <span
            onClick={() => { if (revealed && !dontKnow) speak(selected, ttsLocale) }}
            title={revealed && !dontKnow ? `Speak: "${selected}"` : undefined}
            className={`inline-block mx-1 px-2 py-0.5 rounded border-b-2 font-medium ${
              !revealed
                ? 'border-gray-300 text-gray-400'
                : correct
                  ? 'border-green-500 text-green-700 bg-green-50 cursor-pointer'
                  : 'border-red-500 text-red-700 bg-red-50 cursor-pointer'
            }`}
          >
            {revealed ? (dontKnow ? '?' : selected) : '_____'}
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
              <div key={opt} className="flex items-center gap-1.5">
                <button
                  onClick={() => choose(opt)}
                  disabled={revealed}
                  className={`flex-1 min-w-0 text-left px-3 py-2 rounded-lg border text-sm transition-colors ${cls}`}
                >
                  {opt}
                  {showTranslation && item.option_meanings && (
                    <span className="block text-xs font-normal text-gray-400 mt-0.5">{item.option_meanings[i]}</span>
                  )}
                </button>
                <SpeakerButton text={opt} lang={ttsLocale} />
              </div>
            )
          })}
        </div>

        {!revealed && (
          <button
            onClick={giveUp}
            className="mt-2 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            Don't know
          </button>
        )}

        {revealed && selected !== item.answer && (
          <p className="mt-3 text-xs text-gray-500 flex items-center gap-1">
            Correct answer: <span className="font-medium text-gray-700">{item.answer}</span>
            <SpeakerButton text={item.answer} lang={ttsLocale} />
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
            Ask
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
          {onAddNote && <AddNoteButton onSave={onAddNote} />}
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
