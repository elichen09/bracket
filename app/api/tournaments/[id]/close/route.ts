import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tournaments/:id/close  { adminKey, open?, at? }
 *
 * Closes a pool by hand: every bracket in it is locked at once, whether or not
 * its owner remembered to lock it.
 *
 * Picks already stop counting once Tabroom decides a match, so this is not what
 * keeps the scoring honest — it is the whistle. A pool has a moment when entries
 * shut, and that moment is a judgement call: the bracket is posted, the room has
 * seen it, nobody else should be typing. Waiting for the first ballot is too
 * late, and there is no time on the clock to automate it against.
 *
 * `open: true` is the same control in reverse, and stands on its own: a pool shut
 * too early, or one whose bracket Tabroom then redrew, has to be openable hours
 * later from a fresh page. A close stamps every bracket it touches with the same
 * `locked_at`, so passing that timestamp back as `at` reopens exactly the
 * brackets that close shut and leaves alone anyone who had locked their own
 * beforehand. Without it, opening unlocks the whole pool.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!process.env.ADMIN_KEY || body?.adminKey !== process.env.ADMIN_KEY) {
    return NextResponse.json({ error: "wrong admin key" }, { status: 403 });
  }

  const db = supabaseAdmin();
  const { data: t } = await db.from("tournaments").select("id,name").eq("id", params.id).maybeSingle();
  if (!t) return NextResponse.json({ error: "no such tournament" }, { status: 404 });

  if (body?.open === true) {
    const at = typeof body?.at === "string" ? body.at : null;
    let q = db.from("entries").update({ locked: false, locked_at: null })
      .eq("tournament_id", params.id).eq("locked", true);
    // Without a timestamp this reopens every bracket in the pool, including any
    // locked by its own owner — so the caller says which close it is undoing.
    if (at) q = q.eq("locked_at", at);
    const { data, error } = await q.select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, open: true, count: (data || []).length });
  }

  const at = new Date().toISOString();
  const { data, error } = await db.from("entries")
    .update({ locked: true, locked_at: at })
    .eq("tournament_id", params.id).eq("locked", false)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, closed: true, at, count: (data || []).length });
}
