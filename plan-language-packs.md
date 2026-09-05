# Language Packs — Build Plan

> **For a coding agent.** Move every language-specific decision out of code and into
> per-project, user-authored config. The core stays language-agnostic: entities (source /
> card / skill), the 1–10 scale + scheduling, and the fixed set of question *types*
> (mc_cloze / spelling / exemplar / discrimination_cloze) with their tool schemas,
> validators, and renderers. Everything about *a language* — which grammatical facets
> exist, which cards get them, how they gate, how each is drilled — becomes rows the user
> edits. Read `CLAUDE.md` and `schema.sql` first.

---

## The split

Three buckets. Only the middle one is new.

| Bucket | Examples | Lives in |
|---|---|---|
| **Core mechanism** | scale, level transitions, interval ladder, scheduling state machine, selection algorithm, the 4 question types + their tool schemas / validators / renderers, `compose()` assembly, sense/axis/gating *mechanisms*, entity schema | code, one copy, no language strings |
| **Language pack** (new) | which skill types exist, which cards get them (tag rules), gates, per-(skill, question type) prompt prose + weights + `require_frame`, sense-exempt word classes, vocabulary policy | `skill_type_def` + `drill_rule` rows, per project, user-editable |
| **User/project preference** | failure cap, cooldown, seed difficulty, enabled kinds, freeform `system_prompt` | `projects.config` (mostly already there) |

**Non-negotiable floor:** core guarantees one skill type, `meaning`, for `vocabulary` even
with zero pack rows — otherwise a half-configured project has nothing to practice and
substitution spins. The pack can override its label/gate/drills but not its existence.

**Two hops, always:** tag → skill type (`skill_type_def.applies_when`), skill type →
question type (`drill_rule`). Never wire a question type straight to a tag; the `skill` in
the middle is what carries a level, a schedule, and a history.

**What the user cannot reconfigure:** the entity schema, the 1–10 scale and its transition
table, the scheduling state machine + selection algorithm, and the *set* of question types
(a new one = tool schema + validator + renderer = code). They enable/disable/prompt the
existing four; they can't invent a fifth.

---

## 1. Schema (phase 1 — this commit)

Both tables `project_id`-scoped, additive (`create table if not exists`), sacred (hold
hand-authored config — never in the `--reset` drop set).

```sql
create table skill_type_def (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references projects(id) on delete cascade,
  key                text not null,        -- 'gender' — immutable once any skill row uses it
  kind               text not null check (kind in ('vocabulary','grammar','expression')),
  label              text not null,
  applies_when       jsonb,                -- null = always; else { any_tag?, all_tags?, not? } over card.tags + optional { kind }
  gate               jsonb,                -- null = ungated; else { requires, min_level, state }
  importance_default jsonb not null default '"inherit"',  -- "inherit" | <int 0-10>
  display_order      int not null default 0,
  created_at         timestamptz not null default now(),
  unique (project_id, kind, key)
);

create table drill_rule (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  kind           text not null check (kind in ('vocabulary','grammar','expression')),
  skill_type_key text not null,            -- → skill_type_def.key (same project + kind)
  question_type  text not null check (question_type in ('mc_cloze','spelling','exemplar','discrimination_cloze')),
  applies_when   jsonb,                    -- null = always; same shape as skill_type_def, tested against the CARD's tags
  priority       int  not null default 0,  -- highest matching rule wins for a (kind, skill_type, question_type)
  enabled        bool not null default true,
  weight_curve   text not null default 'flat' check (weight_curve in ('flat','rising','falling')),
  level_floor    smallint check (level_floor between 1 and 10),
  level_ceiling  smallint check (level_ceiling between 1 and 10),
  require_frame  bool not null default false,
  prompt         text not null default '',
  created_at     timestamptz not null default now()
);
create index on drill_rule (project_id, kind, skill_type_key);
```

### Field notes

