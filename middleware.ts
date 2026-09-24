import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Keeps the auth session fresh on every request and gates the app: everything
 * except the landing page, the scoring explainer, the login page and the
 * scheduled updater needs an account.
 *
 * Closing a pool and pulling its results are on that list too: they are keyed by
 * ADMIN_KEY rather than by a session, the same way the updater is, so whoever
 * runs the pool can shut it or refresh it from a phone without signing in first.
 */
const PUBLIC = [/^\/$/, /^\/login$/, /^\/about$/, /^\/api\/update$/, /^\/api\/auth\//, /^\/api\/tournaments\/[^/]+\/(close|sync)$/];

export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: { headers: req.headers } });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return res;

  const sb = createServerClient(url, key, {
    cookies: {
      get: (name) => req.cookies.get(name)?.value,
      set: (name, value, options) => {
        req.cookies.set({ name, value, ...options });
        res = NextResponse.next({ request: { headers: req.headers } });
        res.cookies.set({ name, value, ...options });
      },
      remove: (name, options) => {
        req.cookies.set({ name, value: "", ...options });
        res = NextResponse.next({ request: { headers: req.headers } });
        res.cookies.set({ name, value: "", ...options, maxAge: 0 });
      },
    },
  });

  const { data: { user } } = await sb.auth.getUser();
  const path = req.nextUrl.pathname;
  const isPublic = PUBLIC.some((re) => re.test(path));

  if (!user && !isPublic) {
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: "sign in required" }, { status: 401 });
    }
    const to = req.nextUrl.clone();
    to.pathname = "/login";
    to.search = `?next=${encodeURIComponent(path + req.nextUrl.search)}`;
    return NextResponse.redirect(to);
  }
  if (user && path === "/login") {
    // `next` is a path *and* its query — a flow room's link is
    // /tools/flow?join=CODE, and the code is the whole point of it — so it is
    // resolved as a URL rather than written into the pathname, where the "?"
    // would be escaped and the query lost. Same-origin paths only.
    const next = req.nextUrl.searchParams.get("next") || "/";
    const safe = next.startsWith("/") && !next.startsWith("//") ? next : "/";
    return NextResponse.redirect(new URL(safe, req.url));
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|txt|xml)).*)"],
};
