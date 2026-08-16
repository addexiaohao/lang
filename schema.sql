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
  importance        int check (importance between 1 and 10),
  created_at        timestamptz not null default now(),
  unique (project_id, name)
);

-- A skill is a claim about a card that can be assessed — a card is a "thing you encountered",
-- a skill is "how reliably you produce one facet of it". Flat cards (vocabulary/grammar/expression
-- without axes) get types from lib/skillTypes.js's SKILL_TYPES registry, eagerly at level = 1
-- (baseline, not yet practiced). Paradigm cards (details.axes present) get dotted-path types, one
-- segment per axis, e.g. "akk.masc" — no row = that cell was never encountered. A row can still
-- have level = null (manually cleared via the editor), distinct from both "never encountered" (no
-- row) and a real level. `type` is free text validated in code (lib/skillTypes.js's
-- validateSkillType), not a Postgres enum, since new types will be added often.
create table if not exists skill (
  id             uuid primary key default gen_random_uuid(),
  card_id        uuid not null references knowledge_cards(id) on delete cascade,
  type           text not null,
  level          smallint check (level between 1 and 10),
  importance     smallint check (importance between 1 and 10),
  last_correct   timestamptz,  -- set only on a correct practice attempt, not on every attempt
  created_at     timestamptz not null default now(),
  unique (card_id, type)
);

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


-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table projects               enable row level security;
alter table sources                enable row level security;
alter table knowledge_cards        enable row level security;
alter table source_knowledge       enable row level security;
alter table contexts               enable row level security;
alter table tags                   enable row level security;
alter table user_settings          enable row level security;
alter table skill                  enable row level security;
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

-- ── INDEXES ───────────────────────────────────────────────────────────────────

create index if not exists idx_projects_user_id           on projects(user_id);
create index if not exists idx_sources_user_id            on sources(user_id);
create index if not exists idx_sources_project_id         on sources(project_id);
create index if not exists idx_knowledge_cards_project_id on knowledge_cards(project_id);
create index if not exists idx_tags_project_id            on tags(project_id);
create index if not exists idx_contexts_project_id        on contexts(project_id);
create index if not exists idx_skill_card_id               on skill(card_id);
-- idx_skill_last_correct is created below, in RETROACTIVE COLUMN ADDITIONS — it must run after
-- the last_practiced -> last_correct rename, since on an existing DB the column doesn't exist
-- under its new name until then.

-- ── RETROACTIVE COLUMN ADDITIONS ─────────────────────────────────────────────
-- Safe to re-run on existing databases.

alter table projects add column if not exists tts_locale      text;
alter table projects add column if not exists context_required boolean not null default false;
alter table skill add column if not exists importance smallint check (importance between 1 and 10);
alter table skill alter column level set default 1;

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


-- ── FUNCTIONS ─────────────────────────────────────────────────────────────────

-- Atomically insert a knowledge_card, its source_knowledge link, and (for a flat card — one
-- without details.axes) its initial skill rows at level = 1 (baseline, not yet practiced). Called
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
    select new_card.id, s->>'type', 1, (s->>'importance')::smallint
    from jsonb_array_elements(skills) as s
    on conflict (card_id, type) do nothing;
  end if;

  return to_jsonb(new_card);
end;
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