- **`applies_when`** — tiny declarative matcher, no nesting, no expressions. Keys:
  `{ kind?: string, any_tag?: string[], all_tags?: string[], not?: { any_tag?, all_tags? } }`.
  On `skill_type_def` it decides which cards grow this skill row. On `drill_rule` it lets
  one `(skill_type, question_type)` pair carry several prompts chosen by card tags (this is
  how German's `production` keeps one skill type while the preposition / conjunction /
  plain variants each get their own prose + `require_frame`). Most rules have
  `applies_when: null`.
- **`weight_curve`** — named, not a closure (no `eval` of user input). `flat` → `1` at
  every level; `rising` → `level/10`; `falling` → `(11-level)/10`. `level_floor` /
  `level_ceiling` make the rule unselectable outside `[floor, ceiling]`. Every German seed
  rule is `flat` today — the level-shaped curves in the old code were hypothetical.
- **`require_frame`** — the toggle that replaces the three hardcoded
  `cardTags?.includes('production-which-preposition')` checks (tool schema description +
  `practiceRules.js` prompt branch + `practiceValidation.js` throw). When true, core
  injects the frame instruction into the prompt *and* `validatePracticeItem` enforces a
  non-empty `item.frame`. When false, neither. The user never hand-syncs prose to
  validator.
- **`importance_default`** — `"inherit"` = the card's own importance; an int = fixed.
  Replaces `DEFAULT_SKILL_IMPORTANCE`'s per-type formulas (all currently `inherit` or `2`).
- **`prompt`** — plain text with `{cardName}` / `{cardStem}` placeholders substituted by
  core. Starts as a forked template (see phase 3), never a blank box. The core
  `PROBLEM_TYPES[qt].task()` template still carries every *format* rule; `prompt` is
  additive pedagogical color only, so an empty prompt still yields a valid item.
- **Frozen keys** — `skill_type_def.key` is immutable in the editor once a `skill` row
  references it (show "in use — N skills"); `label` stays editable. Delete of an in-use
  type = soft-delete (stop deriving/drilling, keep history readable). Adding types is free.

### `discrimination_cloze`

