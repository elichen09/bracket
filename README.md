# The Break

Bracket pools for debate elimination rounds. Fill in a Tabroom elim bracket, lock
it, and it scores itself as results post — a March-Madness-style pool with a
leaderboard per tournament. Built with Next.js + Supabase; deploys to Vercel (or
anywhere that runs Next).

- **Multiple tournaments**, each with its own bracket, pool and leaderboard.
- **Share by link** — anyone who opens a tournament gets their own bracket; each
  bracket has a short 5-character id (no long share codes).
- **Lock** your bracket, or let each match lock itself when its result lands.
- **Auto-updating** results pulled from Tabroom on a schedule.
- **You add tournaments** from `/new` (guarded by an admin key).

Scoring: points double each round so every round is worth the same total, plus an
upset bonus of 1 point per N seeds of gap (4 in small fields, 8 in fields of 64+),
capped at double the round value. Rounds already decided before a tournament is
added don't count. Full explanation lives at `/about`.

---

## 1. Create the Supabase project

1. Make a project at [supabase.com](https://supabase.com).
2. In **SQL Editor**, run `supabase/schema.sql`, then `supabase/seed.sql`
   (the seed loads the two tournaments already tracked — delete those rows if you
   want to start clean).
3. From **Project Settings → API**, copy the Project URL, the `anon` public key,
   and the `service_role` secret key.

## 2. Configure environment

Copy `.env.example` to `.env.local` and fill it in:

| var | what it is |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public key (browser, read-only) |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key (server only — all writes) |
| `ADMIN_KEY` | passphrase required to add tournaments at `/new` |
| `UPDATE_SECRET` | shared secret the scheduled updater must send |
| `TABROOM_USERNAME` / `TABROOM_PASSWORD` | a Tabroom account (results pages need a login) |

The `NEXT_PUBLIC_*` values are the only ones shipped to the browser. Everything
else stays server-side.

## 3. Run locally

```bash
npm install
npm run dev        # http://localhost:3000
```

## 4. Deploy to Vercel

1. Push this folder to a GitHub repo and import it at
   [vercel.com/new](https://vercel.com/new).
2. Add all the env vars above in **Project → Settings → Environment Variables**.
3. Deploy.
4. Results update hourly through the included GitHub Action
   (`.github/workflows/update.yml`), since Vercel's Hobby plan only allows daily
   crons. In the GitHub repo, add **Settings → Secrets and variables → Actions**
   secrets `SITE_URL` (your deployed URL) and `UPDATE_SECRET` (same value as the
   app's env var), and it curls the updater every hour.

Admins can also use the "Admin: force update" button on the home page, or
trigger a refresh by hand:

```bash
curl -X POST https://YOUR-SITE/api/update -H "x-update-secret: YOUR_UPDATE_SECRET"
```

## Adding a tournament

Open `/new`, enter the admin key, and paste the Tabroom **bracket** link
(`…/bracket.mhtml?tourn_id=…&result_id=…`). Also paste the first elim round's
**results** link (`…/round_results.mhtml?…&round_id=…`) if it exists yet — that's
the anchor the updater walks forward from to find later rounds. The bracket fills
in on the next update, or paste the seeded team list to open it for picks
immediately.

## How results come in

`/api/update` logs into Tabroom, and for each unfinished tournament:

- pulls the opening-round bracket if it's still empty;
- reads each round's results page (walking forward from the last known
  `round_id`), matching pairings against the bracket;
- records the winner and ballot count per match;
- infers advances for closeouts / undecided matches from the next round's
  pairings (marked `ADV`, never guessed);
- sets the tournament's status and, when the final is in, marks it complete.

It never touches anyone's picks.

## Data model

- `tournaments` — one row per tournament (bracket, results, status, Tabroom ids).
- `entries` — one bracket per person per tournament; carries a private `token`
  that proves ownership for edits. The browser reads the `entries_public` view,
  which omits the token.

Row-level security lets the browser only read; every write goes through the API
routes with the service-role key.

## Layout

```
app/
  page.tsx            home — tournament index
  t/[id]/page.tsx     one tournament: bracket, pool, leaderboard, results
  new/page.tsx        add a tournament (admin-key gated)
  about/page.tsx      scoring explained
  api/
    entries/          create + edit brackets (token-checked)
    tournaments/      add a tournament (admin-key)
    update/           the Tabroom results updater (secret-gated, cron)
lib/
  bracket.ts          scoring + bracket engine (shared client/server)
  tabroom.ts          Tabroom session + result parsing/sync
  useBreak.ts         client data hooks (realtime + polling)
supabase/
  schema.sql          tables, view, RLS, realtime
  seed.sql            the two tournaments already tracked
```
