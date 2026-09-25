import type { SupabaseClient } from "@supabase/supabase-js";
import { collectGames, type GameRow } from "./ratings";
import { judgeTallies, saveJudgeHabits, type JudgeBallot } from "./judges";
import { COLLEGE_TOURNAMENTS, archivable, circuitOf, isCollegeTournament, counts, type Circuit } from "./circuit";
import { loadCircuitOverrides } from "./circuitStore";

/**
 * Past seasons, through the public API rather than by scraping.
 *
 * Tabroom has no endpoint for "everything this debater has done", but it does
 * publish every round of every tournament: the entry records endpoint gives
 * opponents, sides, ballots and speaker points, with no login. So a debater's
 * history is assembled the same way the current season is — by reading whole
 * tournaments — rather than by fetching a per-person page that the site throttles.
 *
 * Which tournaments to read is given rather than discovered. Scanning Tabroom for
 * every past tournament would be tens of thousands of requests; naming the ones
 * that matter is a few dozen.
 */

const API = "https://api.tabroom.com/v1";

export interface ArchiveTarget {
  tournId: number;
  name: string;
  start: string | null;
  events: { abbr: string; name: string; circuit: Circuit }[];
  circuits: Circuit[];
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(API + path, {
      headers: { accept: "application/json", "user-agent": "TheBreak bracket-pool (personal, low volume)" },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a tournament to the events worth archiving, by id or by Tabroom webname.
 *
 * A tournament can feed more than one circuit: Greenhill runs Lincoln-Douglas and
 * policy side by side, the Season Opener runs all three high school circuits, and
 * each division is read into its own. A round robin is left out, being a separate
 * sixteen-entry invitational rather than the tournament's own field.
 */
export async function findPublicForumEvents(ref: number | string): Promise<ArchiveTarget | null> {
  let tournId: number | null = typeof ref === "number" ? ref : null;
  if (tournId === null) {
    const byName = await getJson<{ id: number }>(`/pages/invite/webname/${encodeURIComponent(String(ref))}`);
    tournId = byName?.id ?? null;
  }
  if (!tournId) return null;

  const meta = await getJson<{ id: number; name: string; start: string }>(`/rest/tourns/${tournId}`);
  if (!meta?.id) return null;

  const name = meta.name || `Tournament ${tournId}`;

  // the results index names every event that has published anything, with the
  // division level Tabroom holds for it
  const results = await getJson<Record<string, { id: number; name: string; abbr: string; level?: string; type?: string; ResultSets?: unknown[] }>>(`/rest/tourns/${tournId}/results`);
  const events: { abbr: string; name: string; circuit: Circuit }[] = [];
  for (const e of Object.values(results || {})) {
    if (!(e.ResultSets || []).length) continue;
    const circuit = circuitOf(name, e.name || e.abbr || "");
    if (circuit && archivable(circuit, e)) events.push({ abbr: e.abbr, name: e.name, circuit });
  }

  return { tournId, name, start: meta.start || null, events, circuits: [...new Set(events.map((e) => e.circuit))] };
}

export interface ArchiveResult {
  tournId: number;
  name: string;
  start: string | null;
  events: string[];
  rows: number;
  entries: number;
  error?: string;
}

/**
 * Read one past tournament's Public Forum rounds into the ratings table. Safe to
 * re-run: rows are keyed by round and entry, so a tournament already read costs
 * one wasted pass and changes nothing.
 */
export async function archiveTournament(db: SupabaseClient, ref: number | string, only?: Circuit): Promise<ArchiveResult> {
  await loadCircuitOverrides(db);
  const found = await findPublicForumEvents(ref);
  if (!found) return { tournId: 0, name: String(ref), start: null, events: [], rows: 0, entries: 0, error: "no such tournament on Tabroom" };
  // just the one ranking's divisions, when that is all that was asked for
  const target = only ? { ...found, events: found.events.filter((e) => e.circuit === only) } : found;
  if (!target.events.length) {
    const what = isCollegeTournament(target.name) ? "open division" : "top-division debate";
    return { tournId: target.tournId, name: target.name, start: target.start, events: [], rows: 0, entries: 0, error: `no published ${what} results` };
  }

  let rows: GameRow[] = [];
  let entries = 0;
  const judgeBallots = new Map<string, JudgeBallot[]>();
  for (const ev of target.events) {
    try {
      const out = await collectGames(target.tournId, ev.abbr);
      // a chosen event can still carry rounds that do not count, so the same test
      // the ingest uses applies here
      rows = rows.concat(out.rows.filter((r) => {
        const c = circuitOf(r.tourn_name, r.event_name);
        return c !== null && counts(c, r.event_name) && (!only || c === only);
      }));
      judgeBallots.set(ev.abbr, out.judgeBallots);
      entries += out.entries;
    } catch {
      // an event that publishes a bracket but no rounds simply contributes nothing
    }
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("rating_games").upsert(rows.slice(i, i + 500), { onConflict: "tourn_id,round_id,entry_id" });
    if (error) return { tournId: target.tournId, name: target.name, start: target.start, events: target.events.map((e) => e.abbr), rows: 0, entries, error: error.message };
  }
  // How each judge scored, for estimating points a tournament has not posted yet.
  // A failure here is not worth losing the rounds over.
  try {
    for (const [abbr, ballots] of judgeBallots) {
      const ev = target.events.find((e) => e.abbr === abbr);
      if (ev) await saveJudgeHabits(db, target.tournId, abbr, target.start, judgeTallies(ballots), ev.circuit);
    }
  } catch { /* the habits are refreshed next time this tournament is read */ }

  return {
    tournId: target.tournId,
    name: target.name,
    start: target.start,
    events: target.events.map((e) => e.abbr),
    rows: rows.length,
    entries,
  };
}

/** Read several, in sequence, so Tabroom is never asked for two tournaments at once. */
export async function archiveMany(db: SupabaseClient, refs: (number | string)[], onDone?: (r: ArchiveResult) => void): Promise<ArchiveResult[]> {
  const out: ArchiveResult[] = [];
  for (const ref of refs) {
    const r = await archiveTournament(db, ref);
    out.push(r);
    onDone?.(r);
  }
  return out;
}

/**
 * The tournaments the archive is meant to hold.
 *
 * Past rounds exist here for one reason: to give a team a prior and a
 * head-to-head record before this season has judged them. That argues for depth
 * on the national circuit rather than breadth — a district qualifier tells you
 * little about how a Yale entry will do, and every extra tournament is weight on
 * results that were never the point. So the archive is a named list, not
 * whatever could be read.
 *
 * Matching is by name rather than by Tabroom id, because a tournament gets a new
 * id every year and the list is meant to survive seasons. Each pattern is written
 * to match one tournament: `not` exists because several unrelated tournaments
 * call themselves a tournament of champions.
 *
 * The current season is never governed by this list. Those rounds are the
 * leaderboard itself and are kept whatever their tournament.
 */
export interface ArchiveEntry { name: string; re: RegExp; not?: RegExp; circuit?: Circuit }

export const ARCHIVED_TOURNAMENTS: ArchiveEntry[] = [
  { name: "National Speech and Debate Season Opener", re: /national speech and debate season opener/i },
  { name: "Yale Invitational", re: /yale invitational/i },
  { name: "Jack Howe Memorial", re: /jack howe/i },
  { name: "New York City Invitational", re: /new york city invitational/i },
  { name: "Florida Blue Key", re: /florida blue key/i },
  { name: "Apple Valley MinneApple", re: /minneapple/i },
  { name: "Glenbrooks", re: /glenbrooks/i },
  { name: "Princeton Classic", re: /princeton classic/i },
  { name: "John Edie Holiday Debates", re: /john edie holiday/i },
  { name: "Arizona State HDSHC", re: /arizona state hdshc/i },
  { name: "Sunvite", re: /sunvite/i },
  { name: "Barkley Forum", re: /barkley forum for high schools/i },
  { name: "Stanford Invitational", re: /stanford invitational/i },
  { name: "Cal Invitational (UC Berkeley)", re: /cal invitational/i },
  // Harvard National publishes no Public Forum results on Tabroom, so nothing
  // matches this yet. It stays listed so that the year it does, it is kept.
  { name: "Harvard National", re: /harvard national/i },
  { name: "Tournament of Champions", re: /annual tournament of champions/i, not: /middle school/i },
  // Lincoln-Douglas and high school policy, whose seasons start here
  { name: "Greenhill Fall Classic", re: /greenhill/i },
  { name: "Loyola Invitational", re: /loyola invitational/i },
  // College policy. These are named in lib/circuit.ts, which is also what marks a
  // round as college rather than high school policy.
  ...COLLEGE_TOURNAMENTS.map((t) => ({ ...t, circuit: "cx" as Circuit })),
];

/** Is this tournament one the archive is meant to hold? */
export function isArchived(tournName: string): ArchiveEntry | null {
  for (const t of ARCHIVED_TOURNAMENTS) {
    if (t.re.test(tournName) && !(t.not && t.not.test(tournName))) return t;
  }
  return null;
}
