import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { findPublicForumEvents, archiveTournament } from "@/lib/archive";
import { recompute, loadRatings, canonCode } from "@/lib/ratings";
import { CIRCUITS, CIRCUIT_IDS, isCollegeTournament, withCollegeOverride, type Circuit } from "@/lib/circuit";
import { loadCircuitOverrides, saveCollegeOverride } from "@/lib/circuitStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/rankings/update   { op: "preview" | "run", ref, circuit }   — admin only
 *
 * A tournament, pasted as any Tabroom link or id, into one ranking.
 *
 *   preview   what would be read: the tournament, the divisions that count for
 *             that ranking, and how many of its rounds are in already
 *   run       read those rounds, rebuild that ranking, and say who moved
 *
 * Choosing "College policy" for a tournament not on the college list (or
 * "Policy" for one that is) is remembered for that tournament — without that,
 * the next rebuild would put its rounds back where the name says.
 */

const ref = (raw: unknown): number | string | null => {
  const s = String(raw || "").trim();
  const m = s.match(/tourn_id=(\d+)/) || s.match(/^(\d{3,7})$/);
  if (m) return Number(m[1]);
  const w = s.match(/^[a-z0-9_-]{2,40}$/i);           // a webname, as the archive takes
  return w ? s : null;
};

/** What reading this tournament into this ranking would take — and whether its college status must be said. */
async function look(r: number | string, circuit: Circuit) {
  const first = await findPublicForumEvents(r);
  if (!first) return null;
  const college = isCollegeTournament(first.name);
  // the ranking chosen outranks what the name implies, for policy
  // (Public Forum and Lincoln-Douglas name themselves; only policy is split by where it was debated)
  const say: boolean | null = circuit === "cx" && !college ? true : circuit === "policy" && college ? false : null;
  const found = say === null ? first : await withCollegeOverride(first.name, say, () => findPublicForumEvents(r));
  const events = (found?.events || []).filter((e) => e.circuit === circuit).map((e) => ({ abbr: e.abbr, name: e.name }));
  return { tourn: { id: first.tournId, name: first.name, start: first.start }, events, say, circuits: first.circuits };
}

export async function POST(req: Request) {
  if (!isAdmin()) return NextResponse.json({ error: "the admin key is needed to change the rankings" }, { status: 403 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const r = ref(body?.ref);
  const circuit = body?.circuit as Circuit;
  if (!r) return NextResponse.json({ error: "paste a Tabroom link with a tourn_id, or the tournament's id" }, { status: 400 });
  if (!CIRCUIT_IDS.includes(circuit)) return NextResponse.json({ error: "which ranking?" }, { status: 400 });

  const db = supabaseAdmin();
  try {
    await loadCircuitOverrides(db);
    const seen = await look(r, circuit);
    if (!seen) return NextResponse.json({ error: "Tabroom has no tournament by that" }, { status: 404 });
    const { count } = await db.from("rating_games").select("tourn_id", { count: "exact", head: true }).eq("tourn_id", seen.tourn.id);

    if (body?.op !== "run") return NextResponse.json({ ...seen, already: count || 0 });

    if (!seen.events.length) {
      return NextResponse.json({ error: `${seen.tourn.name} has no ${CIRCUITS[circuit].label} division with published results` }, { status: 400 });
    }
    if (seen.say !== null) await saveCollegeOverride(db, seen.tourn.name, seen.say);

    // where everyone stood, to say who moved
    const kind = CIRCUITS[circuit].teamKind;
    const standing = (rows: Awaited<ReturnType<typeof loadRatings>>) => {
      const m = new Map<string, { rank: number; rating: number; display: string }>();
      rows.filter((x) => x.games > 0).forEach((x, i) => m.set(canonCode(x.display || x.key), { rank: i + 1, rating: Math.round(x.rating), display: x.display || x.key }));
      return m;
    };
    const before = standing(await loadRatings(db, kind));

    const read = await archiveTournament(db, seen.tourn.id, circuit);
    if (read.error) return NextResponse.json({ error: read.error }, { status: 502 });
    const rebuilt = await recompute(db, undefined, circuit);
    const after = standing(await loadRatings(db, kind));

    // the teams that debated there, and where they went
    const { data: played } = await db.from("rating_games").select("code").eq("tourn_id", seen.tourn.id);
    const codes = [...new Set((played || []).map((g) => canonCode(g.code)))];
    const moved = codes.map((c) => {
      const a = after.get(c), b = before.get(c);
      return a ? { team: a.display, rank: a.rank, was: b ? b.rank : null, rating: a.rating, change: b ? a.rating - b.rating : null } : null;
    }).filter(Boolean).sort((x, y) => x!.rank - y!.rank);

    return NextResponse.json({
      tourn: seen.tourn, circuit, events: read.events, rounds: read.rows, entries: read.entries,
      rated: rebuilt.teams, games: rebuilt.games, remembered: seen.say, moved,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
