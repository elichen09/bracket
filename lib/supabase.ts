import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createBrowserClient, createServerClient, type CookieOptions } from "@supabase/ssr";

function publicEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set");
  return { url, key };
}

let browserClient: SupabaseClient | null = null;

/**
 * Anon client for the browser. Reads are limited by RLS; the session lives in
 * cookies (via @supabase/ssr) so API routes and middleware see the same login.
 */
export function supabaseBrowser(): SupabaseClient {
  if (browserClient) return browserClient;
  const { url, key } = publicEnv();
  browserClient = createBrowserClient(url, key);
  return browserClient;
}

/**
 * Cookie-backed client for route handlers and server components: identifies the
 * caller from the request's auth cookies. Still the anon role — writes go
 * through supabaseAdmin() once ownership has been checked.
 */
export function supabaseFromCookies(cookies: {
  get: (name: string) => { value: string } | undefined;
  set?: (name: string, value: string, options: CookieOptions) => void;
}): SupabaseClient {
  const { url, key } = publicEnv();
  return createServerClient(url, key, {
    cookies: {
      get: (name) => cookies.get(name)?.value,
      set: (name, value, options) => { try { cookies.set?.(name, value, options); } catch {} },
      remove: (name, options) => { try { cookies.set?.(name, "", { ...options, maxAge: 0 }); } catch {} },
    },
  });
}

/** Service-role client for API routes only. Never import this from a client component. */
export function supabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
