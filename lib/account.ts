"use client";

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabaseBrowser } from "./supabase";

/** Who is signed in: undefined until it is known, null for nobody. */
export function useUser() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    let sb: ReturnType<typeof supabaseBrowser>;
    try { sb = supabaseBrowser(); } catch { setUser(null); return; }
    sb.auth.getUser().then(({ data }) => setUser(data.user ?? null));
    const { data: sub } = sb.auth.onAuthStateChange((_ev, session) => setUser(session?.user ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);
  return user;
}

/** The name they chose, else the front of their email. */
export function userName(u: User | null | undefined): string {
  if (!u) return "";
  const n = (u.user_metadata as { display_name?: unknown } | null)?.display_name;
  if (typeof n === "string" && n.trim()) return n.trim().slice(0, 24);
  return (u.email || "").split("@")[0].slice(0, 24);
}

export async function signOut() {
  try { await supabaseBrowser().auth.signOut(); } catch { /* signed out already */ }
}
