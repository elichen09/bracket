import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { currentUser } from "@/lib/auth";

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
 * will not post to speechdrop.net from this origin, and because this way the
 * room code and the file are checked before anything is sent anywhere.
 *
 * SpeechDrop's own rules, from its source (github.com/yunyu/speechdrop):
 * POST to /:roomid/upload as multipart, it takes the first file in the body,
 * the type has to be one it allows, ten megabytes is the limit, and it answers
 * with the room's index.
 *
 * The part that is not in the README: every POST goes through Vert.x's CSRF
 * handler, which answers a request without a token with a bare 403 reading
 * "Forbidden" — easy to mistake for the Cloudflare in front of it. Its own
 * client (frontend main.js) reads the XSRF-TOKEN cookie and sends it back as
 * the X-XSRF-TOKEN header, so that is what happens here: ask the room's page
 * for a token first, then upload carrying the token and the session it was
 * issued against.
 */

const SPEECHDROP = (process.env.SPEECHDROP_URL || "https://speechdrop.net").replace(/\/+$/, "");
/** Where a room's files are served from — SpeechDrop's mediaUrl (config.example.json). */
const MEDIA = (process.env.SPEECHDROP_MEDIA || "https://media.speechdrop.net/uploads/").replace(/\/*$/, "/");
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX = 10 * 1024 * 1024;
const ROOM = /^[a-z0-9]{2,16}$/i;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** The token a POST has to carry, and the session it belongs to. */
async function ticket(room: string) {
  // A room that never existed, or that has expired, sends its page back to the
  // front door — so following the redirect would lose the only sign of it.
  const res = await fetch(`${SPEECHDROP}/${room}`, {
    headers: { "user-agent": UA },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const jar = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  const xsrf = jar.find((c) => c.startsWith("XSRF-TOKEN="));
  return {
    status: res.status,
    cookie: jar.join("; "),
    token: xsrf ? decodeURIComponent(xsrf.slice("XSRF-TOKEN=".length)) : "",
  };
}

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

  let pass: Awaited<ReturnType<typeof ticket>>;
  try {
    pass = await ticket(room);
  } catch (e: any) {
    return NextResponse.json({ error: `could not reach SpeechDrop: ${e?.message || e}` }, { status: 502 });
  }
  // Worth saying before anything is uploaded into nowhere.
  if (pass.status !== 200) return NextResponse.json({ error: `there is no room ${room}` }, { status: 400 });
  if (!pass.token) return NextResponse.json({ error: "SpeechDrop would not issue a token" }, { status: 502 });

  const out = new FormData();
  out.append("file", new File([await file.arrayBuffer()], file.name || "send.docx", { type: DOCX }));

  let res: Response;
  try {
    res = await fetch(`${SPEECHDROP}/${room}/upload`, {
      method: "POST",
      body: out,
      headers: {
        "user-agent": UA,
        "x-xsrf-token": pass.token,
        cookie: pass.cookie,
        referer: `${SPEECHDROP}/${room}`,
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e: any) {
    return NextResponse.json({ error: `could not reach SpeechDrop: ${e?.message || e}` }, { status: 502 });
  }

  const body = await res.text();
  if (!res.ok) {
    // Its own errors come back as { err: "..." } — "no_such_room" for a room
    // that has expired, "bad_file_type" for something it will not hold.
    let err = `SpeechDrop said ${res.status}`;
    try { const j = JSON.parse(body); if (j?.err) err = String(j.err).replace(/_/g, " "); } catch { /* html */ }
    return NextResponse.json({ error: err, status: res.status }, { status: 400 });
  }

  // On success the answer is the room's index, so the count is what landed.
  let files = 0;
  try { const j = JSON.parse(body); if (Array.isArray(j)) files = j.length; } catch { /* not json */ }
  return NextResponse.json({ ok: true, room, files, name: file.name, url: `${SPEECHDROP}/${room}` });
}

/**
 * GET /api/tools/speechdrop?room=CODE          the files in a room
 * GET /api/tools/speechdrop?room=CODE&i=N      one of them, to read in the Doc viewer
 *
 * A room's index is GET /:room/index — an array in upload order, with null
 * where a file was deleted — and a file lives at mediaUrl + room/index/name,
 * which is how SpeechDrop's own room page (RoomContainer.vue) links it. Both
 * come through here because the browser will not fetch them from this origin.
 * Anyone signed in may read: a partner reading the other team's doc is not
 * an administrator.
 */
export async function GET(req: Request) {
  if (!(await currentUser())) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const url = new URL(req.url);
  const room = String(url.searchParams.get("room") || "").trim().replace(/^https?:\/\/[^/]+\//i, "").replace(/\/.*$/, "");
  if (!ROOM.test(room)) return NextResponse.json({ error: `"${room}" is not a room code` }, { status: 400 });

  let index: ({ name: string; ctime?: number } | null)[];
  try {
    const res = await fetch(`${SPEECHDROP}/${room}/index`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000), cache: "no-store" });
    if (res.status === 404) return NextResponse.json({ error: `there is no room ${room}` }, { status: 404 });
    if (!res.ok) return NextResponse.json({ error: `SpeechDrop said ${res.status}` }, { status: 502 });
    index = await res.json();
  } catch (e: any) {
    return NextResponse.json({ error: `could not reach SpeechDrop: ${e?.message || e}` }, { status: 502 });
  }
  if (!Array.isArray(index)) index = [];

  const iRaw = url.searchParams.get("i");
  if (iRaw === null) {
    const files = index.map((f, i) => (f && f.name ? { i, name: String(f.name), ctime: Number(f.ctime) || 0 } : null)).filter(Boolean);
    return NextResponse.json({ room, files });
  }

  const i = Number(iRaw);
  const f = Number.isInteger(i) ? index[i] : null;
  if (!f || !f.name) return NextResponse.json({ error: "that file is not in the room any more" }, { status: 404 });
  let res: Response;
  try {
    res = await fetch(`${MEDIA}${room}/${i}/${encodeURIComponent(f.name)}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
  } catch (e: any) {
    return NextResponse.json({ error: `could not reach SpeechDrop: ${e?.message || e}` }, { status: 502 });
  }
  if (!res.ok) return NextResponse.json({ error: `SpeechDrop said ${res.status} for that file` }, { status: 502 });
  const body = await res.arrayBuffer();
  if (body.byteLength > MAX * 2) return NextResponse.json({ error: "that file is too big to read here" }, { status: 400 });
  return new NextResponse(body, {
    headers: {
      "content-type": res.headers.get("content-type") || "application/octet-stream",
      "x-file-name": encodeURIComponent(f.name),
      "cache-control": "no-store",
    },
  });
}
