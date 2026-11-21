import { NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { currentUser, displayName } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { withCors, preflight, fromApp, SHARE_HEADER } from "@/lib/appRequests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shared docs — a file of Round Magic's that more than one person edits.
 *
 * A shared doc works the way a Google Doc with link sharing does: whoever is
 * signed in and has the link can open it and edit it, everyone in it at once
 * sees everyone else's typing, and it is still there when its owner is not.
 * The typing itself goes between the browsers (lib/cutter/share.ts, a Yjs
 * document over a realtime channel); what is kept here is the document, so a
 * link opens to the doc whoever else is or is not around.
 *
 * It is kept in a private storage bucket, one object per doc — the Yjs state,
 * which merges, so two saves crossing lose nothing — with a small note beside
 * it: the title, and whose it is. The link's id is the key: over 130 random bits,
 * not guessable, and not listed anywhere.
 *
 *   POST { op: "create", title }   a new shared doc: { id }
 *   GET  ?id=                      { title, owner, mine, url } — url a short-lived link to its state, or null before the first save
 *   POST { op: "save", id, title } { url } — a short-lived link to PUT its state to
 *   POST { op: "stop", id }        its owner stops sharing it: the doc is deleted here (every copy already opened is kept where it was opened)
 *
 * The desktop app has no account. From the app, the link alone opens a doc
 * and saves to it — "anyone with the link", which is what the 130-bit id
 * already is. A doc the app shares is owned by a key the app makes and keeps
 * (sent as SHARE_HEADER, or as `key` on create); only a hash of it is kept
 * here, and only that key, or the account that shared it, can stop it.
 * New shares without an account are limited per address.
 */

const BUCKET = "shared-docs";
const ID = /^[a-z0-9]{20,40}$/;
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** An owner that is a key, not an account: kept as a hash. */
const keyOwner = (key: string) => "key:" + createHash("sha256").update(key).digest("hex");
const goodKey = (k: unknown): k is string => typeof k === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(k);

/** Whoever is asking: the signed-in account, or the app (no account) with or without its owner key. */
async function who(req: Request): Promise<{ owner: string | null; name: string } | null> {
  const user = await currentUser();
  if (user) return { owner: user.id, name: displayName(user) };
  if (!fromApp(req)) return null;
  const k = req.headers.get(SHARE_HEADER) || "";
  return { owner: goodKey(k) ? keyOwner(k) : null, name: "" };
}

// new shares without an account, per address, per hour (one server instance's count: a brake, not a wall)
const made = new Map<string, number[]>();
function tooMany(req: Request): boolean {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?";
  const now = Date.now(), hour = 3600_000;
  const list = (made.get(ip) || []).filter((t) => now - t < hour);
  if (list.length >= 30) { made.set(ip, list); return true; }
  list.push(now); made.set(ip, list);
  if (made.size > 5000) made.clear();
  return false;
}

export async function OPTIONS(req: Request) {
  return preflight(req);
}

interface Note { title: string; owner: string; ownerName: string; created: string; updated?: string }

let bucketMade = false;
async function bucket() {
  const db = supabaseAdmin();
  if (bucketMade) return db;
  const { data } = await db.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await db.storage.createBucket(BUCKET, { public: false, fileSizeLimit: "50MB" });
    if (error && !/exists/i.test(error.message)) throw new Error("storage: " + error.message);
  }
  bucketMade = true;
  return db;
}

async function note(db: ReturnType<typeof supabaseAdmin>, id: string): Promise<Note | null> {
  const { data, error } = await db.storage.from(BUCKET).download(`${id}.json`);
  if (error || !data) return null;
  try { return JSON.parse(await data.text()) as Note; } catch { return null; }
}
const putNote = (db: ReturnType<typeof supabaseAdmin>, id: string, n: Note) =>
  db.storage.from(BUCKET).upload(`${id}.json`, JSON.stringify(n), { contentType: "application/json", upsert: true });

export async function GET(req: Request) {
  return withCors(req, await get(req));
}
async function get(req: Request) {
  const me = await who(req);
  if (!me) return bad("sign in required", 401);
  const id = String(new URL(req.url).searchParams.get("id") || "");
  if (!ID.test(id)) return bad("which doc?");
  try {
    const db = await bucket();
    const n = await note(db, id);
    if (!n) return bad("That doc is not shared any more", 404);
    const { data } = await db.storage.from(BUCKET).createSignedUrl(`${id}.bin`, 120);
    // a doc shared but not yet saved has a note and no state: the link is checked, not assumed
    let url: string | null = data?.signedUrl || null;
    if (url) { const { data: there } = await db.storage.from(BUCKET).list("", { search: `${id}.bin`, limit: 1 }); if (!there?.length) url = null; }
    return NextResponse.json({ title: n.title, owner: n.ownerName, mine: !!me.owner && n.owner === me.owner, url });
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 502);
  }
}

export async function POST(req: Request) {
  return withCors(req, await post(req));
}
async function post(req: Request) {
  const me = await who(req);
  if (!me) return bad("sign in required", 401);
  let body: { op?: string; id?: string; title?: string; key?: string; name?: string };
  try { body = await req.json(); } catch { return bad("what?"); }
  const title = String(body.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
  try {
    const db = await bucket();
    if (body.op === "create") {
      // the app: owned by the key it made, named as it says
      let owner = me.owner, ownerName = me.name;
      if (!me.name) {
        if (!goodKey(body.key)) return bad("a key is needed to share from the app");
        if (tooMany(req)) return bad("Too many new shares from here — try again in a while", 429);
        owner = keyOwner(body.key);
        ownerName = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
      }
      const id = BigInt("0x" + randomBytes(17).toString("hex")).toString(36).padStart(26, "0").slice(0, 26);
      const { error } = await putNote(db, id, { title: title || "Shared doc", owner: owner!, ownerName, created: new Date().toISOString() });
      if (error) throw new Error("storage: " + error.message);
      return NextResponse.json({ id });
    }
    const id = String(body.id || "");
    if (!ID.test(id)) return bad("which doc?");
    const n = await note(db, id);
    if (!n) return bad("That doc is not shared any more", 404);
    if (body.op === "save") {
      if (title && title !== n.title) await putNote(db, id, { ...n, title, updated: new Date().toISOString() });
      const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(`${id}.bin`, { upsert: true });
      if (error || !data) throw new Error("storage: " + (error?.message || "no upload link"));
      return NextResponse.json({ url: data.signedUrl });
    }
    if (body.op === "stop") {
      if (!me.owner || n.owner !== me.owner) return bad("Only whoever shared it can stop sharing it", 403);
      await db.storage.from(BUCKET).remove([`${id}.bin`, `${id}.json`]);
      return NextResponse.json({ ok: true });
    }
    return bad("unknown op");
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 502);
  }
}
