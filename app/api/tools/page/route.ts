import { NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fromApp, withCors, preflight } from "@/lib/appRequests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * GET /api/tools/page?url=…  — an article, read for its cite.
 *
 * Cite from link (lib/ai/cite.ts) needs what a page says about itself: its
 * title, author, date, publication — the tags news sites and journals write
 * for Google and for citation managers (citation_*, og:*, article:*,
 * JSON-LD) — and the first stretch of its text, where an author's
 * credentials usually are. A page can't read another site from the browser,
 * so it is read here, and only this comes back: never the page itself.
 *
 * Signed in here, or the desktop app (lib/appRequests.ts). Only http(s), only
 * public addresses (every hop of a redirect checked), at most 3 MB read.
 */

const MAX_BYTES = 3 * 1024 * 1024;
const TEXT_CHARS = 14000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export function OPTIONS(req: Request) { return preflight(req); }
export async function GET(req: Request) { return withCors(req, await get(req)); }

/** An address on the open internet — not this machine, not a private network. */
function publicIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return false;
    const m = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return m ? publicIp(m[1]) : true;
  }
  const [a, b] = ip.split(".").map(Number);
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}
async function allowed(u: URL): Promise<boolean> {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.local$|\.internal$/i.test(host)) return false;
  try {
    const all = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    return all.length > 0 && all.every((x) => publicIp(x.address));
  } catch {
    return false;
  }
}

/** The page, following redirects one hop at a time so each is checked. */
async function fetchPage(start: URL): Promise<{ url: URL; res: Response }> {
  let u = start;
  for (let hop = 0; hop < 6; hop++) {
    if (!(await allowed(u))) throw new Error("that address can't be read");
    const res = await fetch(u, {
      redirect: "manual",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "accept-language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      u = new URL(res.headers.get("location")!, u);
      continue;
    }
    return { url: u, res };
  }
  throw new Error("too many redirects");
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (got > MAX_BYTES) { await reader.cancel(); break; }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };
const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const clean = (s: string) => decode(s).replace(/\s+/g, " ").trim();

/** <meta name|property="…" content="…">, in either attribute order — every value for that key. */
function metas(html: string, key: string): string[] {
  const out: string[] = [];
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<meta\\b[^>]*?(?:name|property|itemprop)\\s*=\\s*["']${k}["'][^>]*>`, "gi");
  for (const m of html.matchAll(re)) {
    const c = /content\s*=\s*(["'])([\s\S]*?)\1/i.exec(m[0]);
    if (c && c[2].trim()) out.push(clean(c[2]));
  }
  return out;
}
const first = (html: string, ...keys: string[]) => { for (const k of keys) { const v = metas(html, k)[0]; if (v) return v; } return ""; };

/** What JSON-LD (schema.org) says: the article's authors, dates, headline, publisher. */
function jsonLd(html: string): { authors: string[]; published: string; headline: string; publisher: string } {
  const out = { authors: [] as string[], published: "", headline: "", publisher: "" };
  const visit = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(visit); return; }
    const x = o as Record<string, unknown>;
    if (x["@graph"]) visit(x["@graph"]);
    const type = String(x["@type"] || "");
    if (/Article|Report|BlogPosting|ScholarlyArticle|WebPage|Posting/i.test(type)) {
      const a = x.author;
      for (const p of Array.isArray(a) ? a : a ? [a] : []) {
        const n = typeof p === "string" ? p : p && typeof p === "object" ? String((p as Record<string, unknown>).name || "") : "";
        if (n && !out.authors.includes(n)) out.authors.push(clean(n));
      }
      if (!out.published && x.datePublished) out.published = String(x.datePublished);
      if (!out.headline && x.headline) out.headline = clean(String(x.headline));
      const pub = x.publisher as Record<string, unknown> | undefined;
      if (!out.publisher && pub && typeof pub === "object" && pub.name) out.publisher = clean(String(pub.name));
    }
  };
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1].trim())); } catch { /* a page's broken JSON */ }
  }
  return out;
}

/** The readable text: the article if the page marks one, without scripts, menus, headers and footers. */
function textOf(html: string): string {
  let h = html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|form|button|select)\b[\s\S]*?<\/\1>/gi, " ");
  const art = /<article\b[\s\S]*?<\/article>/i.exec(h) || /<main\b[\s\S]*?<\/main>/i.exec(h);
  if (art && art[0].length > 1500) h = art[0];
  h = h.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|section|article|blockquote|tr)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decode(h).split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter((l) => l.length > 1).join("\n").slice(0, TEXT_CHARS);
}

async function get(req: Request): Promise<NextResponse> {
  // the desktop app, or anyone signed in (middleware.ts has already turned away everyone else)
  void fromApp(req);
  const raw = new URL(req.url).searchParams.get("url") || "";
  let start: URL;
  try { start = new URL(raw.trim()); } catch { return bad("that isn't a link"); }

  let page: { url: URL; res: Response };
  try { page = await fetchPage(start); } catch (e) { return bad("couldn't read that page: " + (e instanceof Error ? e.message : String(e)), 502); }
  const { url, res } = page;
  if (!res.ok) return bad(`the site answered ${res.status}` + (res.status === 403 || res.status === 401 ? " — it may block reading pages automatically, or be paywalled" : ""), 502);

  const type = res.headers.get("content-type") || "";
  if (/application\/pdf/i.test(type)) {
    await res.body?.cancel();
    return NextResponse.json({ url: start.href, finalUrl: url.href, kind: "pdf", title: "", site: url.hostname.replace(/^www\./, ""), authors: [], published: "", description: "", text: "" });
  }
  if (!/html|xml|text\/plain/i.test(type)) { await res.body?.cancel(); return bad("that link isn't an article page (" + type.split(";")[0] + ")"); }

  const html = await readCapped(res);
  const ld = jsonLd(html);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const authors = [
    ...metas(html, "citation_author"), ...metas(html, "dc.creator"), ...metas(html, "DC.creator"),
    ...ld.authors, ...metas(html, "author"), ...metas(html, "article:author"), ...metas(html, "parsely-author"), ...metas(html, "sailthru.author"),
  ].filter((a) => a && !/^https?:\/\//.test(a));

  return NextResponse.json({
    url: start.href,
    finalUrl: url.href,
    kind: "html",
    title: first(html, "citation_title", "og:title", "twitter:title", "dc.title", "DC.title") || ld.headline || (titleTag ? clean(titleTag[1]) : ""),
    site: first(html, "citation_journal_title", "og:site_name", "application-name", "citation_publisher", "dc.publisher") || ld.publisher || url.hostname.replace(/^www\./, ""),
    authors: [...new Set(authors)].slice(0, 8),
    published: first(html, "citation_publication_date", "citation_date", "citation_online_date", "article:published_time", "dc.date", "DC.date", "date", "parsely-pub-date", "sailthru.date", "og:updated_time") || ld.published,
    description: first(html, "description", "og:description", "twitter:description"),
    text: textOf(html),
  });
}
