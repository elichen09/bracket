import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { TabroomSession, syncTournament, statusFor } from "@/lib/tabroom";
import { bracketResultId } from "@/lib/tabroomApi";
import type { Tournament } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/tournaments/:id/sync  { adminKey }
 *
 * Pulls this one tournament's results from Tabroom, now.
 *
 * The hourly job does the same for everything, and takes long enough doing it —
 * every tracked event re-indexed, every circuit's ratings rebuilt — that it is
 * the wrong thing to reach for while a round is being watched. An elim takes
 * twenty minutes and the results land when they land; waiting up to an hour for
 * the site to notice, on a page where the bracket is the whole point, is the
 * difference between following a tournament and reading about it afterwards.
 *
 * So this is the narrow version: one tournament, its bracket and its rounds, no
 * ratings. Same admin key as the rest of the pool controls.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!process.env.ADMIN_KEY || body?.adminKey !== process.env.ADMIN_KEY) {
    return NextResponse.json({ error: "wrong admin key" }, { status: 403 });
  }
  if (!process.env.TABROOM_USERNAME || !process.env.TABROOM_PASSWORD) {
    return NextResponse.json({ error: "TABROOM_USERNAME / TABROOM_PASSWORD are not set" }, { status: 500 });
  }

  const db = supabaseAdmin();
  const { data } = await db.from("tournaments").select("*").eq("id", params.id).maybeSingle();
  if (!data) return NextResponse.json({ error: "no such tournament" }, { status: 404 });
  const t = data as Tournament;
  if (!t.tabroom_tourn_id) return NextResponse.json({ error: "this tournament isn't linked to Tabroom" }, { status: 400 });

  // Same as the hourly job: a pool registered before its bracket existed learns
  // the bracket here, the first time Tabroom publishes one.
  let resultId = t.tabroom_result_id;
  if (!resultId && t.tabroom_event_abbr) {
    resultId = await bracketResultId(t.tabroom_tourn_id, t.tabroom_event_abbr);
    if (resultId) await db.from("tournaments").update({ tabroom_result_id: resultId }).eq("id", t.id);
  }
  if (!resultId) return NextResponse.json({ ok: true, log: ["Tabroom hasn't published a bracket for this event yet."], changed: false });

  try {
    const out = await syncTournament(new TabroomSession(process.env.TABROOM_USERNAME, process.env.TABROOM_PASSWORD), {
      tournId: t.tabroom_tourn_id,
      resultId,
      slots: t.slots || [],
      results: t.results || {},
      roundIds: t.round_ids || {},
    });
    const patch: Record<string, unknown> = { last_checked_at: new Date().toISOString() };
    if (out.changed) {
      patch.results = out.results;
      patch.round_ids = out.roundIds;
      patch.notes = { ...(t.notes || {}), ...out.notes };
      patch.status = statusFor(t, out);
      if (!t.slots?.length && out.slots.length) patch.slots = out.slots;
    }
    const { error } = await db.from("tournaments").update(patch).eq("id", t.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, changed: out.changed, log: out.log });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 502 });
  }
}
