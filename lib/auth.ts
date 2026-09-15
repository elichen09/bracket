import { cookies } from "next/headers";
import type { User } from "@supabase/supabase-js";
import { supabaseFromCookies } from "./supabase";

/** The signed-in user behind a route handler, or null. */
export async function currentUser(): Promise<User | null> {
  try {
    const jar = cookies();
    const sb = supabaseFromCookies({ get: (n) => jar.get(n) });
    const { data } = await sb.auth.getUser();
    return data.user ?? null;
  } catch {
    return null;
  }
}

/** A user's public-facing name: what they chose at signup, else the email's local part. */
export function displayName(u: User): string {
  const meta = (u.user_metadata || {}) as Record<string, unknown>;
  const n = typeof meta.display_name === "string" ? meta.display_name.trim() : "";
  if (n) return n.slice(0, 24);
  return (u.email || "someone").split("@")[0].slice(0, 24);
}
