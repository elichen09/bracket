-- The Break — Glicko-2 ratings, and predictions for tournaments that have not broken yet.
-- Run once in the Supabase SQL editor after 003. (Fresh projects: schema.sql includes it.)

-- A tournament can now be tracked before any bracket exists, so it needs to name its
-- Tabroom event directly rather than being identified by a published bracket result set.
alter table public.tournaments add column if not exists tabroom_event_abbr text;
alter table public.tournaments add column if not exists tabroom_event_id integer;

-- ---------------------------------------------------------------------------
-- rating_games — one row per debated round, per entry. Both sides of a round
-- produce a row, which is what Glicko-2 consumes (each competitor sees its own
-- game list). Prelims and elims alike; `elim` says which.
-- ---------------------------------------------------------------------------
create table if not exists public.rating_games (
  tourn_id       integer not null,
  round_id       integer not null,
  entry_id       integer not null,
  opp_entry_id   integer not null,
  event_id       integer,
  event_name     text not null default '',
  tourn_name     text not null default '',
  tourn_start    timestamptz,
  round_name     integer,
  round_label    text not null default '',
  elim           boolean not null default false,
  code           text not null default '',
  opp_code       text not null default '',
  school         text,
  side           text,                                   -- Aff/Neg as Tabroom reports it
  score          real not null,                          -- 1 win, 0 loss, 0.5 undecided
  ballots_for    integer not null default 0,
  ballots_against integer not null default 0,
  points         real,                                   -- team speaker points that round
  student_ids    integer[] not null default '{}',
  created_at     timestamptz not null default now(),
  primary key (tourn_id, round_id, entry_id)
);
create index if not exists rating_games_code_idx on public.rating_games (code, tourn_start);
create index if not exists rating_games_pair_idx on public.rating_games (code, opp_code);
create index if not exists rating_games_tourn_idx on public.rating_games (tourn_id);

-- ---------------------------------------------------------------------------
-- ratings — Glicko-2 state. One row per partnership (kind 'team', key = the
-- Tabroom entry code) and one per debater (kind 'debater', key = student id).
-- ---------------------------------------------------------------------------
create table if not exists public.ratings (
  kind          text not null,                           -- 'team' | 'debater'
  key           text not null,
  display       text not null default '',
  school        text,
  rating        real not null default 1500,
  rd            real not null default 350,
  vol           real not null default 0.06,
  games         integer not null default 0,
  wins          integer not null default 0,
  losses        integer not null default 0,
  tournaments   integer not null default 0,
  points_avg    real,                                    -- mean speaker points per round
  points_z      real,                                    -- mean per-tournament z-score of those points
  last_played   timestamptz,
  history       jsonb not null default '[]'::jsonb,      -- [{tourn, start, rating, rd, w, l}]
  updated_at    timestamptz not null default now(),
  primary key (kind, key)
);
create index if not exists ratings_kind_rating_idx on public.ratings (kind, rating desc);

-- ---------------------------------------------------------------------------
-- predictions — a simulated tournament, private to the account that ran it.
-- ---------------------------------------------------------------------------
create table if not exists public.predictions (
  user_id       uuid not null references auth.users(id) on delete cascade,
  tournament_id text not null references public.tournaments(id) on delete cascade,
  payload       jsonb not null,
  runs          integer not null default 0,
  created_at    timestamptz not null default now(),
  primary key (user_id, tournament_id)
);

alter table public.rating_games enable row level security;
alter table public.ratings      enable row level security;
alter table public.predictions  enable row level security;

-- Ratings are public reading; games and predictions are served through the API only.
drop policy if exists "ratings are public" on public.ratings;
create policy "ratings are public" on public.ratings for select to anon, authenticated using (true);
grant select on public.ratings to anon, authenticated;
revoke all on public.rating_games from anon, authenticated;
revoke all on public.predictions from anon, authenticated;
