import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { currentUser } from "@/lib/auth";
import { teamStats, withFreshData } from "@/lib/tabroomApi";
import { parseSlot } from "@/lib/bracket";
import { careerFor } from "@/lib/career";

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
    // Careers: one logged-in Tabroom page per debater, cached 12h. A failure here
    // (Tabroom login trouble, rate limit) must not take the rest of the dossier down.
    const results = await Promise.allSettled(stats.students.map((st) => careerFor(db, st.id, fresh)));
    results.forEach((r, i) => { if (r.status === "fulfilled") stats.career[String(stats.students[i].id)] = r.value; });
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length) stats.careerNote = failed[0].reason?.message || "could not load career records";
    const res = NextResponse.json(stats);
    // the same document for every viewer — let the edge hold it a while
    res.headers.set("cache-control", fresh ? "no-store" : live ? "private, max-age=120" : "private, max-age=3600");
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "could not load statistics" }, { status: 502 });
  }
}
