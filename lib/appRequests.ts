/**
 * Requests from coda's desktop app (src-tauri/, desktop/), on the server.
 *
 * The app has coda built in and no coda account, so its requests come from
 * its own origin (tauri://localhost on a Mac, http://tauri.localhost on
 * Windows) with no session cookie. Two things answer them anyway, and only
 * these two:
 *   - SpeechDrop (/api/tools/speechdrop): a relay to public rooms, as it is
 *     for anyone signed in here;
 *   - the caselist (/api/tools/caselist): for whoever signs into openCaselist
 *     with their own Tabroom account — the app sends that account's token, it
 *     is checked with openCaselist, and anything fetched from openCaselist for
 *     the app is fetched as that account, never as coda's.
 * The browser only lets the app read the answers because of the CORS headers
 * set here; middleware.ts lets these requests past the sign-in.
 */
import { NextResponse } from "next/server";
import { call } from "@/lib/caselist/api";
import { APP_ORIGINS } from "@/lib/desktop";

export { APP_ORIGINS };
/** The caselist token header the app sends. */
export const CL_HEADER = "x-caselist-token";

export function fromApp(req: Request): boolean {
  return APP_ORIGINS.includes(req.headers.get("origin") || "");
}

/** The headers that let the app read an answer. */
export function withCors<T extends Response>(req: Request, res: T): T {
  const o = req.headers.get("origin") || "";
  if (APP_ORIGINS.includes(o)) {
    res.headers.set("access-control-allow-origin", o);
    res.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    res.headers.set("access-control-allow-headers", "content-type, " + CL_HEADER);
    res.headers.set("access-control-max-age", "86400");
    res.headers.append("vary", "Origin");
  }
  return res;
}

/** The app's preflight, before a POST or a request carrying the caselist token. */
export function preflight(req: Request) {
  return withCors(req, new NextResponse(null, { status: fromApp(req) ? 204 : 403 }));
}

// tokens openCaselist has said yes to, for a while, so each search is not a question to openCaselist
const good = new Map<string, number>();
const GOOD_FOR = 30 * 60_000;

/** The app's openCaselist token, if openCaselist still takes it. */
export async function appCaselistToken(req: Request): Promise<string | null> {
  const t = (req.headers.get(CL_HEADER) || "").trim();
  if (!t || t.length > 512) return null;
  const until = good.get(t);
  if (until && until > Date.now()) return t;
  try {
    const r = await call("/caselists", t);
    if (!r.ok) { good.delete(t); return null; }
  } catch {
    return null;
  }
  if (good.size > 500) good.clear();
  good.set(t, Date.now() + GOOD_FOR);
  return t;
}
