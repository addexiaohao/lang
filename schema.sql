-- schema.sql — single source of truth for the database
-- Run in Supabase SQL editor to apply.
--
-- SACRED tables (sources, projects, contexts, tags): never drop, additive changes only.
-- RESET-FRIENDLY tables: drop and recreate freely during iteration.

-- ── RESET-FRIENDLY ───────────────────────────────────────────────────────────

drop table if exists source_knowledge;
drop table if exists knowledge_cards;
-- tags is NOT dropped here — it holds curated catalog data

-- ── SACRED (never drop) ───────────────────────────────────────────────────────
-- drop table if exists sources;   ← keep commented as a reminder
-- drop table if exists projects;
-- drop table if exists contexts;  ← keep commented as a reminder
-- drop table if exists tags;      ← keep commented as a reminder

-- ── CREATE ────────────────────────────────────────────────────────────────────

create table if not exists projects (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  system_prompt   text,
  config          jsonb not null default '{}',
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
  original_text text not null,
  created_at    timestamptz not null default now()
);

create table knowledge_cards (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid references projects(id) on delete cascade,
  kind             text not null check (kind in ('vocabulary','grammar','expression','table')),
  name             text not null,
  details          jsonb,
  tags             text[],
  related_card_ids uuid[],
  skill            int check (skill between 1 and 10),   -- null for table kind
  importance       int check (importance between 1 and 10),
  axes             jsonb,  -- table kind: [{name, values}] axis definitions
  cells            jsonb,  -- table kind: {"key": {"skill": int}} per-cell skill map
  created_at       timestamptz not null default now(),
  unique (project_id, name)
);

-- Per-user settings: default project selection, etc.
create table if not exists user_settings (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  default_project_id uuid references projects(id) on delete set null,
  updated_at         timestamptz not null default now()
);

alter table user_settings enable row level security;
drop policy if exists "anon full access" on user_settings;

-- Tag catalog — curated vocabulary for knowledge_card tags.
-- knowledge_cards.tags is text[] (denormalized); this table is the canonical spelling source.
-- name: full identifier stored in knowledge_cards.tags (e.g. "verb-irregular-present")
-- display_name: short label shown in the UI (e.g. "irr-present")
create table if not exists tags (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references projects(id) on delete cascade,
  name         text not null,
  display_name text,
  description  text,
  created_at   timestamptz not null default now(),
  unique (project_id, name)
);

create table source_knowledge (
  source_id        uuid not null references sources(id),
  knowledge_card_id uuid not null references knowledge_cards(id),
  excerpt          text,
  note             text,
  created_at       timestamptz not null default now(),
  primary key (source_id, knowledge_card_id)
);


-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table projects         enable row level security;
alter table sources          enable row level security;
alter table knowledge_cards  enable row level security;
alter table source_knowledge enable row level security;
alter table contexts         enable row level security;
alter table tags             enable row level security;

-- Remove old open-access policies
drop policy if exists "anon full access" on projects;
drop policy if exists "anon full access" on sources;
drop policy if exists "anon full access" on knowledge_cards;
drop policy if exists "anon full access" on source_knowledge;
drop policy if exists "anon full access" on contexts;
drop policy if exists "anon full access" on tags;

-- All data access goes through /api/* serverless functions using the service role key,
-- which bypasses RLS. No direct browser access to the DB is permitted.
-- (No permissive policies means all non-service-role access is denied.)


-- ── TAG CATALOG SEED ─────────────────────────────────────────────────────────
-- Safe to re-run; ON CONFLICT DO NOTHING is idempotent.
-- NOTE: After adding project_id to tags, seed tags are per-project.
-- Run this after inserting your project row, substituting the real project uuid.
-- Example:
--   insert into tags (project_id, name, display_name) values ('<project-uuid>', 'noun', 'noun') on conflict (project_id, name) do update set display_name = excluded.display_name;
-- The seed block below is intentionally left without project_id — run it manually per project.


-- ── SYSTEM PROMPT HISTORY ────────────────────────────────────────────────────

create table if not exists system_prompt_history (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  prompt      text not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_system_prompt_history_project_id on system_prompt_history(project_id);

-- ── CHANGES TO SACRED TABLES ─────────────────────────────────────────────────
-- Additive changes: new columns with defaults or nullable.
-- Destructive changes: only with explicit confirmation (data is gone forever).

-- Rename settings → config (idempotent via DO block)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'projects' and column_name = 'settings'
  ) then
    alter table projects rename column settings to config;
  end if;
end $$;

alter table projects add column if not exists config   jsonb not null default '{}';
alter table projects add column if not exists user_id  uuid references auth.users(id) on delete cascade;

alter table sources  add column if not exists user_id  uuid references auth.users(id) on delete cascade;
alter table sources  add column if not exists context_id uuid references contexts(id) on delete restrict;
-- context_id is nullable: required when project.config.contexts_required is true, optional otherwise.
alter table sources  alter column context_id drop not null;
alter table sources  drop column if exists context;

alter table tags add column if not exists project_id uuid references projects(id) on delete cascade;
alter table tags add column if not exists display_name text;

-- Drop old unique constraint on name alone and add per-project uniqueness
alter table tags drop constraint if exists tags_name_key;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tags_project_id_name_key'
  ) then
    alter table tags add constraint tags_project_id_name_key unique (project_id, name);
  end if;
end $$;

-- ── INDEXES ───────────────────────────────────────────────────────────────────

create index if not exists idx_projects_user_id          on projects(user_id);
create index if not exists idx_sources_user_id           on sources(user_id);
create index if not exists idx_sources_project_id        on sources(project_id);
create index if not exists idx_knowledge_cards_project_id on knowledge_cards(project_id);
create index if not exists idx_tags_project_id           on tags(project_id);
create index if not exists idx_contexts_project_id       on contexts(project_id);


-- ── FUNCTIONS ─────────────────────────────────────────────────────────────────

-- Atomically insert a knowledge_card and its source_knowledge link.
-- Called via supabase.rpc('save_card_and_link', { card, link }) from /api/save.js.
-- Returns the created knowledge_card row as JSON.
-- card must include project_id.
create or replace function save_card_and_link(
  card jsonb,
  link jsonb
) returns jsonb language plpgsql as $$
declare
  new_card knowledge_cards;
begin
  insert into knowledge_cards (kind, name, details, tags, related_card_ids, skill, importance, axes, cells, project_id)
  select kind, name, details, tags, related_card_ids, skill, importance, axes, cells, project_id
  from jsonb_populate_record(null::knowledge_cards, card)
  returning * into new_card;

  insert into source_knowledge (source_id, knowledge_card_id, excerpt, note)
  values (
    (link->>'source_id')::uuid,
    new_card.id,
    link->>'excerpt',
    link->>'note'
  );

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
