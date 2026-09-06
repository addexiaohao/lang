-- schema.sql — single source of truth for the database
-- Run via `npm run migrate` (plain) to apply additively — safe, never touches existing data.
-- Run via `npm run migrate:reset` to additionally drop-and-recreate the reset-friendly tables
-- first (see below) — destructive, only for when a shape change genuinely can't be done as an
-- ALTER. This file itself no longer contains any unconditional `drop table` for real data; the
-- reset-only drops live in scripts/migrate.js's --reset path so plain `npm run migrate` (e.g. to
-- pick up a new column via the retroactive-additions section below) can never accidentally wipe
-- knowledge_cards/source_knowledge/skill again.
--
-- SACRED tables (sources, projects, contexts, tags): never drop, additive changes only.
-- RESET-FRIENDLY tables (knowledge_cards, source_knowledge, skill): data can be regenerated from
-- sources, so scripts/migrate.js --reset is allowed to drop and recreate them — but schema.sql
-- itself stays additive-only; a shape change here should go through the retroactive-additions
-- section (ALTER ... ADD COLUMN IF NOT EXISTS) rather than editing the CREATE TABLE below, unless
-- you are deliberately about to run --reset.

-- One-time cleanup: tables/table_cells/source_table_cells are retired — paradigms are now
-- knowledge_cards with details.axes, and per-cell skill lives in the skill table below. Safe to
-- leave in permanently: a no-op once these are gone from a given database.
drop table if exists source_table_cells;
drop table if exists table_cells;
drop table if exists tables;

-- mc_cloze_check retired in favor of mc_cloze_check_failure below — the original shape logged
-- every check attempt (pass and fail) with a per-option jsonb verdicts blob; it's replaced by a
-- failures-only table with plain sentence/reason columns. This table never held real user data
-- (audit trail only), so it's just dropped rather than migrated. Safe to leave in permanently: a
-- no-op once it's gone from a given database.
drop table if exists mc_cloze_check;

-- ── CREATE ────────────────────────────────────────────────────────────────────

create table if not exists projects (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  system_prompt   text,
  config          jsonb not null default '{}',
  tts_locale      text,
  context_required boolean not null default false,
  user_id         uuid references auth.users(id) on delete cascade,
  created_at      timestamptz not null default now()
);

create table if not exists contexts (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id),
  name        text not null,
  description text,
  created_at  timestamptz not null default now()
);

create table if not exists sources (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id),
  user_id       uuid references auth.users(id) on delete cascade,
  context_id    uuid references contexts(id) on delete restrict,  -- nullable; required when contexts_required is true
  original_text text not null,
  created_at    timestamptz not null default now()
);

create table if not exists knowledge_cards (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid references projects(id) on delete cascade,
  kind              text not null check (kind in ('vocabulary','grammar','expression')),
  name              text not null,
  details           jsonb,  -- may include "axes": [{name, values}] — ordered, present iff this card is a paradigm (see skill table below)
  tags              text[],
  related_card_ids  uuid[],
  importance        int check (importance between 0 and 10),
  created_at        timestamptz not null default now(),
  unique (project_id, name)
);

