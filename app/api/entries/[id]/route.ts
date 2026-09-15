import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { model, cleanPicks, prune, illegalChanges } from "@/lib/bracket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /api/entries/:id  { tournamentId, token, name?, picks?, lock? }
// The token proves ownership. A locked bracket, and any match already decided,
// can no longer be changed.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const tournamentId = String(body?.tournamentId || "");
  const token = String(body?.token || "");
  if (!tournamentId || !token) return NextResponse.json({ error: "tournamentId and token are required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: entry } = await db.from("entries")
    .select("id,picks,locked,token").eq("tournament_id", tournamentId).eq("id", params.id).single();
  if (!entry) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (entry.token !== token) return NextResponse.json({ error: "wrong token" }, { status: 403 });
  if (entry.locked) return NextResponse.json({ error: "this bracket is locked" }, { status: 409 });

  const { data: t } = await db.from("tournaments").select("slots,results,locked_rounds").eq("id", tournamentId).single();
  if (!t) return NextResponse.json({ error: "no such tournament" }, { status: 404 });
  const M = model(t as any);

  const update: Record<string, unknown> = {};
  if (typeof body.name === "string") {
    const n = body.name.trim().slice(0, 24);
    if (n) update.name = n;
  }
  if (body.picks && typeof body.picks === "object") {
    let picks = prune(M, cleanPicks(body.picks, 64));
    // a caller can't rewrite the winner of a match Tabroom has already decided
    const bad = illegalChanges(M, entry.picks || {}, picks);
    if (bad.length) {
      const keep = entry.picks || {};
      for (const k of bad) { if (keep[k] === undefined) delete picks[k]; else picks[k] = keep[k]; }
    }
    update.picks = picks;
  }
  if (body.lock === true) { update.locked = true; update.locked_at = new Date().toISOString(); }

  if (!Object.keys(update).length) return NextResponse.json({ ok: true, nochange: true });

  const { error } = await db.from("entries").update(update)
    .eq("tournament_id", tournamentId).eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, locked: update.locked === true });
}
