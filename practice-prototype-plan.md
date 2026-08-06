# Practice Prototype — Build Plan

> **For a coding agent.** Read `CLAUDE.md` and `schema.sql` first and mirror the existing patterns for panels, API routes, and streaming. This document specifies *what* to build and in what order; it does not specify file paths or component names — follow whatever conventions already exist in the repo.

---

## Hard constraints

1. **No database changes.** No migrations, no new tables, no new columns, no writes to existing tables. Practice sessions are entirely ephemeral — they live in React state and are lost on reload. This is intentional.
2. **No changes to existing chat behavior.** Phase 1 refactors how the chat prompt is assembled. The assembled output must be byte-identical to what it is today.
3. **Two exercise types only.** Anything not listed under "Scope" is out of scope, including things that seem like obvious next steps.

## Non-goals (do not build, do not scaffold for)

- Scheduling, spacing, due dates, "last practiced"
- Skill or importance updates from practice results
- Session persistence or history
- Passages, tile reconstruction, error-spotting, free-text production
- Automatic routing of a card to an exercise type — the user picks the mode
- Batched or pre-generated items — generate live
- Table/paradigm cells in practice

---

## Scope

Two exercise types, both generated live by Claude, both one-tap.

### A. MC cloze (for grammar cards)

A novel German sentence with one blank, 3–4 options, one correct. Instant feedback: correct option marked, chosen-if-wrong marked. A "Why?" button hands off to the chat panel. A "Next" button advances.

### B. Exemplar feed (for vocabulary cards)

A novel German sentence using the target word, where the word is load-bearing for the meaning. Two buttons: **Verstanden** (advance to the next card) and **Noch ein Satz** (generate another sentence for the *same* card, more constraining than the last). A demoted "Erklären" button hands off to chat.

---

## Phase 1 — Prompt registry (refactor, no behavior change)

**Goal.** Move from one implicit prompt to a registry that can hold several, without changing what the chat prompt produces.

**Build.**

- A prompt registry module: prompts identified by string id (`chat.distill`, and later `practice.mc_cloze`, `practice.exemplar`), each with a version string.
- A **fragment** mechanism so shared context is written once. At minimum these fragments, extracted from the existing chat prompt:
  - `lang.project` — project identity, target language, TTS locale, anything language-specific
  - `taxonomy.cards` — card kinds and what each means
  - `tags.catalog` — the canonical function tag catalog
- A `compose(promptId, context)` function that assembles fragments + task-specific body + the project's user-editable layer (which continues to come from the DB for `chat.distill` only).
- Practice prompts are **code-only** — they have no user-editable layer, since that would require a DB change. Structure the registry so adding one later is a data change, not a refactor.

**Acceptance.** A test asserts that `compose('chat.distill', ctx)` produces exactly the string the current code produces for the same context. Existing chat behavior, save blocks, and the CLI regression harness all pass unchanged.

**Do not.** Change prompt wording. Change the DB-backed prompt editor or its history. Add a UI for the registry.

---

## Phase 2 — Practice generation endpoint

**Goal.** One API route that takes a card and a mode and returns a validated item.

**Build.**

- Route accepting: `cardId`, `mode` (`mc_cloze` | `exemplar`), and `avoid` — an array of short strings describing contexts already used for this card **in the current session only** (client-supplied, since nothing is persisted).
- Server loads the card, its tags, and its linked source excerpts, and composes the appropriate prompt.
- Response is JSON, not streamed. Validate against a schema before returning.
- On validation failure: retry once with the validation error appended to the prompt. On second failure, return a structured error the UI can show as "couldn't generate — skip or retry."

**Output contracts.**

```jsonc
// practice.mc_cloze
{
  "sentence": "Sie legte das Buch an ___ Rand des Tisches.",  // exactly one "___"
  "options": ["den", "dem", "der", "das"],                     // 3-4, unique
  "answer": "den",                                             // must be in options
  "sense_key": "motion.physical.place"                         // short slug, for the avoid list
}
```

```jsonc
// practice.exemplar
{
  "sentence": "Erst als sie den Brief öffnete, spürte sie, wie sehr ihre Hände zitterten.",
  "target_span": [42, 48],   // char offsets of the target word as inflected, for underlining
  "sense_key": "perception.physical"
}
```

**Prompt requirements to encode.**

