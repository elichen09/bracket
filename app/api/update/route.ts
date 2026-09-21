import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { TabroomSession, syncTournament, statusFor } from "@/lib/tabroom";
import type { Tournament } from "@/lib/types";
import { eventForBracket, bracketResultId } from "@/lib/tabroomApi";
import { ingestTournament, recompute } from "@/lib/ratings";
import { CIRCUITS, CIRCUIT_IDS } from "@/lib/circuit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET/POST /api/update — pulls fresh results from Tabroom into every unfinished
// tournament. The GitHub Action in .github/workflows/update.yml calls this hourly
// (Vercel Hobby only allows daily crons). Guarded by UPDATE_SECRET, passed as a
// Bearer token, an x-update-secret header, or ?secret=. The admin's "force update"
// button instead sends { adminKey } in a POST body, checked against ADMIN_KEY.
async function handle(req: Request) {
  const secret = process.env.UPDATE_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") || "";
    const hdr = req.headers.get("x-update-secret") || "";
    const qs = new URL(req.url).searchParams.get("secret") || "";
    const okSecret = auth === `Bearer ${secret}` || hdr === secret || qs === secret;
    let adminKey = "";
    if (req.method === "POST") {
      try { adminKey = String((await req.clone().json())?.adminKey || ""); } catch {}
    }
    const okAdmin = !!process.env.ADMIN_KEY && adminKey === process.env.ADMIN_KEY;
    if (!okSecret && !okAdmin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!process.env.TABROOM_USERNAME || !process.env.TABROOM_PASSWORD) {
    return NextResponse.json({ error: "TABROOM_USERNAME / TABROOM_PASSWORD are not set" }, { status: 500 });
  }

  const db = supabaseAdmin();
  const { data: rows, error } = await db.from("tournaments").select("*")
    .neq("status", "complete").order("sort_order");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const tournaments = (rows || []) as Tournament[];
  const session = new TabroomSession(process.env.TABROOM_USERNAME, process.env.TABROOM_PASSWORD);
  const summary: string[] = [];

  for (const t of tournaments) {
    if (!t.tabroom_tourn_id) { summary.push(`${t.name}: no tabroom ids`); continue; }
    // A pool added mid-tournament has no bracket link, because there was no
    // bracket to link to. Ask Tabroom for one each time until it has posted it.
    let resultId = t.tabroom_result_id;
    if (!resultId && t.tabroom_event_abbr) {
      resultId = await bracketResultId(t.tabroom_tourn_id, t.tabroom_event_abbr);
      if (resultId) {
        await db.from("tournaments").update({ tabroom_result_id: resultId }).eq("id", t.id);
        summary.push(`${t.name}: bracket posted, result_id ${resultId}`);
      }
    }
    if (!resultId) { summary.push(`${t.name}: no bracket published yet`); continue; }
    try {
      const out = await syncTournament(session, {
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
      await db.from("tournaments").update(patch).eq("id", t.id);
      summary.push(`${t.name}: ${out.changed ? out.log.join("; ") : "no change"}`);
    } catch (e: any) {
      summary.push(`${t.name}: ERROR ${e?.message || e}`);
    }
  }

  // Ratings. Every tracked event is re-indexed and Glicko-2 recomputed, so the
  // rankings follow results in as tournaments finish. Rounds are upserted, so a
  // tournament that has not changed costs reads and writes nothing new.
  try {
    const { data: all } = await db.from("tournaments").select("id,name,tabroom_tourn_id,tabroom_result_id,tabroom_event_abbr");
    let ingested = 0;
    for (const row of all || []) {
      if (!row.tabroom_tourn_id) continue;
      let abbr: string | null = row.tabroom_event_abbr ?? null;
      if (!abbr && row.tabroom_result_id) {
        // older tournaments are identified by their bracket; learn the event once and remember it
        const ev = await eventForBracket(row.tabroom_tourn_id, row.tabroom_result_id);
        abbr = ev?.abbr ?? null;
        if (abbr) await db.from("tournaments").update({ tabroom_event_abbr: abbr, tabroom_event_id: ev?.id ?? null }).eq("id", row.id);
      }
      if (!abbr) { summary.push(`ratings ${row.name}: no Tabroom event on file`); continue; }
      try {
        const r = await ingestTournament(db, row.tabroom_tourn_id, abbr);
        ingested += r.rows;
        summary.push(`ratings ${row.name}: ${r.rows} rounds from ${r.entries} entries`);
      } catch (e: any) {
        summary.push(`ratings ${row.name}: ${e?.message || e}`);
      }
    }
    if (ingested) {
      // Each circuit is its own standing, so each is rebuilt on its own rounds.
      for (const circuit of CIRCUIT_IDS) {
        const r = await recompute(db, undefined, circuit);
        summary.push(`ratings ${CIRCUITS[circuit].short}: ${r.teams} partnerships and ${r.debaters} debaters over ${r.periods} tournaments`);
      }
    }
  } catch (e: any) {
    summary.push(`ratings: ERROR ${e?.message || e}`);
  }

  return NextResponse.json({ ok: true, checked: tournaments.length, summary });
}

export const GET = handle;
export const POST = handle;
