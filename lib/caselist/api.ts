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
 *   GET /caselists                   the wikis; the current ones are not `archived`
 *   GET /caselists/{c}/downloads     weekly archives of every open-source document
 *   GET /caselists/{c}/schools       school names to show
 *   GET /search?q=&shard=            full text, FOUR SEARCHES A MINUTE per account
 *   GET /download?path=              one file, TEN A MINUTE per account
 *
 * Those limits are why Evidence searches an index built weekly from the
 * archives (scripts/caselist-index.mjs) and uses /download only as a fallback.
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
