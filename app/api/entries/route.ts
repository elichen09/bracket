import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { model, cleanPicks, prune, entriesClosed } from "@/lib/bracket";
import { shortId } from "@/lib/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/entries  { tournamentId, name } -> create a new bracket, returns { id, token }
export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const tournamentId = String(body?.tournamentId || "");
  const name = String(body?.name || "").trim().slice(0, 24);
  if (!tournamentId || !name) return NextResponse.json({ error: "tournamentId and name are required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: t } = await db.from("tournaments").select("id,slots,results,locked_rounds").eq("id", tournamentId).single();
  if (!t) return NextResponse.json({ error: "no such tournament" }, { status: 404 });

  const M = model(t as any);
  if (entriesClosed(M)) {
    return NextResponse.json({ error: "brackets are closed — first-round results are already in" }, { status: 403 });
  }
  let picks = cleanPicks(body?.picks, 64);
  picks = prune(M, picks);

  // retry a couple of times on the vanishingly rare id collision
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = shortId();
    const { data, error } = await db.from("entries")
      .insert({ id, tournament_id: tournamentId, name, picks, locked: false })
      .select("id,token").single();
    if (!error && data) return NextResponse.json({ id: data.id, token: data.token });
    if (error && !String(error.message).includes("duplicate")) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  return NextResponse.json({ error: "could not allocate an id" }, { status: 500 });
}
