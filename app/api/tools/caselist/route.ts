import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isAdmin } from "@/lib/admin";
import { currentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { token, forget, call, CaselistError, TOKEN_COOKIE } from "@/lib/caselist/api";
import { standings } from "@/lib/caselist/rank";
import { BUCKET, readMeta } from "@/lib/caselist/store";
import { unpack, spanOf } from "@/lib/caselist/zipdir.mjs";
import { cardHtml } from "@/lib/caselist/card.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The caselist, for Evidence's search. Admin only.
 *
 * Searching happens in the browser, over an index of every tag in a wiki's
 * disclosed documents that is built once a week from openCaselist's
 * whole-wiki archive (scripts/caselist-index.mjs). So nothing here waits on
 * the caselist's four-searches-a-minute search. What the page needs from here:
 *
 *   GET  ?op=indexes                 which wikis have an index, and how fresh
 *   GET  ?op=index&wiki=hspf26       a short-lived link to download one
 *   GET  ?op=card&zip=…&off=&len=&m=&nl=&path=&tag=
 *                                    one card, as HTML: its document read out of
 *                                    the weekly archive with a single ranged
 *                                    request (no download limit applies, and if
 *                                    that archive has been replaced the API is
 *                                    asked instead), then the card read from its
 *                                    XML — a few kilobytes, not a document
 *   POST ?op=ranks  { wiki, teams }  where each team stands in this site's ratings
 */

const ZIP_HOST = /^https:\/\/caselist-files\.s3\.[a-z0-9-]+\.backblazeb2\.com\/weekly\/[a-z]+\d{2}\/[\w.-]+\.zip$/;
const WIKI = /^[a-z]+\d{2}$/;
const FAMILIES = ["hspf", "hsld", "hspolicy", "ndtceda"];
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

async function gate() {
  if (!(await currentUser())) return bad("sign in required", 401);
  if (!isAdmin()) return bad("the caselist search is for the site owner", 403);
  return null;
}

/** A document through the caselist API — ten a minute — for when the archive has moved on. */
async function viaApi(path: string) {
  const jar = { tok: cookies().get(TOKEN_COOKIE)?.value };
  let t = await token(jar.tok);
  let r = await call("/download?path=" + encodeURIComponent(path), t.token);
  if (r.status === 401) { forget(); t = await token(null); r = await call("/download?path=" + encodeURIComponent(path), t.token); }
  if (r.status === 429) throw new CaselistError("openCaselist allows ten downloads a minute — try that card again shortly", 429);
  if (!r.ok) throw new CaselistError("openCaselist said " + r.status + " for that file", r.status === 404 ? 404 : 502);
  return { body: await r.arrayBuffer(), set: t.fresh ? t.token + "|" + t.until : null };
}

export async function GET(req: Request) {
  const no = await gate();
  if (no) return no;
  const u = new URL(req.url).searchParams;
  const op = u.get("op");
  try {
    if (op === "indexes") {
      const db = supabaseAdmin();
      const { data } = await db.storage.from(BUCKET).list("", { limit: 100 });
      const slugs = (data || []).map((f) => f.name.match(/^([a-z]+\d{2})\.meta\.json$/)?.[1]).filter(Boolean) as string[];
      // this season's only: the newest of each family
      const newest = FAMILIES.map((f) => slugs.filter((s) => s.startsWith(f) && WIKI.test(s)).sort().pop()).filter(Boolean) as string[];
      const metas = (await Promise.all(newest.map((s) => readMeta(db, s)))).filter(Boolean);
      return NextResponse.json({ indexes: metas });
    }

    if (op === "index") {
      const wiki = String(u.get("wiki") || "");
      if (!WIKI.test(wiki)) return bad("which wiki?");
      const db = supabaseAdmin();
      const meta = await readMeta(db, wiki);
      if (!meta) return bad("no index for " + wiki + " yet", 404);
      const { data, error } = await db.storage.from(BUCKET).createSignedUrl(`${wiki}.json.gz`, 3600);
      if (error || !data) throw new CaselistError("storage: " + (error?.message || "no link"), 502);
      return NextResponse.json({ meta, url: data.signedUrl });
    }

    if (op === "card") {
      const zip = String(u.get("zip") || ""), path = String(u.get("path") || ""), tag = String(u.get("tag") || "");
      if (!tag) return bad("which card?");
      const off = Number(u.get("off")), len = Number(u.get("len")), m = Number(u.get("m")), nl = Number(u.get("nl"));
      if (!/^[a-z]+\d{2}\/[^?#]+\.docx$/i.test(path) || path.includes("..")) return bad("not a caselist document");
      const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "private, max-age=604800" };
      const answer = async (docx: Buffer, set?: string | null) => {
        const html = await cardHtml(docx, tag);
        if (!html) return bad("that card is not in the document any more", 404);
        const res = new NextResponse(html, { headers });
        if (set) res.cookies.set(TOKEN_COOKIE, set, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/tools/caselist" });
        return res;
      };
      if (ZIP_HOST.test(zip) && Number.isFinite(off) && off >= 0 && len > 0 && len < 60e6 && (m === 0 || m === 8) && nl > 0 && nl < 1024) {
        const end = off + spanOf({ nameLen: nl, csize: len }) - 1;
        const r = await fetch(zip, { headers: { range: `bytes=${off}-${end}` }, signal: AbortSignal.timeout(20_000) });
        if (r.status === 206 || r.status === 200) {
          let docx: Buffer | null = null;
          try { docx = unpack(Buffer.from(await r.arrayBuffer()), len, m); } catch { /* the archive has changed under the index: ask the API */ }
          if (docx) return answer(docx);
        }
      }
      const { body, set } = await viaApi(path);
      return answer(Buffer.from(body), set);
    }

    return bad("unknown op");
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof CaselistError ? e.status : 502 });
  }
}

export async function POST(req: Request) {
  const no = await gate();
  if (no) return no;
  const op = new URL(req.url).searchParams.get("op");
  if (op !== "ranks") return bad("unknown op");
  let body: any;
  try { body = await req.json(); } catch { return bad("bad json"); }
  const wiki = String(body?.wiki || "");
  if (!WIKI.test(wiki) || !Array.isArray(body?.teams)) return bad("which wiki and teams?");
  const teams = (body.teams as unknown[]).slice(0, 20000).map((t) => {
    const [school, team, schoolName] = Array.isArray(t) ? t.map(String) : ["", "", ""];
    return { school, team, schoolName: schoolName || school };
  }).filter((t) => t.school && t.team);
  try {
    return NextResponse.json({ ranks: await standings(supabaseAdmin(), wiki, teams) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
