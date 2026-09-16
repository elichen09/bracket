import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { currentUser } from "@/lib/auth";
import { fieldWithRatings } from "@/lib/field";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/field/:tid -> every entry in the tournament, with what the ratings
// know about it. This is what a tournament page shows before a bracket exists.
export async function GET(_req: Request, { params }: { params: { tid: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "sign in required" }, { status: 401 });

  const db = supabaseAdmin();
  const { data: t } = await db.from("tournaments")
    .select("id,name,event,tabroom_tourn_id,tabroom_event_abbr,status")
    .eq("id", params.tid).maybeSingle();
  if (!t) return NextResponse.json({ error: "no such tournament" }, { status: 404 });
  if (!t.tabroom_tourn_id || !t.tabroom_event_abbr) {
    return NextResponse.json({ error: "this tournament has no Tabroom event on file, so its entries cannot be listed" }, { status: 404 });
  }

  try {
    const { entries } = await fieldWithRatings(db, t.tabroom_tourn_id, t.tabroom_event_abbr);
    const rated = entries.filter((e) => e.rating !== null).length;
    const res = NextResponse.json({
      tournament: { id: t.id, name: t.name, event: t.event },
      count: entries.length,
      rated,
      entries: entries.slice().sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.code.localeCompare(b.code)),
    });
    res.headers.set("cache-control", "private, max-age=300");
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "could not load the field" }, { status: 502 });
  }
}
