import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isAdmin } from "@/lib/admin";
import { currentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { token, forget, call, toHit, CaselistError, TOKEN_COOKIE, type Hit, type Wiki } from "@/lib/caselist/api";
import { circuitOf, standings } from "@/lib/caselist/rank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/tools/caselist
 *   ?op=wikis                         this season's PF, LD, HS policy and NDT-CEDA wikis
 *   ?op=search&wiki=hspf26&q=…        what the wiki's search finds, with each team's
 *                                     standing in this site's ratings
 *   ?op=file&path=hspf26/…/x.docx     a disclosed file, for the page to read its cards
 *
 * Admin only: every call is made as the site owner's caselist account.
 *
 * Both halves are rationed per account — four searches a minute, ten downloads
 * — so a search's answer is kept here for a quarter of an hour, and a limit is
 * passed back as a 429 for the page to wait out rather than as an error.
 */

const SEARCH_LIFE = 15 * 60_000;
const searches = new Map<string, { at: number; hits: Hit[] }>();
let wikis: { at: number; list: Wiki[] } | null = null;

const WIKI = /^[a-z]+\d{2}$/;
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** Ask the API, signing in again once if it has stopped taking the token. */
async function ask(path: string, jar: { tok?: string; set?: string }) {
  let t = await token(jar.tok);
  if (t.fresh) jar.set = t.token + "|" + t.until;
  let r = await call(path, t.token);
  if (r.status === 401) {
    forget();
    t = await token(null);
    jar.set = t.token + "|" + t.until;
    r = await call(path, t.token);
  }
  return r;
}

function reply(body: unknown, jar: { set?: string }, init?: ResponseInit) {
  const res = NextResponse.json(body, init);
  if (jar.set) {
    const until = +jar.set.split("|")[1];
    res.cookies.set(TOKEN_COOKIE, jar.set, {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax",
      path: "/api/tools/caselist", maxAge: Math.max(60, Math.floor((until - Date.now()) / 1000)),
    });
  }
  return res;
}

export async function GET(req: Request) {
  if (!(await currentUser())) return bad("sign in required", 401);
  if (!isAdmin()) return bad("the caselist search is for the site owner", 403);

  const u = new URL(req.url).searchParams;
  const op = u.get("op");
  const jar: { tok?: string; set?: string } = { tok: cookies().get(TOKEN_COOKIE)?.value };

  try {
    if (op === "wikis") {
      if (!wikis || Date.now() - wikis.at > 6 * 3600_000) {
        const r = await ask("/caselists", jar);
        if (!r.ok) throw new CaselistError("openCaselist said " + r.status, 502);
        const all = (await r.json()) as any[];
        const list: Wiki[] = all.filter((c) => !c.archived && circuitOf(String(c.name)))
          .map((c) => ({ slug: String(c.name), name: String(c.display_name || c.name), event: String(c.event || ""), year: Number(c.year) || 0 }));
        wikis = { at: Date.now(), list };
      }
      return reply({ wikis: wikis.list }, jar);
    }

    if (op === "search") {
      const wiki = String(u.get("wiki") || "");
      const q = String(u.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!WIKI.test(wiki)) return bad("which wiki?");
      if (q.length < 2) return bad("search for at least two letters");
      const key = wiki + "|" + q.toLowerCase();
      let hit = searches.get(key);
      let cached = true;
      if (!hit || Date.now() - hit.at > SEARCH_LIFE) {
        cached = false;
        const r = await ask("/search?q=" + encodeURIComponent(q) + "&shard=" + encodeURIComponent(wiki), jar);
        if (r.status === 429) {
          const j = await r.json().catch(() => ({}));
          return reply({ error: j.message || "openCaselist allows four searches a minute", limited: true }, jar, { status: 429 });
        }
        if (!r.ok) throw new CaselistError("openCaselist said " + r.status, 502);
        const raw = await r.json();
        hit = { at: Date.now(), hits: (Array.isArray(raw) ? raw : []).map(toHit) };
        searches.set(key, hit);
        if (searches.size > 300) searches.delete(searches.keys().next().value as string);
      }
      const teams = Array.from(new Map(hit.hits.map((h) => [h.school + "|" + h.team, h])).values());
      let ranks = {};
      try { ranks = await standings(supabaseAdmin(), wiki, teams); } catch { /* unranked, not broken */ }
      return reply({ wiki, q, hits: hit.hits, ranks, cached }, jar);
    }

    if (op === "file") {
      const path = String(u.get("path") || "");
      if (!/^[a-z]+\d{2}\/[^?#]+\.(docx|pdf)$/i.test(path) || path.includes("..")) return bad("not a caselist file");
      const r = await ask("/download?path=" + encodeURIComponent(path), jar);
      if (r.status === 429) {
        // ten downloads a minute: said as itself, so the page waits instead of giving up
        const j = await r.json().catch(() => ({}));
        return reply({ error: j.message || "openCaselist allows ten downloads a minute", limited: true }, jar, { status: 429 });
      }
      if (!r.ok) throw new CaselistError("openCaselist said " + r.status + " for that file", r.status === 404 ? 404 : 502);
      const body = await r.arrayBuffer();
      const res = new NextResponse(body, {
        headers: {
          "content-type": r.headers.get("content-type") || "application/octet-stream",
          "cache-control": "private, max-age=86400",
        },
      });
      if (jar.set) res.cookies.set(TOKEN_COOKIE, jar.set, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/tools/caselist" });
      return res;
    }

    return bad("unknown op");
  } catch (e) {
    const status = e instanceof CaselistError ? e.status : 502;
    return reply({ error: e instanceof Error ? e.message : String(e) }, jar, { status });
  }
}
