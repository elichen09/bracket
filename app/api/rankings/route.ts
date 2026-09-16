import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { currentUser } from "@/lib/auth";
import { loadRatings } from "@/lib/ratings";
import { conservative } from "@/lib/glicko";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/rankings?kind=team|debater  -> the Glicko-2 table, strongest first.
//
// `floor` is the conservative end of each rating interval: it is what a
// competitor can defend, so an unproven 1800 sits below a proven 1700. The table
// leads on rating but exposes both, and only counts competitors with real games.
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "sign in required" }, { status: 401 });

  const kind = new URL(req.url).searchParams.get("kind") === "debater" ? "debater" : "team";
  try {
    const db = supabaseAdmin();
    const rows = await loadRatings(db, kind);
    // when the table last changed, so the page can say how fresh it is
    const { data: stamp } = await db.from("ratings").select("updated_at").eq("kind", kind)
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    const table = rows
      .filter((r) => r.games > 0)
      .map((r, i) => ({
        rank: i + 1,
        key: r.key,
        display: r.display,
        school: r.school,
        rating: Math.round(r.rating),
        rd: Math.round(r.rd),
        floor: Math.round(conservative(r)),
        games: r.games,
        wins: r.wins,
        losses: r.losses,
        tournaments: r.tournaments,
        pointsAvg: r.points_avg === null ? null : Math.round(r.points_avg * 10) / 10,
        pointsZ: r.points_z,
        lastPlayed: r.last_played,
        history: r.history,
      }));
    return NextResponse.json({ kind, count: table.length, updatedAt: stamp?.updated_at ?? null, rankings: table });
  } catch (e: any) {
    const msg = String(e?.message || e);
    const hint = /ratings/.test(msg) ? " — run supabase/migrations/004_ratings.sql" : "";
    return NextResponse.json({ error: msg + hint }, { status: 500 });
  }
}
