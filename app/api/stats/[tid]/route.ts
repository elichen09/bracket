import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { currentUser } from "@/lib/auth";
import { teamStats, withFreshData } from "@/lib/tabroomApi";
import { parseSlot } from "@/lib/bracket";
import { careersDeep } from "@/lib/careerArchive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/stats/:tid?code=Emory%20GY -> compiled Tabroom statistics for one team
// in that tournament's event. Public data, but the site needs a login.
export async function GET(req: Request, { params }: { params: { tid: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const url = new URL(req.url);
  const code = (url.searchParams.get("code") || "").trim();
  // ?fresh=1 — a person asked for a re-pull: ignore every cache (API documents,
  // career records in memory and in Supabase) and write the new answers back.
  const fresh = url.searchParams.get("fresh") === "1";
  if (!code) return NextResponse.json({ error: "code is required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: t } = await db.from("tournaments").select("id,tabroom_tourn_id,tabroom_result_id,status,slots").eq("id", params.tid).maybeSingle();
  if (!t) return NextResponse.json({ error: "no such tournament" }, { status: 404 });
  if (!t.tabroom_tourn_id || !t.tabroom_result_id) return NextResponse.json({ error: "this tournament isn't linked to Tabroom" }, { status: 404 });

  try {
    const live = t.status !== "complete";
    const seeds: Record<string, number> = {};
    for (const slot of (t.slots || []) as string[]) { const team = parseSlot(slot); if (team && team.seed) seeds[team.name] = team.seed; }
    const stats = fresh
      ? await withFreshData(() => teamStats(t.tabroom_tourn_id, t.tabroom_result_id, code, { live, seeds }))
      : await teamStats(t.tabroom_tourn_id, t.tabroom_result_id, code, { live, seeds });
    // Careers come from the tournaments this site has read in through Tabroom's
    // public API. Nothing is scraped and nothing needs a login, so this cannot be
    // throttled out — it is only ever as deep as the archive is.
    try {
      const careers = await careersDeep(db, stats.students.map((st) => st.id));
      for (const st of stats.students) {
        const rec = careers.get(st.id);
        if (rec && !rec.empty) stats.career[String(st.id)] = rec;
      }
      if (!Object.keys(stats.career).length) {
        stats.careerNote = "no archived rounds for these debaters yet — records fill in as past tournaments are read in";
      }
    } catch (e: any) {
      stats.careerNote = e?.message || "could not load career records";
    }
    const res = NextResponse.json(stats);
    // the same document for every viewer — let the edge hold it a while
    res.headers.set("cache-control", fresh ? "no-store" : live ? "private, max-age=120" : "private, max-age=3600");
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "could not load statistics" }, { status: 502 });
  }
}