Stays a pure core mechanism triggered by Card Group membership
(`api/practice.js`'s `pickDiscriminationGroup` → `buildDiscriminationRule`). No seed
`drill_rule` for it; a project *may* add one later to tune its prompt, but the default
needs none.

---

## 2. German seed (phase 1 — this commit)

`lib/languagePacks/germanSeed.js` — the current hardcoded config as pack data, extracted
verbatim:

| From (code) | To (seed) |
|---|---|
| `skillTypes.js` `SKILL_TYPES` | `skill_types[].{key,kind,label,display_order}` |
| `skillTypes.js` `VOCAB_TAG_RULES` + the unconditional grammar/expression lists | `skill_types[].applies_when` |
| `skillTypes.js` `SKILL_GATES` | `skill_types[].gate` |
| `skillTypes.js` `DEFAULT_SKILL_IMPORTANCE` | `skill_types[].importance_default` |
| `skillTypes.js` `SENSE_EXEMPT_TAGS` | `meta.sense_exempt_tags` |
| `practiceRules.js` `SKILL_PROBLEM_TYPES` (problemType, weight, prompt) | `drill_rules[]` |
| `practiceValidation.js` production-frame throws | `drill_rules[].require_frame` |
| `registry.js` `vocabularyPolicy()` | `meta.vocabulary_policy` |

`scripts/seed-language-pack.js --project <uuid> [--pack german] [--dry-run]` upserts the
rows. Idempotent on `(project_id, kind, key)` for skill types; `drill_rule` cleared +
reinserted per `(project, kind)` on re-run. Run it once against the real German project so
there is **no observable behavior difference** post-migration.

---

## 3. Core rewrite (phase 2 — next commit, needs phase 1 migrated first)

`lib/languagePack.js` — `resolveLanguagePack(projectId)`:
1. load `skill_type_def` + `drill_rule` rows,
2. merge the `meaning`/vocabulary floor if absent,
3. validate (every `drill_rule.question_type` is one of the four; every `gate.requires`
   resolves to a real key in the same kind; every enabled skill type has ≥1 enabled drill
   rule), throw loud on failure,
4. return `{ skillTypes, drillRules, meta, matchApplies(cardOrTags, appliesWhen) }`.

Make language-agnostic, each taking a resolved `pack`:

- `lib/skillTypes.js` → `deriveSkillTypes(card, pack)`, `deriveSkillImportance(card, type, pack)`,
  `isGateSatisfied(card, type, rows, pack)`, `validateSkillType(card, type, pack)`,
  `isSenseExempt(card, pack)`. **Delete** `SKILL_TYPES`, `VOCAB_TAG_RULES`,
  `DEFAULT_SKILL_IMPORTANCE`, `SKILL_GATES`, `SENSE_EXEMPT_TAGS`. Keep every
  paradigm/sense helper (`axisValueKey`, `resolveSkillType`, `skillDbColumns`,
  `hasSenseAxis`, … — those are core mechanism).
- `lib/practiceRules.js` → keep `PROBLEM_TYPES` (the four `task()` templates — core).
  Replace `SKILL_PROBLEM_TYPES` + `pickProblemType` + `getPracticeRule` +
  `resolvePracticeRule` + `practiceableSkillTypes` with lookups over `pack.drillRules`
  (filter by kind/skillType/`applies_when`/`enabled`/`level_floor..ceiling`, pick by
  `priority` then `weight_curve` sample). `buildDiscriminationRule` +
  `MAX_EASIER_SENTENCE_ATTEMPTS` stay.
- `lib/prompts/registry.js` → `vocabularyPolicy()` takes `meta.vocabulary_policy`;
  `skillSection()` already takes resolved text. Substitute `{cardName}`/`{cardStem}` in
  `extraPrompt` here.
- `lib/practiceValidation.js` → drop the two `production` + tag `frame` throws; add a
  single `if (requireFrame && !item.frame?.trim()) throw`. `requireFrame` comes in via
  `validationContext` from the resolved rule.
- `lib/practiceGenerate.js` → thread `requireFrame` into `validationContext`; the tool
  schema's `frame` property description becomes generic ("required iff this rule asks for
  it").

Call sites that must resolve + pass a pack: `api/save.js`, `api/knowledge-cards.js`
(single-card fetch, manual PATCH, practice_result PATCH), `api/skills.js` (browse/derive),
`api/practice.js`, `api/chat.js` (`search_knowledge_cards` sense-exempt check),
`scripts/backfill-skills.js`, `scripts/recompute-schedule.js`, `scripts/prompt-run.js`.

Tests: `tests/fixtures/languagePack.js` exports `GERMAN_PACK` (imports `germanSeed.js`) and
a placeholder `SWEDISH_PACK`; `tests/helpers/practice-suite.js` + `prompt-suite.js` pass it
into `compose()` / `generatePracticeItem()`. No Supabase dependency added — same isolation
`CLAUDE.md` mandates.

DB migration for existing rows: none. Seed keys (`meaning`, `gender`, `production`, …) are
byte-identical to today's `skill.type` values, so every existing `skill` /
`practice_attempt` row stays valid.

---

## 4. Read API + frontend read path (phase 3)

- `GET /api/language-pack?project_id=` → the resolved pack (skill types with labels +
  order, drill rules minus prompt text, meta). Cached client-side per project like
  `tagCatalog`.
- `SkillBadge.jsx` bar order, `CardDetailPanel.jsx` skill list labels, `SkillsPanel.jsx`
  `skill_type` filter options, `CardsPanel.jsx` — all read pack order/labels instead of a
  hardcoded import.

---

## 5. Edit UI (phase 4)

New Library sub-tab **Grammar** (next to Tags — they're two halves of one surface):

- **Skill types** — list by kind, `display_order` drag. Editor: `label`, `kind` (fixed
  after create), `applies_when` as "cards of kind [▾] with [all|any ▾] tags: [chip +]",
  `gate` as "after [skill ▾] reaches level [n] and is stable", `importance_default`.
  `key` shown, locked when in use.
- **Drill rules** — per skill type, a row per question type: enabled toggle, `weight_curve`
  + floor/ceiling, `require_frame` checkbox, `prompt` textarea with a "start from template"
  button (core ships a generic per-question-type template). `applies_when` on the rule
  behind an "only for cards tagged…" disclosure.
- Validation errors from `resolveLanguagePack` surfaced inline; save blocked while invalid.

---

## 6. Overrides / polish (phase 5)

- `projects.config.language_overrides` — optional sparse map merged over the pack at
  request time, for quick tweaks without editing rows. Ship without it; add if wanted.
- New-project flow: "seed grammar from template" (German / Swedish / blank) → runs the
  phase-2 seed logic client-visibly, rows owned by the user thereafter.
- `CLAUDE.md`: rewrite the "Skills" + "Practice generation" sections to describe the pack.

---

## Out of scope

- A fifth question type, or user-defined tool schemas.
- Cross-project / global packs (per-project only; templates are just seed data).
- Making `kind` (vocabulary/grammar/expression) configurable — fixed three.
- `applies_when` beyond the 3 operators — more precision = a more specific tag.
- Reworking scheduling constants into the pack (they're user-preference, → `projects.config`).

## Commit sequence

1. ✅ **Schema + German seed + seed script**. Additive; migrate + seed the real project;
   verify no behavior change.
2. ✅ **`lib/languagePack.js` + language-agnostic core.** `skillTypes.js` stripped to
   axis/sense/structural helpers; `practiceRules.js` keeps only `PROBLEM_TYPES` +
   `buildDiscriminationRule` + `MAX_EASIER_SENTENCE_ATTEMPTS`; `practiceValidation.js` frame
   check is now `requireFrame` from the rule; `registry.js` vocabulary policy comes from
   pack meta. Call sites updated: `api/practice.js`, `api/save.js`, `api/knowledge-cards.js`,
   `api/chat.js`, `api/skills.js`, `api/practice-attempt.js`, `api/practice-note.js`,
   `scripts/backfill-skills.js`, `scripts/prompt-run.js`. `lib/practiceSelection.js` takes an
   injected `isGateSatisfied`. Frontend `SKILL_TYPES` / `deriveFlatSkillTypes` moved to a
   temporary `src/legacySkillTaxonomy.js` shim (SkillBadge / SkillsPanel / CardDetailPanel) —
   deleted in phase 3. Behavior identical: the seeded pack == the old constants (verified).
   `projects.config.language_meta` (via the seed script) holds vocabulary policy +
   sense-exempt tags.
3. ✅ **Frontend read path.** `lib/languagePack.js` is now isomorphic (server-only
   `resolveLanguagePack` split into `lib/resolveLanguagePack.js`); `src/LanguagePackContext.jsx`
   fetches `GET /api/language-pack` for the active project and rebuilds the same
   `LanguagePack` class client-side. `SkillBadge` / `SkillsPanel` / `CardDetailPanel` read
   skill-type order + applicability from it; `src/legacySkillTaxonomy.js` deleted. The editor
   calls `refreshLanguagePack()` after every save so those views update without a reload.
4. ✅ **Edit UI.** `api/language-pack.js` (GET/POST/PATCH/DELETE over `skill_type_def` /
   `drill_rule` / `config.language_meta`; every skill_type/drill_rule write is validated by
   constructing the prospective `LanguagePack` in memory first — a gate pointing nowhere is
   refused with 400; `key`/`kind` frozen once referenced by a `skill` row → 409).
   `src/components/LanguagePackEditor.jsx` + a "Language pack" tab in `SettingsModal.jsx`,
   next to the system prompt: per-row inline editors for skill types (label, key, kind,
   applies-when tag rule, gate, default importance, order) and drill rules (question type,
   enabled, weight curve, level window, require-frame, applies-when, prompt), plus the
   vocabulary policy + sense-exempt tags. Per-row saves, no bulk diff.
5. Remaining: `projects.config.language_overrides` (optional sparse override map),
   "seed grammar from template" in the new-project flow, and the `CLAUDE.md` rewrite of the
   Skills / Practice-generation sections to describe the pack instead of the old constants.

**After migrating phase 1's schema, run `npm run seed:pack -- --project <de-uuid>` before
deploying phase 2** — until the rows exist, `resolveLanguagePack` returns only the `meaning`
floor and every other German skill type / drill disappears (and the editor shows an
almost-empty pack).
