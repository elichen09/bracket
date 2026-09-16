import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { slug } from "@/lib/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/tournaments  { adminKey, name, event?, url, roundUrl?, slotsText? }
// Adds a tournament. Guarded by ADMIN_KEY so only the owner can add.
export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  if (!process.env.ADMIN_KEY || body?.adminKey !== process.env.ADMIN_KEY) {
    return NextResponse.json({ error: "wrong admin key" }, { status: 403 });
  }
  const name = String(body?.name || "").trim().slice(0, 60);
  const event = String(body?.event || "").trim().slice(0, 60);
  const url = String(body?.url || "");
  const tm = url.match(/tourn_id=(\d+)/);
  const rm = url.match(/result_id=(\d+)/);
  const eventAbbr = String(body?.eventAbbr || "").trim();
  if (!tm) return NextResponse.json({ error: "the Tabroom link needs a tourn_id" }, { status: 400 });
  if (!rm && !eventAbbr) {
    return NextResponse.json({ error: "give a bracket link with result_id, or — for a tournament that has not started — the Tabroom event code, e.g. VPF" }, { status: 400 });
  }

  // An upcoming tournament is identified by its event rather than by a bracket.
  // Check the event really exists before saving a row that could never load.
  let eventId: number | null = null;
  if (eventAbbr) {
    try {
      const r = await fetch(`https://api.tabroom.com/v1/rest/tourns/${tm[1]}/events/${encodeURIComponent(eventAbbr)}/field`, {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return NextResponse.json({ error: `Tabroom has no event "${eventAbbr}" at that tournament — the code is the short one Tabroom uses, like VPF or VLD` }, { status: 400 });
      const j = await r.json();
      eventId = typeof j?.id === "number" ? j.id : null;
    } catch {
      return NextResponse.json({ error: "could not reach Tabroom to check that event — try again" }, { status: 502 });
    }
  }
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const rid = String(body?.roundUrl || "").match(/round_id=(\d+)/);

  let slots: string[] = [];
  const raw = String(body?.slotsText || "").replace(/\r/g, "");
  if (raw.trim()) {
    slots = raw.split("\n").map((l) => l.trim());
    while (slots.length && !slots[slots.length - 1]) slots.pop();
    const n = slots.length;
    if (n < 4 || (n & (n - 1)) !== 0) return NextResponse.json({ error: `the list has ${n} lines — a bracket needs a power of two (byes as blank lines)` }, { status: 400 });
    const bad = slots.find((s) => s && !/^\d+\.\s*\S/.test(s));
    if (bad) return NextResponse.json({ error: `lines must look like "12. School AB": ${bad}` }, { status: 400 });
  }

  const db = supabaseAdmin();
  let id = slug(name) || `t${Date.now()}`;
  // ensure the slug is free
  const { data: existing } = await db.from("tournaments").select("id").eq("id", id).maybeSingle();
  if (existing) id = `${id}-${Math.random().toString(36).slice(2, 6)}`;

  const { count } = await db.from("tournaments").select("id", { count: "exact", head: true });

  const { error } = await db.from("tournaments").insert({
    id, name, event,
    tabroom_tourn_id: Number(tm[1]),
    tabroom_result_id: rm ? Number(rm[1]) : null,
    tabroom_event_abbr: eventAbbr || null,
    tabroom_event_id: eventId,
    round_ids: rid ? { "0": Number(rid[1]) } : {},
    slots,
    results: {},
    notes: {},
    status: slots.length ? "open" : "pending",
    sort_order: (count || 0) + 1,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id });
}
