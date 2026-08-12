// Item-level checks for generated practice items, beyond schema validity — see
// practice-prototype-plan.md Phase 6. Reuses the production validator (lib/practiceValidation.js)
// for the mechanical checks (exactly one blank, options unique, answer in options, target_span
// sanity) so the rules live in exactly one place; adds the checks that only make sense at test time.
//
// Explicitly NOT a hard failure here: "no distractor is ungrammatical for a reason unrelated to
// the target card" (cloze) requires linguistic judgment, not a mechanical check — and the
// target_span-is-an-inflection check (exemplar) is a string-similarity heuristic that cannot tell
// a suppletive form (German "sein" -> "ist"/"war"/"gewesen") from a genuinely unrelated word; no
// threshold accepts one without accepting the other. Per this repo's existing testing philosophy
// (tests/helpers/assert.js), content correctness that requires judgment is surfaced for a human
// to read, not hard-failed by the harness.

import { validatePracticeItem, PracticeValidationError } from '../../lib/practiceValidation.js'
import { AssertionError } from './assert.js'

export function assertBaseItemValid(mode, item, { cardKind } = {}) {
  try {
    validatePracticeItem(mode, item, { cardKind })
  } catch (e) {
    if (e instanceof PracticeValidationError) throw new AssertionError(e.message, item)
    throw e
  }
}

// Used for both German and Swedish test suites — folds the diacritics common to either.
function foldDiacritics(s) {
  return s.trim().toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/å/g, 'a').replace(/ß/g, 'ss')
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[a.length][b.length]
}

// Best-effort heuristic, not a real morphological analyzer — case/umlaut-folds both strings,
// then accepts an exact match, a substring match (handles most affixation), or a low edit-distance
// ratio (handles vowel-changing strong-verb/irregular forms). Loose on purpose: false negatives
// here are a real test failure, so it should only flag surface forms unrelated to the lemma.
export function looksLikeInflectionOf(surfaceForm, lemma) {
  const a = foldDiacritics(surfaceForm)
  const b = foldDiacritics(lemma)
  if (!a || !b) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  const ratio = levenshtein(a, b) / Math.max(a.length, b.length)
  return ratio <= 0.6
}

// Returns a warning string if the heuristic doesn't recognize the span as an inflection of
// lemma, or null if it does — never throws (see file header for why this can't be a hard check).
export function checkExemplarInflection(item, lemma) {
  const [start, end] = item.target_span
  const span = item.sentence.slice(start, end)
  if (looksLikeInflectionOf(span, lemma)) return null
  return `target_span "${span}" doesn't heuristically match lemma "${lemma}" — likely a suppletive/irregular form, verify by eye`
}
