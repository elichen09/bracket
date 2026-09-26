import type { SupabaseClient } from "@supabase/supabase-js";
import { CIRCUITS, type Circuit } from "./circuit";
import { loadRatings, ratingIndex, resolveRating, headToHead, loadRosters, buildTeamIndex, pastSeasonPriors, canonCode, codeFromEntryName, type RatingRow } from "./ratings";
import { teamFrom, type SimTeam } from "./simulate";

/**
 * The entry field of a tournament that has not debated yet, with whatever the
 * ratings already know about each entry. Shared by the entries view and the
 * predictor so both agree on who is in and how strong they are.
 *
 * Tabroom lists only one debater per entry before a tournament starts, so the
 * partner is known by surname from the entry name ("Tran & Lee") and gains a
 * student id only once rounds are posted.
 *
 * Some tournaments code an entry by its debaters' full names ("University
 * Sahas Chhabra & Gavin Chan"); the ratings know it as "University CC", so an
 * entry is looked up by that (codeFromEntryName) and shown as Tabroom has it.
 */

/** The code an entry is known by in the ratings. */
export const lookupCode = (e: RawEntry) => codeFromEntryName(e.code, e.name, e.Students || []);

/**
 * An entry's rating: under the code the ratings know it by — or, if that
 * finds no record of this pairing, under the code as Tabroom wrote it, which
 * is how rounds read in before the codes were put right are still filed.
 */
export function resolveEntry(e: RawEntry, ids: number[], ...rest: Parameters<typeof resolveRating> extends [unknown, unknown, ...infer R] ? R : never) {
  const known = lookupCode(e);
  const first = resolveRating(known, ids, ...rest);
  if (first.source === "team" || known === e.code.replace(/\s+/g, " ").trim()) return first;
  const asWritten = resolveRating(e.code, ids, ...rest);
  return asWritten.source === "team" ? asWritten : first;
}

/**
 * Past meetings, asked for under the codes the ratings know and handed back
 * under the codes this field shows — both sides of every meeting.
 */
export async function fieldHeadToHead(db: SupabaseClient, raw: RawEntry[], circuit: Circuit, only: RawEntry[] = raw) {
  const toShown = new Map<string, string>();
  for (const e of raw) toShown.set(canonCode(lookupCode(e)), canonCode(e.code));
  const got = await headToHead(db, only.map(lookupCode), circuit);
  const out: typeof got = {};
  for (const [mine, opps] of Object.entries(got)) {
    const row: (typeof got)[string] = {};
    for (const [opp, wl] of Object.entries(opps)) row[toShown.get(opp) ?? opp] = wl;
    out[toShown.get(mine) ?? mine] = row;
  }
  return out;
}

const API = "https://api.tabroom.com/v1";

export interface FieldStudent { id: number; name: string; rating: number | null; rd: number | null }

export interface FieldTeam {
  entryId: number;
  code: string;
  name: string;                    // "Tran & Lee"
  school: string | null;
  seed: number;                    // entry order only; nothing is seeded yet
  rating: number | null;
  rd: number | null;
  source: "team" | "debaters" | "none";
  games: number;
  wins: number;
  losses: number;
  tournaments: number;
  pointsAvg: number | null;
  lastPlayed: string | null;
  students: FieldStudent[];
  history: RatingRow["history"];
}

export interface RawEntry { id: number; code: string; name: string; School?: { name: string }; Students?: { id: number; firstName?: string; lastName?: string }[] }

/** The published entry list for one event. Available well before the tournament runs. */
export async function loadField(tournId: number, abbr: string): Promise<RawEntry[]> {
  const res = await fetch(`${API}/rest/tourns/${tournId}/events/${encodeURIComponent(abbr)}/field`, {
    headers: { accept: "application/json", "user-agent": "TheBreak bracket-pool (personal, low volume)" },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Tabroom has no published field for ${abbr} at tournament ${tournId}`);
  const j = (await res.json()) as { Entries?: RawEntry[] };
  // Placeholder entries ("TBA") are registrations without debaters yet, not teams,
  // so they are left out of the field and out of any simulated bracket.
  return (j.Entries || []).filter((e) => e.code && !/^tba\b/i.test(e.code.trim()));
}

/** The field with ratings attached, plus the simulator's view of the same entries. */
export async function fieldWithRatings(db: SupabaseClient, tournId: number, abbr: string, circuit: Circuit = "pf"): Promise<{
  entries: FieldTeam[];
  teams: SimTeam[];
  h2h: Record<string, Record<string, { w: number; l: number }>>;
}> {
  const [raw, teamRows, debRows, rosters, priors] = await Promise.all([
    loadField(tournId, abbr),
    loadRatings(db, CIRCUITS[circuit].teamKind),
    loadRatings(db, CIRCUITS[circuit].debaterKind),
    loadRosters(db),
    pastSeasonPriors(db, undefined, circuit),
  ]);
  const teamIdx = buildTeamIndex(teamRows, rosters);
  const debIdx = ratingIndex(debRows);

  const entries: FieldTeam[] = raw.map((e, i) => {
    const ids = (e.Students || []).map((s) => s.id).filter(Boolean);
    const resolved = resolveEntry(e, ids, teamIdx, debIdx, priors);
    const own = resolved.row;   // whatever the resolver matched, swapped codes included
    return {
      entryId: e.id,
      code: e.code,
      name: e.name || "",
      school: e.School?.name || null,
      seed: i + 1,
      rating: resolved.rated ? Math.round(resolved.rating.rating) : null,
      rd: resolved.rated ? Math.round(resolved.rating.rd) : null,
      source: resolved.source,
      games: own?.games ?? 0,
      wins: own?.wins ?? 0,
      losses: own?.losses ?? 0,
      tournaments: own?.tournaments ?? 0,
      pointsAvg: own?.points_avg ?? null,
      lastPlayed: own?.last_played ?? null,
      students: (e.Students || []).map((s) => {
        const d = debIdx.get(String(s.id));
        return {
          id: s.id,
          name: `${s.firstName || ""} ${s.lastName || ""}`.trim(),
          rating: d ? Math.round(d.rating) : null,
          rd: d ? Math.round(d.rd) : null,
        };
      }),
      history: own?.history ?? [],
    };
  });

  const teams = raw.map((e, i) => {
    const ids = (e.Students || []).map((s) => s.id).filter(Boolean);
    return teamFrom(e.code, e.School?.name || null, i + 1, resolveEntry(e, ids, teamIdx, debIdx, priors));
  });

  const h2h = await fieldHeadToHead(db, raw, circuit);
  return { entries, teams, h2h };
}
