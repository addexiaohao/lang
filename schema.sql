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
create index if not exists idx_practice_attempt_skill_id      on practice_attempt(skill_id);
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
    on conflict (card_id, type) do nothing;
  end if;

  return to_jsonb(new_card);
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

  -- skills: keep only the highest-level row per type across the whole set (delete the rest first,
  -- so the unique(card_id, type) constraint can never see two rows of the same type at once), then
  -- move every surviving row onto the primary card
  with ranked as (
    select id, type,
           row_number() over (
             partition by type
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
  last_attempt_at   timestamptz
) language sql stable as $$
  with encounters as (
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
    s.id, s.type, s.level, s.importance, s.hand_set, s.last_correct, s.created_at,
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
    sa.last_attempt_at
  from skill s
  join knowledge_cards c on c.id = s.card_id
  left join skill_agg sa on sa.skill_id = s.id
  where c.project_id = p_project_id;
$$;

-- Skills page's main list query (plan.md §2/§3/§8): filters compose with AND, sort is a fixed enum
-- resolved via CASE (no dynamic SQL / string-built ORDER BY). p_states/p_tags are arrays; a null
-- array or null scalar means "no filter" on that dimension. p_tags uses `@>` (card must carry
-- every tag given — AND semantics per plan.md §2). total_count is a window count over the filtered
-- (pre-limit) set, so the client gets pagination totals in one round trip.
--
-- Sort: 'level' | 'last_practiced' | 'attempt_count' | 'importance' | 'name' | 'created'.
-- Nulls sort last always; for 'level' specifically, never-practiced rows (attempt_count = 0) sort
-- last WITHIN their level group regardless of direction (plan.md §3) — they're the least
-- actionable row at that level, so mixing them in with earned levels defeats the audit.
create or replace function browse_skills(
  p_project_id  uuid,
  p_skill_type  text default null,
  p_level_min   smallint default null,
  p_level_max   smallint default null,
  p_states      text[] default null,
  p_kind        text default null,
  p_tags        text[] default null,
  p_search      text default null,
  p_sort        text default 'level',
  p_sort_dir    text default 'asc',
  p_limit       int default 25,
  p_offset      int default 0
) returns table (
  skill_id uuid, type text, level smallint, importance smallint, hand_set boolean,
  last_correct timestamptz, skill_created_at timestamptz,
  card_id uuid, card_name text, card_kind text, card_tags text[], card_importance smallint,
  card_details jsonb, card_created_at timestamptz,
  practice_state text, attempt_count int, failed_count int, too_hard_count int,
  last_attempt_at timestamptz, total_count bigint
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
    s.skill_id
  limit p_limit offset p_offset;
$$;

-- Level histogram (plan.md §4) — same filters as browse_skills MINUS level, grouped by level.
-- Levels with zero matching skills simply don't appear; the client fills in empty bars.
create or replace function skill_level_histogram(
  p_project_id  uuid,
  p_skill_type  text default null,
  p_states      text[] default null,
  p_kind        text default null,
  p_tags        text[] default null,
  p_search      text default null
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
  group by s.level
  order by s.level;
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
  last_practiced timestamptz, skills jsonb, total_count bigint
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
  )
  select
    c.id, c.name, c.kind, c.tags, c.importance, c.details, c.created_at,
    coalesce(lc.cnt, 0),
    csa.min_level, csa.mean_level, csa.last_practiced,
    coalesce(csa.skills, '[]'::jsonb),
    count(*) over()
  from knowledge_cards c
  left join card_skill_agg csa on csa.card_id = c.id
  left join link_counts lc on lc.knowledge_card_id = c.id
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
