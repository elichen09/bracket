"use client";

import { useEffect, useState, useCallback } from "react";
import { supabaseBrowser } from "./supabase";
import type { Tournament, Entry, MyEntry } from "./types";

function mapTournament(row: any): Tournament {
  return {
    id: row.id, name: row.name, event: row.event, host: row.host, year: row.year,
    tabroom_tourn_id: row.tabroom_tourn_id, tabroom_result_id: row.tabroom_result_id,
    round_ids: row.round_ids || {}, slots: row.slots || [], results: row.results || {},
    notes: row.notes || {}, locked_rounds: row.locked_rounds || 0, status: row.status,
    sort_order: row.sort_order || 0, last_checked_at: row.last_checked_at,
    created_at: row.created_at, updated_at: row.updated_at,
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
    (data || []).forEach((e: any) => {
      next[e.id] = {
        id: e.id, tournament_id: e.tournament_id, name: e.name, picks: e.picks || {},
        locked: e.locked, locked_at: e.locked_at, created_at: e.created_at, updated_at: e.updated_at,
      };
    });
    setRows(next);
  }, [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 12000);
    return () => clearInterval(t);
  }, [load]);
  return { entries: rows, reload: load };
}

// ---- my-bracket bookkeeping (localStorage) --------------------------------
export function getMine(tid: string): MyEntry | null {
  try { const s = localStorage.getItem(`break:mine:${tid}`); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function setMine(tid: string, v: MyEntry | null) {
  try {
    if (v) localStorage.setItem(`break:mine:${tid}`, JSON.stringify(v));
    else localStorage.removeItem(`break:mine:${tid}`);
  } catch {}
}
export function getName(): string {
  try { return localStorage.getItem("break:name") || ""; } catch { return ""; }
}
export function setName(v: string) {
  try { localStorage.setItem("break:name", v); } catch {}
}

// ---- API calls ------------------------------------------------------------
export async function apiCreateEntry(tournamentId: string, name: string, picks: Record<string, number>) {
  const res = await fetch("/api/entries", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tournamentId, name, picks }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || "could not create bracket");
  return j as { id: string; token: string };
}

export async function apiUpdateEntry(tournamentId: string, id: string, token: string,
  patch: { name?: string; picks?: Record<string, number>; lock?: boolean }) {
  const res = await fetch(`/api/entries/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tournamentId, token, ...patch }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || "could not save");
  return j;
}