- *Both:* the sentence must be novel, natural, and complex enough that context supports comprehension — not a textbook stub. Seed in other cards from the project where natural. Do not use a sentence from the card's own sources verbatim.
- *mc_cloze:* distractors must be genuinely plausible in the frame — a distractor that is ungrammatical for reasons unrelated to the target card is a failure. Each request should exercise a different `sense_key` from those in `avoid`.
- *exemplar:* the target word must be **load-bearing** — if it were removed or swapped for a plausible alternative, the sentence should become false, odd, or ambiguous. State this test in the prompt explicitly. When `avoid` is non-empty (user tapped "Noch ein Satz"), the new sentence must be **more constraining** than the previous ones — narrower context, fewer possible readings.

**Acceptance.** Manual curl against a grammar card and a vocab card returns schema-valid JSON. Malformed model output triggers exactly one retry.

---

## Phase 3 — Card selection

**Goal.** Get from the existing Cards panel into a practice session.

**Build.**

- Multi-select in the Cards panel: a checkbox per card, plus select-all-filtered.
- A footer bar appearing when ≥1 card is selected: count, a mode toggle (Cloze / Beispiele), and a "Üben" button.
- Selection is ephemeral, cleared on panel close.

**Do not.** Auto-pick the mode from card kind. Restrict which cards can go into which mode — let the user do something odd if they want; that is useful signal.

---

## Phase 4 — Practice panel

**Goal.** A new side panel in the existing multi-panel workspace that runs the session.

**Build.**

- Panel opens with the selected cards as a queue, generating item 1 immediately.
- **Shared shell** for both modes: header strip (card name, progress `n / total`), body region, action row. The hand-off button always sits in the same corner. Adding a third mode later should mean a new body component only.
- **MC cloze body:** sentence with a visible blank, options as tappable rows, on tap reveal correct/incorrect state, then a "Weiter" button.
- **Exemplar body:** sentence with the target span underlined, two buttons. "Noch ein Satz" appends the previous `sense_key` to `avoid` and requests a new item for the same card. Track how many sentences the user needed per card in local state and show it as small dots in the header.
- **Prefetch:** while the user looks at item *n*, request item *n+1* in the background. This is the whole latency strategy — do not add spinners between items if prefetch is working.
- Reuse existing TTS: clicking any German word in a practice sentence speaks it.
- End-of-session screen: cards covered, and a "wieder üben" button that restarts with the same selection. No stats, no score.

**Do not.** Persist anything. Add a results summary that implies scoring.

---

## Phase 5 — Agent hand-off

**Goal.** The "Why?" / "Erklären" button opens the chat panel with the question pre-filled and the context attached.

**Build.**

- Clicking hands the chat panel a pre-composed user message containing the sentence, the options and the user's answer (cloze) or the sentence and target word (exemplar), and the card name.
- The practice panel stays open and holds its state — the user reads the answer and returns to the same item.
- No new prompt: this goes through the existing chat prompt. If the explanation triggers a save block, that is fine and existing save behavior applies.

**Acceptance.** Clicking the button mid-session, asking a follow-up, and returning to practice leaves the session exactly where it was.

---

## Phase 6 — Tests

**Build.**

- Extend the CLI regression harness to cover the two new prompt ids, keyed by prompt id (the harness is currently keyed to the single chat prompt — generalize it).
- Checks per generated item, beyond schema validity:
  - cloze: exactly one blank; `answer` ∈ `options`; options unique; no option makes the sentence ungrammatical for an unrelated reason
  - exemplar: `target_span` actually resolves to an inflected form of the card's lemma
  - both: sentence is not a verbatim source excerpt for that card
  - across a run of 6 requests with accumulating `avoid`: at least 4 distinct `sense_key`s
- Golden-file test from Phase 1 (composed chat prompt unchanged) runs in CI alongside these.

---

## Decisions left to the human

These came up during design and are deliberately unresolved. Do not resolve them in code — pick the simplest behavior and flag it.

1. Whether "Noch ein Satz" should cap out (e.g. after 4 sentences, offer the explanation more prominently).
2. Whether a card the user got wrong should reappear later in the same session.
3. Whether the mode toggle should be per-session (current plan) or per-card.

---

## Suggested commit sequence

1. Prompt registry + fragments + golden-file test *(no behavior change)*
2. Generation endpoint + schemas + retry
3. Cards panel multi-select + footer
4. Practice panel shell + MC cloze body
5. Exemplar body + prefetch
6. Chat hand-off
7. Harness generalization + item checks

Each of 1–6 should be independently shippable and independently revertible.