-- A skill is a claim about a card that can be assessed — a card is a "thing you encountered",
-- a skill is "how reliably you produce one facet of it". Flat cards (vocabulary/grammar/expression
-- without axes) get types from lib/skillTypes.js's SKILL_TYPES registry, eagerly at level = null
-- (never practiced — level 1 means "assessed, and assessed at the bottom of the scale", a real
-- claim, not a baseline). Paradigm cards (details.axes present) get dotted-path types, one
-- segment per axis, e.g. "akk.masc" — no row = that cell was never encountered. A row can still
-- have level = null (never practiced, or manually cleared via the editor), distinct from both
-- "never encountered" (no row) and a real level. `type` is free text validated in code
-- (lib/skillTypes.js's validateSkillType), not a Postgres enum, since new types will be added often.
create table if not exists skill (
  id             uuid primary key default gen_random_uuid(),
  card_id        uuid not null references knowledge_cards(id) on delete cascade,
  type           text not null,
  level          smallint check (level between 1 and 10),
  importance     smallint check (importance between 0 and 10),
  last_correct   timestamptz,  -- set only on a correct practice attempt, not on every attempt
  created_at     timestamptz not null default now(),
  unique (card_id, type)
);

-- ── LANGUAGE PACKS (see plan-language-packs.md) ──────────────────────────────
-- Per-project, user-authored config that used to be hardcoded German in lib/skillTypes.js
-- (SKILL_TYPES / VOCAB_TAG_RULES / SKILL_GATES / DEFAULT_SKILL_IMPORTANCE / SENSE_EXEMPT_TAGS)
-- and lib/practiceRules.js (SKILL_PROBLEM_TYPES). Core code stays language-agnostic and reads
-- these rows via lib/languagePack.js's resolveLanguagePack(). SACRED — hand-authored, never in
-- the --reset drop set. Seed an existing project from code with scripts/seed-language-pack.js so
-- there's no behavior change on rollout.

-- One row per assessable facet a card of a given kind can have (the thing that carries a level
-- and a schedule). `key` is what lands in skill.type — immutable in the editor once any skill
-- row uses it. applies_when decides which cards grow this skill row eagerly on save; null =
-- every card of `kind`. Core always guarantees a vocabulary `meaning` type even with zero rows.
create table if not exists skill_type_def (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references projects(id) on delete cascade,
  key                text not null,
  kind               text not null check (kind in ('vocabulary','grammar','expression')),
  label              text not null,
  applies_when       jsonb,   -- null = always; else { kind?, any_tag?:[], all_tags?:[], not?:{any_tag?,all_tags?} }
  gate               jsonb,   -- null = ungated; else { requires:text, min_level:int, state:text }
  importance_default jsonb not null default '"inherit"',  -- "inherit" | int 0-10
  display_order      int not null default 0,
  created_at         timestamptz not null default now(),
  unique (project_id, kind, key)
);

-- One row per (skill type, question type[, card-tag condition]) — how a facet gets drilled.
-- Replaces lib/practiceRules.js's SKILL_PROBLEM_TYPES. `prompt` is additive pedagogical prose
-- (plain text, {cardName}/{cardStem} placeholders); the core PROBLEM_TYPES[qt].task() template
-- still owns every FORMAT rule. weight_curve is a named curve, never user code. require_frame
-- toggles the frame instruction + validator together (was 3 hardcoded tag checks). applies_when
-- (tested against the card's tags) lets one (skill_type, question_type) carry several prompts;
-- highest `priority` among matching rules wins.
create table if not exists drill_rule (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  kind           text not null check (kind in ('vocabulary','grammar','expression')),
  skill_type_key text not null,
  question_type  text not null check (question_type in ('mc_cloze','spelling','exemplar','discrimination_cloze')),
  applies_when   jsonb,
  priority       int  not null default 0,
  enabled        bool not null default true,
  weight_curve   text not null default 'flat' check (weight_curve in ('flat','rising','falling')),
  level_floor    smallint check (level_floor between 1 and 10),
  level_ceiling  smallint check (level_ceiling between 1 and 10),
  require_frame  bool not null default false,
  prompt         text not null default '',
  created_at     timestamptz not null default now()
);
create index if not exists drill_rule_lookup on drill_rule (project_id, kind, skill_type_key);

-- Per-user settings: default project selection, etc.
create table if not exists user_settings (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  default_project_id uuid references projects(id) on delete set null,
  updated_at         timestamptz not null default now()
);

-- Tag catalog — curated vocabulary for knowledge_card tags.
-- knowledge_cards.tags is text[] (denormalized); this table is the canonical spelling source.
-- name: full identifier stored in knowledge_cards.tags (e.g. "verb-irregular-present")
-- display_name: short label shown in the UI (e.g. "irr-present")
create table if not exists tags (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  name         text not null,
  display_name text,
  description  text,
  created_at   timestamptz not null default now(),
  unique (project_id, name)
);

create table if not exists source_knowledge (
  source_id         uuid not null references sources(id),
  knowledge_card_id uuid not null references knowledge_cards(id),
  positions         jsonb not null,  -- [{start, end}] absolute char offsets into sources.original_text
  note              text,
  created_at        timestamptz not null default now(),
  primary key (source_id, knowledge_card_id)
);

-- One row per practice round (PracticePanel's right/wrong/don't-know via api/knowledge-cards.js's
-- practice_result path, or "too hard" via api/practice-attempt.js) — an append-only log alongside
-- skill's single last_correct pointer. A multi-round chain (the "Easier sentence" button, see
-- lib/practiceGenerate.js's `history` param) produces one row per round, all sharing one
-- encounter_id; each row's `conversation` is the full raw { request, response } actually used for
-- that round, so a later round's conversation already contains the earlier rounds' turns
-- (request.messages) — it's the whole thing up to that point, not a diff against earlier rows.
-- Reset-friendly, same as skill: regenerable in principle, but nothing currently regenerates it,
-- so treat existing rows as real history in practice.
create table if not exists practice_attempt (
  id           uuid primary key default gen_random_uuid(),
  skill_id     uuid not null references skill(id) on delete cascade,
  encounter_id uuid not null default gen_random_uuid(),  -- shared across rounds of the same "easier sentence" chain
  created_at   timestamptz not null default now(),
  outcome      text not null,   -- 'correct' | 'incorrect' | 'too_hard' (right/wrong/don't-know all collapse to
                                 -- 'correct'/'incorrect' at the PATCH /api/knowledge-cards layer — see api/practice-attempt.js)
  model        text,            -- the model that generated the practice item
  conversation jsonb            -- raw { request: {model,system,messages}, response } sent to/received from the LLM
);

-- One row per FAILED mc_cloze answer-uniqueness check (lib/mcClozeCheck.js) — a passing check
-- writes nothing here, so every row is a genuine problem worth looking at (a failed attempt that
-- lib/practiceGenerate.js then retried once, same as any other PracticeValidationError).
-- `offending_sentences`/`reasons` are PARALLEL arrays, one entry per problem sentence: the answer's
-- own sentence (if it was judged ungrammatical/nonsensical) and/or any distractor's sentence that
-- was wrongly judged BOTH grammatical and sensible. Each `reasons` entry is the checker's own verbatim
-- verdict text for that sentence — for the answer-failure case a real "what's wrong" explanation, for
-- a bad-distractor entry just its pass confirmation (e.g. "Correct.", since the checker itself saw
-- nothing wrong with it — that's exactly why it's flagged as too-fine-an-alternative rather than a
-- broken sentence). `sentence`/`options`/`answer` are the generated item's own fields, kept for
-- context. `conversation` is the full { model, system, messages } generation request that produced
-- the item (see the RETROACTIVE COLUMN ADDITIONS section). See lib/mcClozeCheck.js's
-- verifyMcClozeItem() for the exact derivation.
create table if not exists mc_cloze_check_failure (
  id                   uuid primary key default gen_random_uuid(),
  skill_id             uuid references skill(id) on delete cascade,  -- nullable: a substituted/never-assessed skill may not have a row yet
  card_id              uuid not null references knowledge_cards(id) on delete cascade,
  skill_type           text not null,
  model                text,     -- the small/cheap model used to judge each sentence
  sentence             text not null,   -- the cloze sentence with its "___" blank, as generated
  options              jsonb not null,
  answer               text not null,
  offending_sentences  text[] not null,
  reasons              text[] not null,
  created_at           timestamptz not null default now()
);


-- Per-lemma cache of the sense-checker verdict (plan.md — "Word Senses" §1): "does this word have
-- learner-relevant distinct senses at all" is a property of the language, not of any one encounter,
-- so it's asked once per (project, lemma) and never again. Reset-friendly in spirit (a stochastic
-- judgment, regenerable by asking again) but small/cheap enough to just live here rather than
-- through the reset-friendly-tables ceremony. lemma_norm is the same case-folded/trimmed form used
-- as the cache key, not necessarily the card's display name.
create table if not exists sense_check_cache (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  lemma_norm  text not null,
  verdict     text not null check (verdict in ('single', 'distinct', 'stretched')),
  reasoning   text,
  created_at  timestamptz not null default now(),
  unique (project_id, lemma_norm)
);

create index if not exists idx_sense_check_cache_project_id on sense_check_cache(project_id);

alter table sense_check_cache enable row level security;
drop policy if exists "anon full access" on sense_check_cache;

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table projects               enable row level security;
alter table sources                enable row level security;
alter table knowledge_cards        enable row level security;
alter table source_knowledge       enable row level security;
alter table contexts               enable row level security;
alter table tags                   enable row level security;
alter table user_settings          enable row level security;
alter table skill                  enable row level security;
alter table practice_attempt       enable row level security;
alter table mc_cloze_check_failure enable row level security;
alter table skill_type_def         enable row level security;
alter table drill_rule             enable row level security;
-- system_prompt_history RLS is enabled after the table is created below

-- Remove old open-access policies
drop policy if exists "anon full access" on projects;
drop policy if exists "anon full access" on sources;
drop policy if exists "anon full access" on knowledge_cards;
drop policy if exists "anon full access" on source_knowledge;
drop policy if exists "anon full access" on contexts;
drop policy if exists "anon full access" on tags;
drop policy if exists "anon full access" on user_settings;
drop policy if exists "anon full access" on skill;
drop policy if exists "anon full access" on practice_attempt;
drop policy if exists "anon full access" on mc_cloze_check_failure;
drop policy if exists "anon full access" on skill_type_def;
drop policy if exists "anon full access" on drill_rule;
-- system_prompt_history drop policy is applied after the table is created below

-- All data access goes through /api/* serverless functions using the service role key,
-- which bypasses RLS. No direct browser access to the DB is permitted.
-- (No permissive policies means all non-service-role access is denied.)


-- ── TAG CATALOG SEED ─────────────────────────────────────────────────────────
-- Safe to re-run; ON CONFLICT DO NOTHING is idempotent.
-- Tags are project-scoped. Run manually per project, substituting the real project uuid:
--   insert into tags (project_id, name, display_name) values ('<project-uuid>', 'noun', 'noun')
--   on conflict (project_id, name) do update set display_name = excluded.display_name;


-- ── SYSTEM PROMPT HISTORY ────────────────────────────────────────────────────

create table if not exists system_prompt_history (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  prompt      text not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_system_prompt_history_project_id on system_prompt_history(project_id);

alter table system_prompt_history  enable row level security;
drop policy if exists "anon full access" on system_prompt_history;

-- ── LLM API USAGE TRACKING ───────────────────────────────────────────────────
-- One row per LLM API call, across every call site in the app: api/chat.js's streaming turns
-- (including each tool-loop round), api/practice.js's item generation (+ its one retry, see
-- "Practice generation" in CLAUDE.md), lib/mcClozeCheck.js's per-option answer-uniqueness checks,
-- api/practice-explain.js's turns, lib/senseCheck.js's getSenseVerdict()/checkSense(), and
-- api/suggest-sense.js. Purely a cost/usage log — nothing else in the app reads from it, so losing
-- it doesn't corrupt any other data, but nothing currently regenerates it either, so treat existing
-- rows as real history, same spirit as practice_attempt.
--
-- purpose identifies the CALL SITE, not the questionType/skill_type a practice call happened to be
-- generating for (that's already on practice_attempt/mc_cloze_check_failure) — this table's job is
-- "how much did this app spend on Anthropic", sliceable by feature. card_id/skill_id are nullable,
-- best-effort links for call sites that have one (practice generation, mc_cloze checks, explain) —
-- null for call sites that don't (chat, sense_check, suggest_sense at the point of call). Anything
-- else call-site-specific (encounter_id, which skill_type was requested vs. substituted, a retry's
-- reason) goes in metadata rather than growing a nullable column per purpose.
--
-- on delete set null (not cascade) on every FK here, deliberately: a cost/usage record should
-- survive the project/card/skill it was about being deleted later — an audit trail, not derived
-- state — unlike e.g. skill's practice_attempt rows, which are meant to disappear with their skill.
create table if not exists llm_api_call (
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid references projects(id) on delete set null,
  user_id                     uuid references auth.users(id) on delete set null,
  purpose                     text not null check (purpose in (
                                 'chat', 'practice_generate', 'practice_retry', 'mc_cloze_check',
                                 'practice_explain', 'sense_check', 'suggest_sense'
                               )),
  model                       text not null,
  status                      text not null default 'success' check (status in ('success', 'error')),
  error_message               text,
  input_tokens                int,
  output_tokens               int,
  cache_creation_input_tokens int,          -- prompt-caching write (see CLAUDE.md's "Prompt caching")
  cache_read_input_tokens     int,          -- prompt-caching read
  stop_reason                 text,         -- e.g. 'end_turn' | 'tool_use' | 'max_tokens', null on error
  latency_ms                  int,
  cost_usd                    numeric(10,6), -- computed at write time from llm_model_pricing (below) —
                                              -- a snapshot, so later price changes never rewrite history
  request_id                  text,          -- Anthropic's anthropic-request-id response header
  card_id                     uuid references knowledge_cards(id) on delete set null,
  skill_id                    uuid references skill(id) on delete set null,
  metadata                    jsonb,         -- free-form call-specific context, e.g.
                                              -- {skill_type, encounter_id, retry_of, tool_calls}
  created_at                  timestamptz not null default now()
);

create index if not exists idx_llm_api_call_project_created on llm_api_call(project_id, created_at desc);
create index if not exists idx_llm_api_call_purpose         on llm_api_call(purpose);
create index if not exists idx_llm_api_call_model           on llm_api_call(model);
create index if not exists idx_llm_api_call_card_id         on llm_api_call(card_id);
create index if not exists idx_llm_api_call_skill_id        on llm_api_call(skill_id);

alter table llm_api_call enable row level security;
drop policy if exists "anon full access" on llm_api_call;

-- Per-model $/1M-token pricing, effective from a given date. Kept as data rather than a hardcoded
-- rate table in code so a price change (Anthropic repricing a model) doesn't require a deploy, and
-- so cost_usd on already-logged calls stays correct forever — the resolver (would-be
-- lib/llmPricing.js) picks the newest row with effective_from <= the call's time for the model
-- actually used, then that resulting number is written once onto llm_api_call.cost_usd, never
-- recomputed by joining at read time.
create table if not exists llm_model_pricing (
  id                           uuid primary key default gen_random_uuid(),
  model                        text not null,
  input_cost_per_million       numeric(10,4) not null,
  output_cost_per_million      numeric(10,4) not null,
  cache_write_cost_per_million numeric(10,4),
  cache_read_cost_per_million  numeric(10,4),
  effective_from               timestamptz not null default now(),
  created_at                   timestamptz not null default now(),
  unique (model, effective_from)
);

create index if not exists idx_llm_model_pricing_model on llm_model_pricing(model, effective_from desc);

alter table llm_model_pricing enable row level security;
drop policy if exists "anon full access" on llm_model_pricing;

-- Seed pricing for every model this app currently hardcodes — CHAT_MODEL (lib/chatLoop.js),
-- DEFAULT_PRACTICE_MODEL (lib/practiceGenerate.js), DEFAULT_CHECK_MODEL (lib/mcClozeCheck.js), and
-- DEFAULT_SENSE_CHECK_MODEL (lib/senseCheck.js) all resolve to claude-sonnet-4-6 today, and
-- PRACTICE_MODEL/PRACTICE_CHECK_MODEL default to the same when unset. Cache write/read rates use
-- Anthropic's standard multipliers (1.25x / 0.1x of the base input rate) since those aren't published
-- as separate flat per-model prices. effective_from is pinned (not now()) so re-running this
-- migration updates the same row via ON CONFLICT instead of inserting a new one on every deploy —
-- bump the date only for a real, dated price change. A PRACTICE_MODEL/PRACTICE_CHECK_MODEL override
-- pointing at a model with no row here just means lib/llmPricing.js's cost_usd comes back null for
-- those calls — token counts still log fine either way.
insert into llm_model_pricing (model, input_cost_per_million, output_cost_per_million, cache_write_cost_per_million, cache_read_cost_per_million, effective_from)
values ('claude-sonnet-4-6', 3.00, 15.00, 3.75, 0.30, '2026-01-01T00:00:00Z')
on conflict (model, effective_from) do update set
  input_cost_per_million       = excluded.input_cost_per_million,
  output_cost_per_million      = excluded.output_cost_per_million,
  cache_write_cost_per_million = excluded.cache_write_cost_per_million,
  cache_read_cost_per_million  = excluded.cache_read_cost_per_million;

-- ── PRACTICE NOTES ───────────────────────────────────────────────────────────
-- Dev/self-use only: a free-text scratch note attached to a practice question while practicing
-- (e.g. "this distractor is questionable", "I keep confusing this with X"). Not surfaced anywhere
-- in the UI beyond the button that writes it — just a durable place to park an observation for
-- later review. `question` is the raw generated item (same shape as
-- practice_attempt.conversation.response) so the note can be read back against exactly what was
-- on screen; `skill_id` ties it to the skill being drilled, same as practice_attempt.
create table if not exists practice_note (
  id         uuid primary key default gen_random_uuid(),
  skill_id   uuid not null references skill(id) on delete cascade,
  question   jsonb not null,
  note       text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_practice_note_skill_id on practice_note(skill_id);

alter table practice_note enable row level security;
drop policy if exists "anon full access" on practice_note;

-- ── CARD GROUPS ───────────────────────────────────────────────────────────────
-- plan.md — lets the user relate cards that only make sense against each other (wissen/kennen,
-- legen/stellen/setzen) so practice can generate discrimination items whose distractors are
-- guaranteed plausible (they're the OTHER group members, not model-invented). A group is a set of
-- cards, not pairwise edges — legen/stellen/setzen is one three-way relation, and edges would admit
-- inconsistent triangles (A-B, B-C, no A-C). Groups relate CARDS, not skills — item generation
-- resolves card -> skill at generation time (api/practice.js). A card may belong to several groups
-- (no uniqueness constraint on card_id alone), and groups are never merged/deduplicated — two
-- groups with identical members are allowed.
create table if not exists card_group (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text,     -- nullable; UI falls back to member names joined, e.g. "wissen · kennen"
  note        text,     -- the shared axis of comparison, e.g. "both mean 'to know'; the split is ..."
  created_at  timestamptz not null default now()
);

-- note: what is distinctive about THIS member specifically, e.g. "kennen — people, places, things
-- you have encountered." Both this and card_group.note are nullable/optional — when null, the
-- agent regenerates a serviceable explanation on demand rather than it being stored redundantly.
create table if not exists card_group_member (
  group_id    uuid not null references card_group(id) on delete cascade,
  card_id     uuid not null references knowledge_cards(id) on delete cascade,
  note        text,
  created_at  timestamptz not null default now(),
  primary key (group_id, card_id)
);

create index if not exists idx_card_group_project_id on card_group(project_id);
create index if not exists idx_card_group_member_card_id on card_group_member(card_id);

alter table card_group        enable row level security;
alter table card_group_member enable row level security;
drop policy if exists "anon full access" on card_group;
drop policy if exists "anon full access" on card_group_member;

-- ── INDEXES ───────────────────────────────────────────────────────────────────

create index if not exists idx_projects_user_id           on projects(user_id);
create index if not exists idx_sources_user_id            on sources(user_id);
create index if not exists idx_sources_project_id         on sources(project_id);
create index if not exists idx_knowledge_cards_project_id on knowledge_cards(project_id);
create index if not exists idx_tags_project_id            on tags(project_id);
create index if not exists idx_contexts_project_id        on contexts(project_id);
create index if not exists idx_skill_card_id               on skill(card_id);
create index if not exists idx_practice_attempt_skill_id      on practice_attempt(skill_id);
create index if not exists idx_mc_cloze_check_failure_card_id  on mc_cloze_check_failure(card_id);
create index if not exists idx_mc_cloze_check_failure_skill_id on mc_cloze_check_failure(skill_id);
-- idx_skill_last_correct and idx_practice_attempt_encounter_id are created below, in RETROACTIVE
-- COLUMN ADDITIONS — each must run after its column exists under its current name/shape, which on
-- an existing DB it doesn't yet at this point in the script (last_practiced -> last_correct rename;
-- practice_attempt predates encounter_id entirely).

-- ── RETROACTIVE COLUMN ADDITIONS ─────────────────────────────────────────────
-- Safe to re-run on existing databases.

alter table projects add column if not exists tts_locale      text;
alter table projects add column if not exists context_required boolean not null default false;
alter table skill add column if not exists importance smallint check (importance between 0 and 10);
-- Widen 1-10 -> 0-10 on databases where the column (and its check constraint) already exist —
-- 0 is a deliberate "marked unimportant" state (see CardDetailPanel.jsx/SaveCard.jsx), distinct
-- from null ("not set"). `add column if not exists` above is a no-op against an existing column,
-- so the old constraint has to be dropped and re-added explicitly here.
alter table knowledge_cards drop constraint if exists knowledge_cards_importance_check;
alter table knowledge_cards add constraint knowledge_cards_importance_check check (importance between 0 and 10);
alter table skill drop constraint if exists skill_importance_check;
alter table skill add constraint skill_importance_check check (importance between 0 and 10);
-- level has no default (null = never practiced, distinct from level = 1 = assessed at the bottom
-- of the scale). Was `default 1` until skill level/null semantics were separated; explicit `set
-- default null` below is a no-op on a fresh column but clears the old default on existing DBs.
alter table skill alter column level set default null;
-- Set (true) whenever `level` was last written by the manual editor (PATCH .../knowledge-cards
-- with an explicit `level`, no `practice_result`) rather than earned via a practice attempt —
-- see api/knowledge-cards.js. The Skills page (plan.md §5) renders hand-set levels with a visually
-- distinct (hollow) marker so the audit doesn't mistake a self-assessment for an earned level.
alter table skill add column if not exists hand_set boolean not null default false;

-- last_practiced -> last_correct: this now stamps only on a correct practice attempt, not on
-- every attempt (see api/knowledge-cards.js's practice_result path), so the old name was
-- misleading. Guarded since plain ALTER ... RENAME COLUMN has no IF EXISTS for columns.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'skill' and column_name = 'last_practiced'
  ) then
    alter table skill rename column last_practiced to last_correct;
  end if;
end $$;
alter index if exists idx_skill_last_practiced rename to idx_skill_last_correct;
create index if not exists idx_skill_last_correct on skill(last_correct);

-- practice_attempt predates encounter_id / the item->conversation rename (an earlier iteration of
-- this table shipped without multi-round "Easier sentence" chains in mind) — `create table if not
-- exists` above is a no-op against that existing shape, so fix it up explicitly here, same pattern
-- as last_practiced -> last_correct above. Existing rows predate encounter_id entirely; each gets
-- its own fresh uuid (a singleton encounter), since there's no way to recover true historical
-- grouping.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'practice_attempt' and column_name = 'item'
  ) and not exists (
    select 1 from information_schema.columns
    where table_name = 'practice_attempt' and column_name = 'conversation'
  ) then
    alter table practice_attempt rename column item to conversation;
  end if;
end $$;
alter table practice_attempt add column if not exists encounter_id uuid;
update practice_attempt set encounter_id = gen_random_uuid() where encounter_id is null;
alter table practice_attempt alter column encounter_id set not null;
alter table practice_attempt alter column encounter_id set default gen_random_uuid();
create index if not exists idx_practice_attempt_skill_id      on practice_attempt(skill_id);
create index if not exists idx_practice_attempt_encounter_id  on practice_attempt(encounter_id);

-- source_knowledge.knowledge_card_id originally had no ON DELETE behaviour, so deleting a card
-- (DELETE /api/knowledge-cards?id=) would fail on any card with linked sources. skill/practice_attempt
-- already cascade off knowledge_cards/skill respectively; this closes the same gap on the third table
-- a card delete needs to clean up. source_knowledge is reset-friendly (see "Schema migration
-- strategy"), so this drop+re-add is a behaviour fix, not a data-loss risk.
alter table source_knowledge drop constraint if exists source_knowledge_knowledge_card_id_fkey;
alter table source_knowledge add constraint source_knowledge_knowledge_card_id_fkey
  foreign key (knowledge_card_id) references knowledge_cards(id) on delete cascade;

-- Which skill this particular encounter demonstrated — plan.md "Word Senses": the source link, not
-- just the skill row, should be able to say which sense of a polysemous word was met here. Started
-- out as a sense-specific `sense_type text` column; generalized to a proper FK to `skill(id)` instead,
-- since a real reference works uniformly for a sense skill, an ordinary flat skill, or a paradigm
-- cell alike, rather than only ever being meaningful for the one case a bespoke text column could
-- name. Null whenever an encounter isn't tied to one specific skill (the common case).
alter table source_knowledge drop column if exists sense_type;
alter table source_knowledge add column if not exists skill_id uuid references skill(id) on delete set null;
create index if not exists idx_source_knowledge_skill_id on source_knowledge(skill_id);

-- A sense skill (plan.md — "Word Senses") deliberately KEEPS `type = 'meaning'` — it still groups
-- with every ordinary meaning skill for filtering/gating/practice-rule purposes — and uses this
-- column to record WHICH sense, instead of overloading `type` with the sense key. '' (not null) for
-- every non-sense skill, so `unique (card_id, type, sense_type)` below can enforce the same "one row
-- per (card, type)" invariant it always has (a nullable column wouldn't: Postgres treats every NULL
-- as distinct, so a plain `unique(card_id, type, sense_type)` with real NULLs would silently stop
-- deduplicating ordinary skills). `lib/skillTypes.js`'s `resolveSkillType()`/`skillDbColumns()` are
-- the only place this translation between "one external skill_type string" and these two columns
-- happens — every API consumer still addresses a skill by one string, exactly as before senses existed.
alter table skill add column if not exists sense_type text not null default '';
alter table skill drop constraint if exists skill_card_id_type_key;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'skill_card_id_type_sense_type_key') then
    alter table skill add constraint skill_card_id_type_sense_type_key unique (card_id, type, sense_type);
  end if;
end $$;

-- Practice scheduling. Caches recomputable from practice_attempt (lib/practiceScheduling.js's
-- computeSchedule() is the one place that derives them) — the attempt log stays the source of
-- truth, and scripts/recompute-schedule.js re-derives these from scratch if they ever drift.
--   state: 'never' (no attempts) | 'learning' (most recent answer was wrong — this is the single
--     catch-all for "not currently proven," whether that's a skill that's never once been right or
--     one that just lapsed after being 'stable'; there is no separate lapse bucket) |
--     'relearning' (proven once — one correct answer while 'learning' — but not yet confirmed; one
--     more correct in a row exits to 'stable', one more incorrect drops back to 'learning') |
--     'stable' (confirmed: reached via a first-try correct straight from 'never', or via two
--     correct answers in a row out of 'learning') | 'retired' (level 10, never scheduled again).
--     See lib/practiceScheduling.js for the exact transition table.
--   interval_days / due_at: the expanding-interval ladder (roughly 1/3/7/16/35 days), derived
--     ONLY from the skill's current `level` (lib/practiceScheduling.js's intervalForLevel()) — not
--     from `state` or attempt history, so there's no rung/streak memory to keep here.
alter table skill add column if not exists state text not null default 'never'
  check (state in ('never', 'learning', 'relearning', 'stable', 'retired'));
alter table skill add column if not exists interval_days smallint;
alter table skill add column if not exists due_at timestamptz;

-- The ENTIRE conversation history behind the flagged item (lib/mcClozeCheckLog.js):
--   { generation: { request, response }, checks: [ per-option checker conversation, ... ] }
-- generation.request is the { model, system, messages } sent to the generation model (the shape
-- api/practice.js also round-trips to the client as `request`); generation.response is that call's
-- raw content array (thinking + Step 1 sentence draft + Step 2 tool call); checks[] is
-- verifyMcClozeItem's per-option array, each entry its own { sentence, request, response,
-- grammatical, sensible, reason }. Lets a failed answer-uniqueness check be replayed end to end, not
-- just inspected via the item's own sentence/options. Nullable/partially-null: older rows predate
-- this, and a check can in principle fire before onRequest/onResponse (defensive).
alter table mc_cloze_check_failure add column if not exists conversation jsonb;

-- consecutive_correct/stable_interval_days: dropped. The old model needed them to remember a
-- relearning streak count and the ladder rung a skill fell from; the state machine above replaced
-- both (state itself encodes streak progress, and interval_days depends only on level), and no code
-- has read or written either column since. skill is reset-friendly (see "Schema migration
-- strategy"), so an explicit drop here is fine rather than leaving them as permanent dead weight.
alter table skill drop column if exists consecutive_correct;
alter table skill drop column if exists stable_interval_days;

create index if not exists idx_skill_state_due_at on skill(state, due_at);
create index if not exists idx_skill_due_at on skill(due_at);


-- ── FUNCTIONS ─────────────────────────────────────────────────────────────────

-- Atomically insert a knowledge_card, its source_knowledge link, and (for a flat card — one
-- without details.axes) its initial skill rows at level = null (never practiced). Called
-- via supabase.rpc('save_card_and_link', { card, link, skills }) from /api/save.js, which builds
-- `skills` as [{ type, importance }] — types via lib/skillTypes.js's deriveFlatSkillTypes(), each
-- paired with a default importance via deriveSkillImportance(kind, type, card.importance); empty
-- for paradigm cards, which get no skill rows eagerly (they appear lazily, per schema.sql's skill
-- table comment). Returns the created knowledge_card row as JSON. card must include project_id.
create or replace function save_card_and_link(
  card jsonb,
  link jsonb,
  skills jsonb default '[]'
) returns jsonb language plpgsql as $$
declare
  new_card knowledge_cards;
begin
  insert into knowledge_cards (kind, name, details, tags, related_card_ids, importance, project_id)
  select kind, name, details, tags, related_card_ids, importance, project_id
  from jsonb_populate_record(null::knowledge_cards, card)
  returning * into new_card;

  insert into source_knowledge (source_id, knowledge_card_id, positions, note)
  values (
    (link->>'source_id')::uuid,
    new_card.id,
    (link->'positions'),
    link->>'note'
  );

  if jsonb_array_length(skills) > 0 then
    insert into skill (card_id, type, level, importance)
    select new_card.id, s->>'type', null, (s->>'importance')::smallint
    from jsonb_array_elements(skills) as s
    on conflict (card_id, type, sense_type) do nothing;
  end if;

  return to_jsonb(new_card);
end;
$$;

-- Splits a monosemous card's flat `meaning` skill into a two-value sense axis (plan.md — "Word
-- Senses": "Monosemous words get no axis" / migration). Preserves the meaning skill's id, and
-- therefore its level/hand_set/last_correct/importance and every practice_attempt row referencing
-- it (skill_id is unchanged) — `type` stays 'meaning' the whole time (every sense skill does — see
-- the `skill.sense_type` column comment above); only `sense_type` is set, from '' to the existing
-- sense's key. The new sense gets its own row, also `type = 'meaning'`, keyed by its own sense_type.
--
-- p_new_key/p_new_gloss/p_new_example are OPTIONAL (default null): clicking "add sense" on a
-- monosemous card is often just naming the one sense that's already there, not a claim that a
-- second, distinct sense exists yet (CardDetailPanel's "+ Add sense" — see AddSenseForm.jsx). When
-- p_new_key is omitted this creates a one-value sense axis — a legitimate state, not a stepping
-- stone that must immediately get a second value — and a later append_sense_value call is how a
-- genuinely new sense gets added once one actually shows up. The chat save flow (api/save.js) always
-- has a real second encounter driving it, so it always supplies p_new_key.
create or replace function migrate_card_to_senses(
  p_card_id uuid,
  p_existing_key text,
  p_existing_gloss text,
  p_existing_example text default null,
  p_new_key text default null,
  p_new_gloss text default null,
  p_new_example text default null,
  p_new_importance smallint default null
) returns jsonb language plpgsql as $$
declare
  updated_card knowledge_cards;
  existing_axes jsonb;
  existing_skill_id uuid;
  new_skill_id uuid;
  sense_values jsonb;
begin
  select details->'axes' into existing_axes from knowledge_cards where id = p_card_id;
  if existing_axes is not null and jsonb_array_length(existing_axes) > 0 then
    raise exception 'Card already has axes — use append_sense_value instead';
  end if;
  if p_new_key is not null and p_existing_key = p_new_key then
    raise exception 'existing and new sense keys must differ';
  end if;

  sense_values := jsonb_build_array(jsonb_build_object('key', p_existing_key, 'gloss', p_existing_gloss, 'example', p_existing_example));
  if p_new_key is not null then
    sense_values := sense_values || jsonb_build_array(jsonb_build_object('key', p_new_key, 'gloss', p_new_gloss, 'example', p_new_example));
  end if;

  update knowledge_cards
  set details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
    'axes', jsonb_build_array(jsonb_build_object('name', 'sense', 'values', sense_values))
  )
  where id = p_card_id
  returning * into updated_card;

  update skill set sense_type = p_existing_key where card_id = p_card_id and type = 'meaning' and sense_type = '';
  select id into existing_skill_id from skill where card_id = p_card_id and type = 'meaning' and sense_type = p_existing_key;

  if p_new_key is not null then
    insert into skill (card_id, type, sense_type, level, importance)
    values (p_card_id, 'meaning', p_new_key, null, p_new_importance)
    on conflict (card_id, type, sense_type) do nothing;
    select id into new_skill_id from skill where card_id = p_card_id and type = 'meaning' and sense_type = p_new_key;
  end if;

  -- Returns { card, skill_id, existing_skill_id }. skill_id is the newly touched sense's row (the
  -- new one if a second sense was given, else the renamed existing one) — callers (api/save.js) use
  -- it to point a source_knowledge link at the CURRENT encounter in the same request, no extra round
  -- trip. existing_skill_id is always the renamed (pre-split) skill specifically — the card's OTHER,
  -- already-linked sources predate any sense distinction and almost certainly belong to it, which is
  -- what api/knowledge-cards.js's `link_existing_sources` option backfills them to.
  return jsonb_build_object(
    'card', to_jsonb(updated_card),
    'skill_id', coalesce(new_skill_id, existing_skill_id),
    'existing_skill_id', existing_skill_id
  );
end;
$$;

-- Appends one more value to a card that already has a sense axis — the one deliberate exception to
-- axis immutability (plan.md: "Sense axes are append-only after save"). Creates the new sense's
-- skill row eagerly: unlike an ordinary paradigm cell, a sense axis value existing at all IS an
-- encounter (plan.md — "for sense axes specifically, an axis value existing IS an encounter").
create or replace function append_sense_value(
  p_card_id uuid,
  p_key text,
  p_gloss text,
  p_example text,
  p_importance smallint default null
) returns jsonb language plpgsql as $$
declare
  updated_card knowledge_cards;
  axes jsonb;
  existing_values jsonb;
  new_skill_id uuid;
begin
  select details->'axes' into axes from knowledge_cards where id = p_card_id;
  if axes is null or jsonb_array_length(axes) = 0 or (axes->0->>'name') <> 'sense' then
    raise exception 'Card has no sense axis to append to';
  end if;
  existing_values := axes->0->'values';
  if exists (select 1 from jsonb_array_elements(existing_values) v where v->>'key' = p_key) then
    raise exception 'Sense key "%" already exists on this card', p_key;
  end if;

  update knowledge_cards
  set details = jsonb_set(
    details, '{axes,0,values}',
    existing_values || jsonb_build_array(jsonb_build_object('key', p_key, 'gloss', p_gloss, 'example', p_example))
  )
  where id = p_card_id
  returning * into updated_card;

  insert into skill (card_id, type, sense_type, level, importance)
  values (p_card_id, 'meaning', p_key, null, p_importance)
  on conflict (card_id, type, sense_type) do nothing;

  select id into new_skill_id from skill where card_id = p_card_id and type = 'meaning' and sense_type = p_key;

  -- Returns { card, skill_id } — see migrate_card_to_senses above for why.
  return jsonb_build_object('card', to_jsonb(updated_card), 'skill_id', new_skill_id);
end;
$$;

-- Corrects an existing sense's gloss in place — plan.md's "Refine existing sense" save-flow option:
-- "the gloss is wrong; edit it. Do not force a fork when the right fix is a better gloss." Does NOT
-- touch the value's `key` (which every skill row's `type` and every practice_attempt trace back to)
-- or remove/reorder values — only the append-only-safe `gloss` field.
create or replace function update_sense_gloss(
  p_card_id uuid,
  p_key text,
  p_gloss text
) returns jsonb language plpgsql as $$
declare
  updated_card knowledge_cards;
  axes jsonb;
  idx int;
begin
  select details->'axes' into axes from knowledge_cards where id = p_card_id;
  if axes is null or jsonb_array_length(axes) = 0 or (axes->0->>'name') <> 'sense' then
    raise exception 'Card has no sense axis';
  end if;

  select ord - 1 into idx
  from jsonb_array_elements(axes->0->'values') with ordinality as t(v, ord)
  where t.v->>'key' = p_key;
  if idx is null then
    raise exception 'Sense key "%" not found', p_key;
  end if;

  update knowledge_cards
  set details = jsonb_set(details, array['axes', '0', 'values', idx::text, 'gloss'], to_jsonb(p_gloss))
  where id = p_card_id
  returning * into updated_card;

  return to_jsonb(updated_card);
end;
$$;

-- Removes one sense value from a sense-split card — the one destructive exception among the sense
-- mutations above (append_sense_value/update_sense_gloss are both additive; this actually deletes
-- data). Deletes the sense's own `skill` row outright, which cascades away its practice_attempt
-- history and, via source_knowledge.skill_id's `on delete set null` (see that column above), reverts
-- any source link that pointed at this sense back to "no specific sense" rather than vanishing.
-- Refuses to remove the LAST remaining value: a sense-split card must always keep at least one (a
-- one-value sense axis is itself a legitimate end state — see migrate_card_to_senses above — but
-- zero would leave a vocabulary card with no meaning skill at all).
create or replace function remove_sense_value(
  p_card_id uuid,
  p_key text
) returns jsonb language plpgsql as $$
declare
  updated_card knowledge_cards;
  existing_values jsonb;
  remaining_values jsonb;
begin
  select details->'axes'->0->'values' into existing_values
  from knowledge_cards
  where id = p_card_id and (details->'axes'->0->>'name') = 'sense';
  if existing_values is null then
    raise exception 'Card has no sense axis';
  end if;
  if not exists (select 1 from jsonb_array_elements(existing_values) v where v->>'key' = p_key) then
    raise exception 'Sense key "%" not found', p_key;
  end if;
  if jsonb_array_length(existing_values) <= 1 then
    raise exception 'Cannot remove the last remaining sense';
  end if;

  select jsonb_agg(v) into remaining_values
  from jsonb_array_elements(existing_values) v
  where v->>'key' <> p_key;

  update knowledge_cards
  set details = jsonb_set(details, '{axes,0,values}', remaining_values)
  where id = p_card_id
  returning * into updated_card;

  delete from skill where card_id = p_card_id and type = 'meaning' and sense_type = p_key;

  return to_jsonb(updated_card);
end;
$$;

-- Merges p_card_ids (>= 2, true duplicates of each other) into one surviving card — the oldest
-- (min created_at) of the set — called via supabase.rpc('merge_cards', { p_project_id, p_card_ids })
-- from api/merge-cards.js, itself driven by the Cards panel's "Merge" button over its existing
-- skill-selection Map (distinct card ids therein). All cards must share `kind`, and none may be a
-- paradigm card (details ? 'axes') — merging axes-based skill types isn't handled here.
--   - tags: union of every merged card's tags onto the survivor
--   - source_knowledge: every duplicate's source links are copied onto the survivor
--     (on conflict do nothing — if the survivor already links that source, its own row wins)
--   - skill: unioned by `type`; when more than one card has the same type, only the row with the
--     highest `level` (nulls last) survives — its whole row (importance/hand_set/last_correct/
--     practice_attempt history, via its unchanged id) moves onto the survivor, the others are
--     deleted (cascading their practice_attempt rows)
-- The non-surviving cards are deleted last (cascades any skill/source_knowledge rows already fully
-- accounted for above). Returns the surviving knowledge_card row as JSON.
create or replace function merge_cards(
  p_project_id uuid,
  p_card_ids uuid[]
) returns jsonb language plpgsql as $$
declare
  primary_id uuid;
  merged_card knowledge_cards;
  found_count int;
  distinct_kinds int;
  paradigm_count int;
begin
  if p_card_ids is null or array_length(p_card_ids, 1) is null or array_length(p_card_ids, 1) < 2 then
    raise exception 'merge_cards requires at least 2 card ids';
  end if;

  select count(*) into found_count
  from knowledge_cards where id = any(p_card_ids) and project_id = p_project_id;
  if found_count <> array_length(p_card_ids, 1) then
    raise exception 'One or more cards were not found in this project';
  end if;

  select count(distinct kind) into distinct_kinds
  from knowledge_cards where id = any(p_card_ids) and project_id = p_project_id;
  if distinct_kinds <> 1 then
    raise exception 'Cards must all be the same kind to merge';
  end if;

  select count(*) into paradigm_count
  from knowledge_cards
  where id = any(p_card_ids) and project_id = p_project_id and details ? 'axes';
  if paradigm_count > 0 then
    raise exception 'Paradigm cards cannot be merged';
  end if;

  select id into primary_id
  from knowledge_cards
  where id = any(p_card_ids) and project_id = p_project_id
  order by created_at asc, id asc
  limit 1;

  -- union tags onto the survivor
  update knowledge_cards kc
  set tags = coalesce(sub.all_tags, '{}')
  from (
    select array_agg(distinct tag order by tag) as all_tags
    from knowledge_cards kc2, unnest(coalesce(kc2.tags, '{}'::text[])) as tag
    where kc2.id = any(p_card_ids)
  ) sub
  where kc.id = primary_id;

  -- carry every duplicate's source links onto the survivor; keep the survivor's own position if
  -- it's already linked to that source
  insert into source_knowledge (source_id, knowledge_card_id, positions, note)
  select source_id, primary_id, positions, note
  from source_knowledge
  where knowledge_card_id = any(p_card_ids) and knowledge_card_id <> primary_id
  on conflict (source_id, knowledge_card_id) do nothing;

  -- skills: keep only the highest-level row per (type, sense_type) across the whole set (delete the
  -- rest first, so the unique(card_id, type, sense_type) constraint can never see two rows of the
  -- same (type, sense_type) at once), then move every surviving row onto the primary card. Paradigm
  -- cards (details ? 'axes', which a sense-split card also has) are already blocked from reaching
  -- this function at all (see paradigm_count check above) — partitioning by sense_type too is just
  -- defense in depth in case that restriction is ever relaxed.
  with ranked as (
    select id, type, sense_type,
           row_number() over (
             partition by type, sense_type
             order by level desc nulls last, created_at asc
           ) as rn
    from skill
    where card_id = any(p_card_ids)
  )
  delete from skill
  where id in (select id from ranked where rn <> 1);

  update skill
  set card_id = primary_id
  where card_id = any(p_card_ids) and card_id <> primary_id;

  -- drop the merged-away duplicates
  delete from knowledge_cards
  where id = any(p_card_ids) and id <> primary_id;

  select * into merged_card from knowledge_cards where id = primary_id;
  return to_jsonb(merged_card);
end;
$$;

-- Practice scheduling (plan.md §2/§5): the most recent practice_attempt timestamp per skill,
-- project-wide, in ONE round trip — this is what the selection algorithm's 15-minute
-- within-session cooldown floor is computed against (lib/practiceSelection.js's isInCooldown()),
-- since "last attempted" has to reflect EVERY outcome including 'too_hard' (which never touches
-- skill.due_at — see plan.md §2), not just skill.last_correct (which only stamps on a win).
create or replace function skill_last_attempt(p_project_id uuid)
returns table (skill_id uuid, last_attempt_at timestamptz) language sql stable as $$
  select pa.skill_id, max(pa.created_at)
  from practice_attempt pa
  join skill s on s.id = pa.skill_id
  join knowledge_cards c on c.id = s.card_id
  where c.project_id = p_project_id
  group by pa.skill_id;
$$;

-- Skills page (plan.md) — shared derivation of a skill's "practice state" from practice_attempt,
-- joined to its owning card. Set-returning, filtered only by project so browse_skills and
-- skill_level_histogram below can each apply their own WHERE clause over the same derivation
-- without duplicating it. Not indexed as a materialized view since this is a personal-scale app —
-- re-derived per call.
--
-- An "encounter" is one or more practice_attempt rows sharing encounter_id (a multi-round "Easier
-- sentence" chain is one encounter, not N). Per skill, we look at its MOST RECENT encounter only:
--   - no attempts at all               -> 'never_practiced'
--   - most recent encounter has any 'too_hard' round -> 'too_hard' (outranks 'failing' — see
--     plan.md §1: it means the generator failed, not the learner)
--   - else, most recent encounter's last round outcome = 'correct' -> 'passing', else 'failing'
-- attempt_count/failed_count/too_hard_count are ACROSS ALL encounters (distinct encounter_id),
-- not just the most recent one — that's what "failed N×" / "N× too hard" report on a row.
--
-- last_outcome is the raw outcome ('correct' | 'incorrect' | 'too_hard') of the most recent
-- encounter's last round — null when never practiced. It's a simpler, non-outranked sibling of
-- practice_state (which folds a too_hard encounter into its own bucket ahead of failing): this is
-- literally "what happened last time", for the Skills page's right/wrong/never-tested indicator
-- and its 'last_result' sort.
--
-- schedule_state/interval_days/due_at are the raw `skill.state`/`interval_days`/`due_at` cache
-- columns (lib/practiceScheduling.js) passed through verbatim — the spaced-repetition FSM
-- (never/learning/relearning/stable/retired), NOT the same thing as practice_state above (that's a
-- display-oriented derivation recomputed fresh from practice_attempt every call; schedule_state is
-- the cached scheduling value, named differently on purpose so the two are never confused).
--
-- CASCADE: browse_skills/skill_level_histogram/browse_cards below all call this as a set-returning
-- FROM-clause function, which Postgres records as a real dependency — changing this function's OUT
-- row shape (adding last_outcome) requires dropping it, which drags those down with it. All three
-- are unconditionally recreated later in this same file, so this is safe to reapply every migrate.
--
-- card_group_count: how many card_group rows this skill's card belongs to (plan.md — "Card
-- Groups") — a per-CARD value, duplicated across every skill row of that card, same convention
-- card_importance already uses. Powers the Skills page's group indicator (browse_skills); browse_cards
-- computes its own copy directly against knowledge_cards instead of reusing this one, since a
-- paradigm card can have zero skill rows at all (no row here to carry the count on).
drop function if exists skill_practice_state(uuid) cascade;
create or replace function skill_practice_state(p_project_id uuid)
returns table (
  skill_id          uuid,
  type              text,
  level             smallint,
  importance        smallint,
  hand_set          boolean,
  last_correct      timestamptz,
  skill_created_at  timestamptz,
  card_id           uuid,
  card_name         text,
  card_kind         text,
  card_tags         text[],
  card_importance   smallint,
  card_details      jsonb,
  card_created_at   timestamptz,
  practice_state    text,
  attempt_count     int,
  failed_count      int,
  too_hard_count    int,
  last_attempt_at   timestamptz,
  last_outcome      text,
  schedule_state    text,
  interval_days     smallint,
  due_at            timestamptz,
  card_group_count  int
) language sql stable as $$
  with group_counts as (
    select card_id, count(*)::int as cnt from card_group_member group by card_id
  ),
  encounters as (
    select
      pa.skill_id,
      pa.encounter_id,
      max(pa.created_at) as encounter_last_at,
      bool_or(pa.outcome = 'too_hard') as has_too_hard,
      (array_agg(pa.outcome order by pa.created_at desc))[1] as final_outcome
    from practice_attempt pa
    group by pa.skill_id, pa.encounter_id
  ),
  skill_agg as (
    select
      e.skill_id,
      count(*)::int as encounter_count,
      count(*) filter (where not e.has_too_hard and e.final_outcome <> 'correct')::int as failed_count,
      count(*) filter (where e.has_too_hard)::int as too_hard_count,
      max(e.encounter_last_at) as last_attempt_at,
      (array_agg(e.has_too_hard order by e.encounter_last_at desc))[1] as last_has_too_hard,
      (array_agg(e.final_outcome order by e.encounter_last_at desc))[1] as last_final_outcome
    from encounters e
    group by e.skill_id
  )
  select
    -- A sense skill's DB `type` is always literally 'meaning' (see the skill.sense_type column
    -- comment above) — every consumer of this function (browse_skills, skill_level_histogram,
    -- browse_cards) expects the ONE resolved skill_type string every other read path uses
    -- (lib/skillTypes.js's resolveSkillType()), so it's resolved once, here, rather than in every
    -- caller.
    s.id, coalesce(nullif(s.sense_type, ''), s.type) as type, s.level, s.importance, s.hand_set, s.last_correct, s.created_at,
    c.id, c.name, c.kind, c.tags, c.importance, c.details, c.created_at,
    case
      when sa.last_attempt_at is null then 'never_practiced'
      when sa.last_has_too_hard then 'too_hard'
      when sa.last_final_outcome = 'correct' then 'passing'
      else 'failing'
    end,
    coalesce(sa.encounter_count, 0),
    coalesce(sa.failed_count, 0),
    coalesce(sa.too_hard_count, 0),
    sa.last_attempt_at,
    sa.last_final_outcome,
    s.state, s.interval_days, s.due_at,
    coalesce(gc.cnt, 0)
  from skill s
  join knowledge_cards c on c.id = s.card_id
  left join skill_agg sa on sa.skill_id = s.id
  left join group_counts gc on gc.card_id = c.id
  where c.project_id = p_project_id;
$$;

-- Skills page's main list query (plan.md §2/§3/§8): filters compose with AND, sort is a fixed enum
-- resolved via CASE (no dynamic SQL / string-built ORDER BY). p_states/p_tags are arrays; a null
-- array or null scalar means "no filter" on that dimension. p_tags uses `@>` (card must carry
-- every tag given — AND semantics per plan.md §2). total_count is a window count over the filtered
-- (pre-limit) set, so the client gets pagination totals in one round trip.
--
-- Sort: 'level' | 'last_practiced' | 'attempt_count' | 'importance' | 'name' | 'created' |
-- 'last_result'. Nulls sort last always; for 'level' specifically, never-practiced rows
-- (attempt_count = 0) sort last WITHIN their level group regardless of direction (plan.md §3) —
-- they're the least actionable row at that level, so mixing them in with earned levels defeats
-- the audit. 'last_result' ranks by last_outcome — wrong (incorrect/too_hard), then right
-- (correct), then never-tested (null) ascending, reversed on descending — per the Skills page's
-- right/wrong/never-tested indicator.
--
-- p_schedule_state filters on the SAME schedule_state (never/learning/relearning/stable/retired)
-- the summary strip (skill_schedule_state_counts below) displays — clicking a strip badge sets
-- this, same interaction as clicking a histogram bar sets p_level_min/p_level_max.
drop function if exists browse_skills(uuid, text, smallint, smallint, text[], text, text[], text, text, text, int, int, text);
create or replace function browse_skills(
  p_project_id     uuid,
  p_skill_type     text default null,
  p_level_min      smallint default null,
  p_level_max      smallint default null,
  p_states         text[] default null,
  p_kind           text default null,
  p_tags           text[] default null,
  p_search         text default null,
  p_sort           text default 'level',
  p_sort_dir       text default 'asc',
  p_limit          int default 25,
  p_offset         int default 0,
  p_schedule_state text default null
) returns table (
  skill_id uuid, type text, level smallint, importance smallint, hand_set boolean,
  last_correct timestamptz, skill_created_at timestamptz,
  card_id uuid, card_name text, card_kind text, card_tags text[], card_importance smallint,
  card_details jsonb, card_created_at timestamptz,
  practice_state text, attempt_count int, failed_count int, too_hard_count int,
  last_attempt_at timestamptz, last_outcome text,
  schedule_state text, interval_days smallint, due_at timestamptz, card_group_count int,
  total_count bigint
) language sql stable as $$
  select s.*, count(*) over()
  from skill_practice_state(p_project_id) s
  where
    (p_skill_type is null or s.type = p_skill_type)
    and (p_level_min is null or s.level >= p_level_min)
    and (p_level_max is null or s.level <= p_level_max)
    and (p_states is null or s.practice_state = any(p_states))
    and (p_kind is null or s.card_kind = p_kind)
    and (p_tags is null or s.card_tags @> p_tags)
    and (p_search is null or s.card_name ilike '%' || p_search || '%')
    and (p_schedule_state is null or s.schedule_state = p_schedule_state)
  order by
    case when p_sort = 'level' and p_sort_dir = 'asc'  then s.level end asc nulls last,
    case when p_sort = 'level' and p_sort_dir = 'desc' then s.level end desc nulls last,
    case when p_sort = 'level' then (s.attempt_count = 0)::int end asc,
    case when p_sort = 'last_practiced' and p_sort_dir = 'asc'  then s.last_attempt_at end asc nulls last,
    case when p_sort = 'last_practiced' and p_sort_dir = 'desc' then s.last_attempt_at end desc nulls last,
    case when p_sort = 'last_practiced' then (s.attempt_count = 0)::int end asc,
    case when p_sort = 'attempt_count' and p_sort_dir = 'asc'  then s.attempt_count end asc,
    case when p_sort = 'attempt_count' and p_sort_dir = 'desc' then s.attempt_count end desc,
    case when p_sort = 'importance' and p_sort_dir = 'asc'  then s.card_importance end asc nulls last,
    case when p_sort = 'importance' and p_sort_dir = 'desc' then s.card_importance end desc nulls last,
    case when p_sort = 'name' and p_sort_dir = 'desc' then s.card_name end desc,
    case when p_sort = 'name' then s.card_name end asc,
    case when p_sort = 'created' then s.skill_created_at end desc,
    case when p_sort = 'last_result' and p_sort_dir = 'asc' then
      case when s.last_outcome in ('incorrect', 'too_hard') then 0
           when s.last_outcome = 'correct' then 1
           else 2 end
    end asc,
    case when p_sort = 'last_result' and p_sort_dir = 'desc' then
      case when s.last_outcome in ('incorrect', 'too_hard') then 0
           when s.last_outcome = 'correct' then 1
           else 2 end
    end desc,
    s.skill_id
  limit p_limit offset p_offset;
$$;

-- Level histogram (plan.md §4) — same filters as browse_skills MINUS level, grouped by level.
-- Levels with zero matching skills simply don't appear; the client fills in empty bars.
-- p_schedule_state — see browse_skills's comment above; the histogram still respects an active
-- schedule-state filter (only level itself is excluded, since that's this function's own axis).
drop function if exists skill_level_histogram(uuid, text, text[], text, text[], text);
create or replace function skill_level_histogram(
  p_project_id     uuid,
  p_skill_type     text default null,
  p_states         text[] default null,
  p_kind           text default null,
  p_tags           text[] default null,
  p_search         text default null,
  p_schedule_state text default null
) returns table (level smallint, count bigint) language sql stable as $$
  select s.level, count(*)
  from skill_practice_state(p_project_id) s
  where
    s.level is not null
    and (p_skill_type is null or s.type = p_skill_type)
    and (p_states is null or s.practice_state = any(p_states))
    and (p_kind is null or s.card_kind = p_kind)
    and (p_tags is null or s.card_tags @> p_tags)
    and (p_search is null or s.card_name ilike '%' || p_search || '%')
    and (p_schedule_state is null or s.schedule_state = p_schedule_state)
  group by s.level
  order by s.level;
$$;

-- Schedule-state counts (never/learning/relearning/stable/retired — lib/practiceScheduling.js) for
-- the Skills page's summary strip. Same full filter set as browse_skills, level filter included
-- (unlike skill_level_histogram, which deliberately excludes it since it's the thing generating the
-- level buttons) — deliberately has NO p_schedule_state param of its own, same reasoning: this
-- function generates the state buttons the client clicks to set browse_skills'/
-- skill_level_histogram's p_schedule_state, so every badge's count must stay independent of
-- whichever one is currently active, or picking a state would zero out the others. States with
-- zero matches simply don't appear; the client fills in zero for the rest.
create or replace function skill_schedule_state_counts(
  p_project_id  uuid,
  p_skill_type  text default null,
  p_level_min   smallint default null,
  p_level_max   smallint default null,
  p_states      text[] default null,
  p_kind        text default null,
  p_tags        text[] default null,
  p_search      text default null
) returns table (schedule_state text, count bigint) language sql stable as $$
  select s.schedule_state, count(*)
  from skill_practice_state(p_project_id) s
  where
    (p_skill_type is null or s.type = p_skill_type)
    and (p_level_min is null or s.level >= p_level_min)
    and (p_level_max is null or s.level <= p_level_max)
    and (p_states is null or s.practice_state = any(p_states))
    and (p_kind is null or s.card_kind = p_kind)
    and (p_tags is null or s.card_tags @> p_tags)
    and (p_search is null or s.card_name ilike '%' || p_search || '%')
  group by s.schedule_state;
$$;

-- Cards panel additions (plan.md §7) — same list shape as the plain knowledge_cards query
-- api/knowledge-cards.js used to run directly, plus per-card aggregates over skill_practice_state
-- that have no meaning as a bare "sort by level" (a card's skills are heterogeneous — min/mean are
-- the only well-defined rollups, see plan.md §7). `skills` is each card's flat {type,level} list,
-- jsonb-aggregated here so the client's SkillBadge doesn't need a second round trip per card.
-- p_below_level: card has at least one non-null skill level <= this (equivalent to min_level <=
-- p_below_level, so no extra join needed). p_practice_state: 'never_practiced' (no skill on the
-- card has ever been attempted) | 'has_failures' (at least one skill's current state is 'failing'
-- or 'too_hard').
drop function if exists browse_cards(uuid, text, text, text[], smallint, text, text, text, int, int);
create or replace function browse_cards(
  p_project_id      uuid,
  p_search          text default null,
  p_kind            text default null,
  p_tags            text[] default null,
  p_below_level     smallint default null,
  p_practice_state  text default null,
  p_sort            text default 'name',
  p_sort_dir        text default 'asc',
  p_limit           int default 25,
  p_offset          int default 0
) returns table (
  card_id uuid, name text, kind text, tags text[], importance smallint, details jsonb,
  created_at timestamptz, link_count bigint, min_level smallint, mean_level numeric,
  last_practiced timestamptz, skills jsonb, group_count bigint, total_count bigint
) language sql stable as $$
  with card_skill_agg as (
    select
      sa.card_id,
      min(sa.level) as min_level,
      avg(sa.level) as mean_level,
      max(sa.last_attempt_at) as last_practiced,
      bool_and(sa.attempt_count = 0) as never_practiced,
      bool_or(sa.practice_state in ('failing', 'too_hard')) as has_failures,
      jsonb_agg(jsonb_build_object('type', sa.type, 'level', sa.level)) as skills
    from skill_practice_state(p_project_id) sa
    group by sa.card_id
  ),
  link_counts as (
    select knowledge_card_id, count(*) as cnt
    from source_knowledge
    group by knowledge_card_id
  ),
  -- Computed directly against card_group_member (plan.md — "Card Groups"), not routed through
  -- card_skill_agg/skill_practice_state, since a paradigm card can have zero skill rows at all
  -- (lazily created) and would otherwise never show a group badge despite genuinely being grouped.
  group_counts as (
    select card_id, count(*) as cnt
    from card_group_member
    group by card_id
  )
  select
    c.id, c.name, c.kind, c.tags, c.importance, c.details, c.created_at,
    coalesce(lc.cnt, 0),
    csa.min_level, csa.mean_level, csa.last_practiced,
    coalesce(csa.skills, '[]'::jsonb),
    coalesce(gc.cnt, 0),
    count(*) over()
  from knowledge_cards c
  left join card_skill_agg csa on csa.card_id = c.id
  left join link_counts lc on lc.knowledge_card_id = c.id
  left join group_counts gc on gc.card_id = c.id
  where
    c.project_id = p_project_id
    and (p_search is null or c.name ilike '%' || p_search || '%')
    and (p_kind is null or c.kind = p_kind)
    and (p_tags is null or c.tags @> p_tags)
    and (p_below_level is null or (csa.min_level is not null and csa.min_level <= p_below_level))
    and (
      p_practice_state is null
      or (p_practice_state = 'never_practiced' and coalesce(csa.never_practiced, true))
      or (p_practice_state = 'has_failures' and coalesce(csa.has_failures, false))
    )
  order by
    case when p_sort = 'name' and p_sort_dir = 'desc' then c.name end desc,
    case when p_sort = 'name' then c.name end asc,
    case when p_sort = 'created' and p_sort_dir = 'asc' then c.created_at end asc,
    case when p_sort = 'created' then c.created_at end desc,
    case when p_sort = 'importance' and p_sort_dir = 'asc' then c.importance end asc nulls last,
    case when p_sort = 'importance' then c.importance end desc nulls last,
    case when p_sort = 'link_count' and p_sort_dir = 'asc' then coalesce(lc.cnt, 0) end asc,
    case when p_sort = 'link_count' then coalesce(lc.cnt, 0) end desc,
    case when p_sort = 'min_level' and p_sort_dir = 'desc' then csa.min_level end desc nulls last,
    case when p_sort = 'min_level' then csa.min_level end asc nulls last,
    case when p_sort = 'mean_level' and p_sort_dir = 'desc' then csa.mean_level end desc nulls last,
    case when p_sort = 'mean_level' then csa.mean_level end asc nulls last,
    case when p_sort = 'last_practiced' and p_sort_dir = 'desc' then csa.last_practiced end desc nulls last,
    case when p_sort = 'last_practiced' then csa.last_practiced end asc nulls last,
    c.id
  limit p_limit offset p_offset;
$$;

-- Usage/cost rollup over llm_api_call, grouped by purpose+model — backs a future usage dashboard the
-- same way browse_cards/browse_skills back their panels. p_project_id is nullable ("every project the
-- caller can see" is left to the API layer, which already scopes by project ownership before calling
-- this); p_from/p_to bound created_at for a billing-period view.
create or replace function llm_usage_summary(
  p_project_id uuid default null,
  p_from       timestamptz default null,
  p_to         timestamptz default null
) returns table (
  purpose             text,
  model               text,
  call_count          bigint,
  error_count         bigint,
  input_tokens        bigint,
  output_tokens       bigint,
  cache_read_tokens   bigint,
  cache_write_tokens  bigint,
  total_cost_usd      numeric,
  avg_latency_ms      numeric
) language sql stable as $$
  select
    purpose, model,
    count(*),
    count(*) filter (where status = 'error'),
    sum(coalesce(input_tokens, 0)),
    sum(coalesce(output_tokens, 0)),
    sum(coalesce(cache_read_input_tokens, 0)),
    sum(coalesce(cache_creation_input_tokens, 0)),
    sum(coalesce(cost_usd, 0)),
    avg(latency_ms)
  from llm_api_call
  where (p_project_id is null or project_id = p_project_id)
    and (p_from is null or created_at >= p_from)
    and (p_to is null or created_at < p_to)
  group by purpose, model
  order by purpose, model;
$$;

-- Auto-create user_settings row when a new Auth user is created.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
