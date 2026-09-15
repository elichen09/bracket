-- The Break — accounts. Run this once in the Supabase SQL editor on a project that
-- already has schema.sql applied. (Fresh projects: schema.sql already includes it.)
--
-- Every bracket now belongs to a signed-in user, and a user gets exactly one
-- bracket per tournament. Brackets created before accounts existed keep
-- user_id = null: they stay visible on the leaderboard but can no longer be edited.

alter table public.entries add column if not exists user_id uuid references auth.users(id) on delete cascade;

create unique index if not exists entries_one_per_user_per_tournament
  on public.entries (tournament_id, user_id) where user_id is not null;

create index if not exists entries_user_idx on public.entries (user_id);

-- The public projection stays token-free; user_id is exposed so a client can
-- recognise its own bracket (a uuid identifies nobody by itself).
-- (drop first: "create or replace" can't insert a column into an existing view)
drop view if exists public.entries_public;
create view public.entries_public as
  select id, tournament_id, user_id, name, picks, locked, locked_at, created_at, updated_at
  from public.entries;

grant select on public.entries_public to anon, authenticated;
