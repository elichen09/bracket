# The Break

Tools for a debate round, in one window. Built with Next.js + Supabase; deploys
to Vercel (or anywhere that runs Next).

- **Round Magic** (`/tools/magic`) — cut cards by key, search your library and
  this season's openCaselist as you type, build the speech doc (alone, or with
  your partner in a room), open the other team's docs off SpeechDrop, read it
  back timed. Any file can be **shared by link**: whoever opens the link edits
  it with you, live, the way a Google Doc works.
- **Flow** and **Doc flow** — flow the round on a grid or in a document, with
  your partner in the same flow.
- **Past flows**, **Split screen**, and a **Tutorial** that explains all of it.

Everything a tool makes is kept in the browser it was made in (IndexedDB and
localStorage, apart per account). The server holds accounts, the weekly
caselist index, and — only for a file someone has shared — that file.

The front page is public; everything else needs a sign-in (email + password,
no confirmation email). The tools themselves open with the admin key, except
for a link someone was sent: a room, a SpeechDrop, or a shared file.

---

## 1. Create the Supabase project

1. Make a project at [supabase.com](https://supabase.com).
2. In **SQL Editor**, run `supabase/schema.sql`. (The schema still carries the
   tables of the bracket pools this site used to be; the caselist search reads
   the team ratings in them to put the strongest teams first, and nothing else
   uses them.)
3. In **Authentication → Providers**, leave Email enabled. Accounts are created
   server-side with the service role and auto-confirmed, so the confirmation-email
   setting doesn't matter and Supabase's mail rate limits never bite.
4. From **Project Settings → API**, copy the Project URL, the `anon` public key,
   and the `service_role` secret key.

Two private Storage buckets are made by the site the first time they are
needed: `caselist` (the weekly tag indexes) and `shared-docs` (files shared by
link).

## 2. Configure environment

Copy `.env.example` to `.env.local` and fill it in:

| var | what it is |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public key (browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key (server only) |
| `ADMIN_KEY` | passphrase that opens the tools |
| `UPDATE_SECRET` | shared secret the caselist indexer must send |
| `TABROOM_USERNAME` / `TABROOM_PASSWORD` | a Tabroom account — openCaselist signs in with it |

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
4. The caselist index is rebuilt by the included GitHub Action
   (`.github/workflows/caselist-index.yml`), daily, when openCaselist's weekly
   archive is newer than the index. In the GitHub repo, add **Settings → Secrets
   and variables → Actions** secrets `SITE_URL` (your deployed URL) and
   `UPDATE_SECRET` (same value as the app's env var).

## Layout

```
app/                 the front page, sign-in, and a page per tool under app/tools
app/api/tools/       caselist (index, cards, ranks), speechdrop, share
components/tools/    the tools: RoundMagic, Flow, DocFlow, … and their stylesheets
lib/cutter/          Round Magic's files, keys, commands, and sharing a file
lib/evidence/        the library and the speech doc (the engine Round Magic mounts)
lib/caselist/        the caselist index: loading, searching (in a worker), polarity
lib/flow, lib/docflow  the two flows, and the rooms they share
scripts/             the caselist indexer the GitHub Action runs
```
