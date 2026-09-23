import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/tools/speechdrop   { room, file }
 *
 * Puts the send document into a SpeechDrop room, which is where it was going
 * to be put by hand thirty seconds later anyway.
 *
 * It goes through here rather than straight from the page because a browser
 * will not post to speechdrop.net from this origin — no amount of client-side
 * cleverness gets round that — and because this way the room code and the
 * file are checked before anything is sent anywhere.
 *
 * SpeechDrop's own rules, from its source (github.com/yunyu/speechdrop,
 * SpeechDropApplication and room/Room.java): POST to /:roomid/upload as
 * multipart, it takes the first file in the body, the type has to be one it
 * allows, and ten megabytes is the limit. It answers with the room's index.
 *
 * KNOWN: speechdrop.net sits behind Cloudflare, and Cloudflare refuses a POST
 * that does not come from someone sitting on the site — 403, nine bytes,
 * "Forbidden", to this server and to a browser on another origin alike. There
 * is no way round that which is not an attempt to look like something we are
 * not, so this reports it and says what to do instead. Point SPEECHDROP_URL at
 * an instance that accepts uploads — a self-hosted one, the project is open
 * source — and the same code works.
 */

const SPEECHDROP = (process.env.SPEECHDROP_URL || "https://speechdrop.net").replace(/\/+$/, "");
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX = 10 * 1024 * 1024;
const ROOM = /^[a-z0-9]{2,16}$/i;

export async function POST(req: Request) {
  if (!isAdmin()) return NextResponse.json({ error: "the tools are locked" }, { status: 403 });

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "bad form" }, { status: 400 }); }

  // A code, or the link someone pasted instead of one.
  const room = String(form.get("room") || "").trim().replace(/^https?:\/\/[^/]+\//i, "").replace(/\/.*$/, "");
  const file = form.get("file");

  if (!ROOM.test(room)) return NextResponse.json({ error: `"${room}" is not a room code` }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "no file" }, { status: 400 });
  if (file.size > MAX) {
    return NextResponse.json({ error: `that document is ${(file.size / 1048576).toFixed(1)}MB and SpeechDrop takes 10MB` }, { status: 400 });
  }

  const out = new FormData();
  out.append("file", new File([await file.arrayBuffer()], file.name || "send.docx", { type: DOCX }));

  let res: Response;
  try {
    res = await fetch(`${SPEECHDROP}/${room}/upload`, {
      method: "POST",
      body: out,
      headers: { referer: `${SPEECHDROP}/${room}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e: any) {
    return NextResponse.json({ error: `could not reach SpeechDrop: ${e?.message || e}` }, { status: 502 });
  }

  const body = await res.text();
  if (!res.ok) {
    // Its own errors come back as { err: "..." } — "no_such_room" for a code
    // typed wrong or a room that has expired. A bare 403 from Cloudflare is a
    // different thing entirely, and worth saying so rather than leaving it
    // looking like a bad code.
    let err = `SpeechDrop said ${res.status}`;
    try { const j = JSON.parse(body); if (j?.err) err = String(j.err).replace(/_/g, " "); } catch { /* html */ }
    if (res.status === 403 && (res.headers.get("server") || "").includes("cloudflare")) {
      err = "SpeechDrop only accepts uploads made on its own site — download the .docx and drop it in";
    }
    return NextResponse.json({ error: err, status: res.status }, { status: 400 });
  }

  // On success the answer is the room's index, so the count is what landed.
  let files = 0;
  try { const j = JSON.parse(body); if (Array.isArray(j)) files = j.length; } catch { /* not json */ }
  return NextResponse.json({ ok: true, room, files, name: file.name });
}
