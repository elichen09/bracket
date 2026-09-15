-- The Break — cache for debater career records (the "Career" section of a dossier).
-- Run once in the Supabase SQL editor after 002. (Fresh projects: schema.sql includes it.)
--
-- Careers come from Tabroom's per-student results page, which needs a login. Each
-- record is cached here for 12 hours so a busy pool page never re-fetches it, and
-- the app's Tabroom account signs in as rarely as possible. Optional: without this
-- table the app falls back to an in-memory cache.

create table if not exists public.student_records (
  student_id  integer primary key,
  payload     jsonb not null,
  fetched_at  timestamptz not null default now()
);

alter table public.student_records enable row level security;
-- No policies: only the service role (API routes) reads or writes this table.
revoke all on public.student_records from anon, authenticated;
