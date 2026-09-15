import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { currentUser, displayName } from "@/lib/auth";
import { model, cleanPicks, prune, entriesClosed } from "@/lib/bracket";
import { shortId } from "@/lib/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/entries?tournamentId=…  -> { entry } — the caller's own bracket in that pool, or null.
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const tournamentId = new URL(req.url).searchParams.get("tournamentId") || "";
  if (!tournamentId) return NextResponse.json({ error: "tournamentId is required" }, { status: 400 });
  const db = supabaseAdmin();
  const { data, error } = await db.from("entries")
    .select("id,tournament_id,user_id,name,picks,locked,locked_at,created_at,updated_at")
    .eq("tournament_id", tournamentId).eq("user_id", user.id).maybeSingle();
  if (error) {
    const hint = /user_id/.test(error.message) ? " — run supabase/migrations/002_accounts_and_stats.sql" : "";
    return NextResponse.json({ error: error.message + hint }, { status: 500 });
  }
  return NextResponse.json({ entry: data || null, name: displayName(user) });
}

// POST /api/entries  { tournamentId, name?, picks? } -> creates the caller's one bracket for that tournament.
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const tournamentId = String(body?.tournamentId || "");
  const name = (String(body?.name || "").trim() || displayName(user)).slice(0, 24);
  if (!tournamentId) return NextResponse.json({ error: "tournamentId is required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: t } = await db.from("tournaments").select("id,slots,results,locked_rounds").eq("id", tournamentId).single();
  if (!t) return NextResponse.json({ error: "no such tournament" }, { status: 404 });

  const { data: existing } = await db.from("entries").select("id")
    .eq("tournament_id", tournamentId).eq("user_id", user.id).maybeSingle();
  if (existing) return NextResponse.json({ error: "you already have a bracket in this pool — one per person", id: existing.id }, { status: 409 });

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
      .insert({ id, tournament_id: tournamentId, user_id: user.id, name, picks, locked: false })
      .select("id").single();
    if (!error && data) return NextResponse.json({ id: data.id });
    if (error && /entries_one_per_user/.test(error.message)) {
      return NextResponse.json({ error: "you already have a bracket in this pool — one per person" }, { status: 409 });
    }
    if (error && !String(error.message).includes("duplicate")) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  return NextResponse.json({ error: "could not allocate an id" }, { status: 500 });
}
