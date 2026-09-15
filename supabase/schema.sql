-- The Break — database schema. Run this once in the Supabase SQL editor.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- tournaments
-- ---------------------------------------------------------------------------
create table if not exists public.tournaments (
  id                 text primary key,                -- url slug, e.g. "coon"
  name               text not null,
  event              text not null default '',
  host               text not null default '',
  year               text not null default '',
  tabroom_tourn_id   integer,
  tabroom_result_id  integer,
  round_ids          jsonb not null default '{}'::jsonb,   -- {"0": 1534253, "1": ...}
  slots              jsonb not null default '[]'::jsonb,   -- ["1. Emory GY", "", ...] ("" = bye)
  results            jsonb not null default '{}'::jsonb,   -- {"0": {"3": [8, "2-1", "AFF"]}}
  notes              jsonb not null default '{}'::jsonb,   -- {"1:14": "No decision posted…"}
  locked_rounds      integer not null default 0,           -- rounds decided before the pool opened
  status             text not null default 'pending',      -- pending | open | live | complete
  sort_order         integer not null default 0,
  last_checked_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- entries (one bracket per person per tournament)
-- ---------------------------------------------------------------------------
create table if not exists public.entries (
  id             text not null,                         -- short id, e.g. "K7M2Q"
  tournament_id  text not null references public.tournaments(id) on delete cascade,
  name           text not null,
  picks          jsonb not null default '{}'::jsonb,    -- {"1:14": 29}
  locked         boolean not null default false,
  locked_at      timestamptz,
  token          uuid not null default gen_random_uuid(), -- legacy edit secret (pre-accounts brackets)
  user_id        uuid references auth.users(id) on delete cascade, -- owner; one bracket per user per tournament
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (tournament_id, id)
);
create index if not exists entries_tournament_idx on public.entries (tournament_id);
create index if not exists entries_user_idx on public.entries (user_id);
create unique index if not exists entries_one_per_user_per_tournament
  on public.entries (tournament_id, user_id) where user_id is not null;

-- Public projection of entries: everything except the edit token.
-- (drop first: "create or replace" can't insert a column into an existing view)
drop view if exists public.entries_public;
create view public.entries_public as
  select id, tournament_id, user_id, name, picks, locked, locked_at, created_at, updated_at
  from public.entries;

-- ---------------------------------------------------------------------------
-- Row-level security: the browser (anon key) may only read.
-- All writes go through the API routes, which use the service role key.
-- ---------------------------------------------------------------------------
alter table public.tournaments enable row level security;
alter table public.entries     enable row level security;

drop policy if exists "tournaments are public" on public.tournaments;
create policy "tournaments are public" on public.tournaments
  for select to anon, authenticated using (true);

-- No select policy on entries for anon: the token column must stay private.
-- The view is owned by postgres and reads with the owner's rights (security definer semantics),
-- so anon can read it while the base table stays closed.
grant usage on schema public to anon, authenticated;
grant select on public.tournaments to anon, authenticated;
grant select on public.entries_public to anon, authenticated;
revoke all on public.entries from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime on tournaments (results arriving) — entries are polled by the client.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tournaments'
  ) then
    alter publication supabase_realtime add table public.tournaments;
  end if;
end $$;

-- keep updated_at fresh
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists tournaments_touch on public.tournaments;
create trigger tournaments_touch before update on public.tournaments
  for each row execute function public.touch_updated_at();

drop trigger if exists entries_touch on public.entries;
create trigger entries_touch before update on public.entries
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- career-record cache (the Career section of a dossier) — see migrations/003_career_cache.sql
-- ---------------------------------------------------------------------------
create table if not exists public.student_records (
  student_id  integer primary key,
  payload     jsonb not null,
  fetched_at  timestamptz not null default now()
);

alter table public.student_records enable row level security;
-- No policies: only the service role (API routes) reads or writes this table.
revoke all on public.student_records from anon, authenticated;
