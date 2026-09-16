import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { archiveMany, findPublicForumEvents, isArchived } from "@/lib/archive";
import { recompute } from "@/lib/ratings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Read past tournaments into the ratings store, through Tabroom's public API.
 *
 * Past rounds are what the prediction's prior and the head-to-head record are
 * built from. They never reach the season leaderboard, which counts this season
 * only — so archiving 2024 changes what a prediction expects without changing
 * anyone's standing.
 *
 * GET  /api/archive                 -> which tournaments have been read in
 * POST /api/archive { adminKey, refs: ["yale", 33000, …] }
 *
 * `refs` are Tabroom tournament ids or webnames. A handful at a time: each one
 * costs a request per entry, and this runs inside a single web request.
 */
export async function GET() {
  const db = supabaseAdmin();
  const { data, error } = await db.from("rating_games").select("tourn_id,tourn_name,tourn_start,event_name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const seen = new Map<number, { name: string; start: string | null; events: Set<string>; rounds: number }>();
  for (const g of data || []) {
    const row = seen.get(g.tourn_id) || { name: g.tourn_name, start: g.tourn_start, events: new Set<string>(), rounds: 0 };
    row.events.add(g.event_name);
    row.rounds++;
    seen.set(g.tourn_id, row);
  }
  const tournaments = [...seen.entries()]
    .map(([tournId, r]) => ({ tournId, name: r.name, start: r.start, events: [...r.events], rounds: r.rounds, listed: !!isArchived(r.name) }))
    .sort((a, b) => String(b.start).localeCompare(String(a.start)));
  return NextResponse.json({ count: tournaments.length, tournaments });
}

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!process.env.ADMIN_KEY || body?.adminKey !== process.env.ADMIN_KEY) {
    return NextResponse.json({ error: "wrong admin key" }, { status: 403 });
  }
  const refs: (number | string)[] = Array.isArray(body?.refs) ? body.refs.slice(0, 8) : [];
  if (!refs.length) return NextResponse.json({ error: "give refs: Tabroom tournament ids or webnames" }, { status: 400 });

  const db = supabaseAdmin();
  try {
    // A quick look first, so a mistyped name is reported before anything is read.
    const checks = await Promise.all(refs.map((r) => findPublicForumEvents(r)));
    const missing = refs.filter((_, i) => !checks[i]);
    if (missing.length) return NextResponse.json({ error: `not found on Tabroom: ${missing.join(", ")}` }, { status: 400 });

    // The archive is a named list rather than whatever could be read. Past rounds
    // are here to give a team a prior, so a district qualifier is weight on results
    // that were never the point. `force` reads one anyway.
    if (!body?.force) {
      const offList = checks.filter((c) => c && !isArchived(c.name)).map((c) => c!.name);
      if (offList.length) {
        return NextResponse.json({
          error: `not on the archive list: ${offList.join(", ")} — add it to ARCHIVED_TOURNAMENTS in lib/archive.ts, or send force: true to read it anyway`,
        }, { status: 400 });
      }
    }

    const results = await archiveMany(db, refs);
    const rated = await recompute(db);
    return NextResponse.json({
      archived: results,
      rounds: results.reduce((n, r) => n + r.rows, 0),
      leaderboard: { partnerships: rated.teams, roundsThisSeason: rated.games, olderRoundsIgnored: rated.skippedSeasons },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "could not archive" }, { status: 502 });
  }
}
