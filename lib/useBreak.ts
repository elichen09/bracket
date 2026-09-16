"use client";

import { useEffect, useState, useCallback } from "react";
import type { User } from "@supabase/supabase-js";
import { supabaseBrowser } from "./supabase";
import type { Tournament, Entry } from "./types";

function mapTournament(row: any): Tournament {
  return {
    id: row.id, name: row.name, event: row.event, host: row.host, year: row.year,
    tabroom_tourn_id: row.tabroom_tourn_id, tabroom_result_id: row.tabroom_result_id,
    tabroom_event_abbr: row.tabroom_event_abbr ?? null, tabroom_event_id: row.tabroom_event_id ?? null,
    round_ids: row.round_ids || {}, slots: row.slots || [], results: row.results || {},
    notes: row.notes || {}, locked_rounds: row.locked_rounds || 0, status: row.status,
    sort_order: row.sort_order || 0, last_checked_at: row.last_checked_at,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function mapEntry(e: any): Entry {
  return {
    id: e.id, tournament_id: e.tournament_id, user_id: e.user_id ?? null, name: e.name, picks: e.picks || {},
    locked: e.locked, locked_at: e.locked_at, created_at: e.created_at, updated_at: e.updated_at,
  };
}

/** All tournaments, newest first, kept live over realtime. */
export function useTournaments() {
  const [rows, setRows] = useState<Tournament[] | null>(null);
  useEffect(() => {
    let alive = true, sb: ReturnType<typeof supabaseBrowser>;
    try { sb = supabaseBrowser(); } catch (e) { console.error(e); setRows([]); return; }
    const load = async () => {
      try {
        const { data } = await sb.from("tournaments").select("*").order("sort_order", { ascending: false });
        if (alive) setRows((data || []).map(mapTournament));
      } catch (e) { console.error(e); if (alive) setRows([]); }
    };
    load();
    const ch = sb.channel("tournaments")
      .on("postgres_changes", { event: "*", schema: "public", table: "tournaments" }, load)
      .subscribe();
    return () => { alive = false; sb.removeChannel(ch); };
  }, []);
  return rows;
}

/** One tournament, kept live. */
export function useTournament(id: string) {
  const [row, setRow] = useState<Tournament | null | undefined>(undefined);
  useEffect(() => {
    let alive = true, sb: ReturnType<typeof supabaseBrowser>;
    try { sb = supabaseBrowser(); } catch (e) { console.error(e); setRow(null); return; }
    const load = async () => {
      try {
        const { data } = await sb.from("tournaments").select("*").eq("id", id).maybeSingle();
        if (alive) setRow(data ? mapTournament(data) : null);
      } catch (e) { console.error(e); if (alive) setRow(null); }
    };
    load();
    const ch = sb.channel(`tournament:${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tournaments", filter: `id=eq.${id}` }, load)
      .subscribe();
    return () => { alive = false; sb.removeChannel(ch); };
  }, [id]);
  return row;
}

/**
 * Entries for a tournament. Realtime is off for entries (they carry a private
 * token on the base table); the public view is polled every 12s and refetched
 * on demand.
 */
export function useEntries(id: string) {
  const [rows, setRows] = useState<Record<string, Entry>>({});
  const load = useCallback(async () => {
    let sb: ReturnType<typeof supabaseBrowser>;
    try { sb = supabaseBrowser(); } catch (e) { console.error(e); return; }
    const { data } = await sb.from("entries_public").select("*").eq("tournament_id", id);
    const next: Record<string, Entry> = {};
    (data || []).forEach((e: any) => { next[e.id] = mapEntry(e); });
    setRows(next);
  }, [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 12000);
    return () => clearInterval(t);
  }, [load]);
  return { entries: rows, reload: load };
}

/** The signed-in user (undefined while loading, null when signed out), kept in sync with auth changes. */
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

export function userName(u: User | null | undefined): string {
  if (!u) return "";
  const n = (u.user_metadata as any)?.display_name;
  if (typeof n === "string" && n.trim()) return n.trim().slice(0, 24);
  return (u.email || "").split("@")[0].slice(0, 24);
}

export async function signOut() {
  try { await supabaseBrowser().auth.signOut(); } catch {}
}

/** The user's own bracket in a tournament (id + suggested name), from the API. */
export function useMyEntry(tournamentId: string, user: User | null | undefined) {
  const [state, setState] = useState<{ id: string | null; name: string; error?: string } | undefined>(undefined);
  const load = useCallback(async () => {
    if (!user) { setState({ id: null, name: "" }); return; }
    try {
      const res = await fetch(`/api/entries?tournamentId=${encodeURIComponent(tournamentId)}`);
      const j = await res.json();
      if (!res.ok) { setState({ id: null, name: userName(user), error: j.error || "could not look up your bracket" }); return; }
      setState({ id: j.entry?.id || null, name: j.name || userName(user) });
    } catch { setState({ id: null, name: userName(user), error: "could not reach the server" }); }
  }, [tournamentId, user]);
  useEffect(() => { if (user !== undefined) load(); }, [load, user]);
  return { mine: state, reloadMine: load, setMineId: (id: string | null) => setState((s) => ({ id, name: s?.name || userName(user) })) };
}

// ---- API calls ------------------------------------------------------------
export async function apiCreateEntry(tournamentId: string, name: string, picks: Record<string, number>) {
  const res = await fetch("/api/entries", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tournamentId, name, picks }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || "could not create bracket");
  return j as { id: string };
}

export async function apiUpdateEntry(tournamentId: string, id: string,
  patch: { name?: string; picks?: Record<string, number>; lock?: boolean }) {
  const res = await fetch(`/api/entries/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tournamentId, ...patch }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || "could not save");
  return j;
}
