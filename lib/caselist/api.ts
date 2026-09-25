/**
 * The openCaselist wiki, from the server.
 *
 * Its API (api.opencaselist.com/v1, OpenAPI at /v1/docs) answers only to a
 * signed-in caselist account, and a caselist account is a Tabroom account: the
 * same TABROOM_USERNAME / TABROOM_PASSWORD the career pages already use. A login
 * hands back a `caselist_token` cookie good for two weeks with `remember`.
 *
 * Tabroom throttles repeated logins, so a login happens once and its token is
 * kept: in this process, and — because a serverless function forgets — in an
 * http-only cookie on the one browser allowed to use this (the tools are
 * admin-only), which the route hands back on the next request.
 *
 * What the API allows, found by asking it:
 *   GET /caselists            the wikis; the current ones are not `archived`
 *   GET /search?q=&shard=     full-text over a wiki's files and cites, 100 at
 *                             most, and FOUR SEARCHES A MINUTE per account —
 *                             a fifth is a 429 "You can only run 4 searches per
 *                             minute"
 *   GET /download?path=       the file, unthrottled
 *
 * A search also finds typed-in cites. Those are free text with no headings, so
 * there is no tag to match, and the Evidence search leaves them out.
 */

const API = "https://api.opencaselist.com/v1";
export const TOKEN_COOKIE = "break_caselist";

let kept: { token: string; until: number } | null = null;
let signing: Promise<{ token: string; until: number }> | null = null;

export class CaselistError extends Error {
  constructor(message: string, public status: number, public retryIn?: number) { super(message); }
}

async function login(): Promise<{ token: string; until: number }> {
  const username = process.env.TABROOM_USERNAME, password = process.env.TABROOM_PASSWORD;
  if (!username || !password) throw new CaselistError("TABROOM_USERNAME / TABROOM_PASSWORD are not set", 500);
  const r = await fetch(API + "/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, remember: true }),
    signal: AbortSignal.timeout(20_000),
  });
  const set = r.headers.getSetCookie().find((c) => c.startsWith("caselist_token="));
  if (!r.ok || !set) throw new CaselistError("openCaselist would not sign in with the Tabroom account (" + r.status + ")", 502);
  const token = set.split(";")[0].slice("caselist_token=".length);
  const exp = set.match(/expires=([^;]+)/i)?.[1];
  const until = exp ? Date.parse(exp) : Date.now() + 13 * 864e5;
  return { token, until };
}

/** A token: the one held here, the one the browser brought back, or a new login — never two logins at once. */
export async function token(fromCookie?: string | null): Promise<{ token: string; until: number; fresh: boolean }> {
  const now = Date.now() + 60_000;
  if (kept && kept.until > now) return { ...kept, fresh: false };
  if (fromCookie) {
    const [t, u] = fromCookie.split("|");
    if (t && +u > now) { kept = { token: t, until: +u }; return { ...kept, fresh: false }; }
  }
  if (!signing) signing = login().finally(() => { signing = null; });
  kept = await signing;
  return { ...kept, fresh: true };
}

/** Forget a token the API has stopped taking. */
export function forget() { kept = null; }

export async function call(path: string, tok: string): Promise<Response> {
  return fetch(API + path, { headers: { cookie: "caselist_token=" + tok }, signal: AbortSignal.timeout(25_000) });
}

/* ------------------------------------------------------------------ what it says */

export interface Wiki { slug: string; name: string; event: string; year: number }

export interface Hit {
  type: "file" | "cite";
  wiki: string;
  school: string; schoolName: string;
  team: string; teamName: string; teamId: number;
  path: string;
  file?: string;          // download_path, for a file
  citeId?: number;        // for a cite
  title: string;
  snippet: string;
}

export function toHit(x: any): Hit {
  return {
    type: x.type === "cite" ? "cite" : "file",
    wiki: String(x.caselist || x.shard || ""),
    school: String(x.school || ""), schoolName: String(x.school_display_name || x.school || ""),
    team: String(x.team || ""), teamName: String(x.team_display_name || ""), teamId: Number(x.team_id) || 0,
    path: String(x.path || ""),
    file: x.download_path ? String(x.download_path) : undefined,
    citeId: x.cite_id ? Number(x.cite_id) : undefined,
    title: String(x.title || ""),
    snippet: String(x.snippet || ""),
  };
}
