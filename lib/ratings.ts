import type { SupabaseClient } from "@supabase/supabase-js";
import { UNRATED, update, decay, type Rating, type Game } from "./glicko";
import { ballotsFromRecords, judgeTallies, saveJudgeHabits, type JudgeBallot } from "./judges";
import { CIRCUITS, circuitOf, counts, type Circuit } from "./circuit";
import { loadCircuitOverrides } from "./circuitStore";

/**
 * The ratings pipeline.
 *
 *   ingestTournament()  Tabroom  ->  rating_games   (one row per round, per entry)
 *   recompute()         rating_games  ->  ratings    (Glicko-2, one period per tournament)
 *
 * Every round a team debates counts, prelims included — prelims are most of the
 * rounds and most of the signal. A tournament is one rating period, so a team is
 * updated once from its whole weekend, and deviation grows between tournaments.
 *
 * Partnerships are keyed by Tabroom's entry code ("Harker LL"), which is how every
 * results document names them. Debaters are keyed by student id, so a rating
 * follows a person across partners and seasons.
 */

const API = "https://api.tabroom.com/v1";

export const PRELIM_TYPES = new Set(["prelim", "highlow"]);
export const ELIM_TYPES = new Set(["elim", "final"]);

/**
 * The rankings are a Public Forum table, so only Public Forum rounds feed them.
 * A tournament can still be tracked for its bracket pool without its teams ever
 * appearing here — college policy at Coon, for instance.
 */
export function isPublicForum(eventName: string): boolean {
  const n = (eventName || "").toLowerCase();
  if (/congress|policy|lincoln|douglas|world schools|parli|speech|extemp|oratory|interp/.test(n)) return false;
  return /public forum|\bpf\b|\bpfd\b/.test(n);
}

/**
 * Lincoln-Douglas, which names itself. "LD" counts on its own, as in "Varsity
 * LD", but not inside a longer word.
 */
export function isLincolnDouglas(eventName: string): boolean {
  const n = (eventName || "").toLowerCase();
  if (/public forum|policy|congress|world schools|parli|speech|extemp|oratory|interp/.test(n)) return false;
  return /lincoln|douglas|(^|[^a-z])lds?([^a-z]|$)/.test(n);
}

/**
 * Policy, either circuit. College divisions are usually called "Open" rather than
 * policy at all, so this catches the name where there is one and lib/circuit.ts
 * decides the rest from the tournament it was debated at.
 */
export function isPolicy(eventName: string): boolean {
  const n = (eventName || "").toLowerCase();
  if (/public forum|lincoln|douglas|congress|world schools|parli|speech|extemp|oratory|interp/.test(n)) return false;
  return /policy|(^|[^a-z])cx([^a-z]|$)|cross ?examination/.test(n);
}

/**
 * Varsity only.
 *
 * A JV or novice division is a different population debating a different field.
 * Going 6-0 in novice says nothing about how that team fares against a varsity
 * entry, and counting both together flatters whoever happened to enter a lower
 * division. The rankings and the prediction are a varsity table, so only varsity
 * rounds feed them.
 *
 * Tabroom publishes no division level, so this reads the division's name: what is
 * not marked junior varsity, novice or middle school is varsity. That keeps the
 * plain "Public Forum" division, the Tournament of Champions' Gold and Silver,
 * and round robins, which are all top-division fields.
 */
export function isVarsity(eventName: string): boolean {
  const n = (eventName || "").toLowerCase();
  return !/\bjv\b|junior varsity|novice|\bms\b|middle school|intermediate|rookie|beginner|elementary/.test(n);
}

export interface GameRow {
  tourn_id: number;
  round_id: number;
  entry_id: number;
  opp_entry_id: number;
  event_id: number | null;
  event_name: string;
  tourn_name: string;
  tourn_start: string | null;
  round_name: number | null;
  round_label: string;
  elim: boolean;
  code: string;
  opp_code: string;
  school: string | null;
  side: string | null;
  score: number;
  ballots_for: number;
  ballots_against: number;
  points: number | null;
  student_ids: number[];
}

// ---------------------------------------------------------------------------
// Tabroom reading
// ---------------------------------------------------------------------------

export async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(API + path, {
      headers: { accept: "application/json", "user-agent": "TheBreak bracket-pool (personal, low volume)" },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Run `work` over `items`, at most `limit` at a time. Tabroom is a small nonprofit site. */
export async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

interface FieldEntry { id: number; code: string; name: string; School?: { name: string }; Students?: { id: number }[] }
interface RecordsDoc {
  id: number; code: string; name: string;
  Students?: Record<string, { first?: string; last?: string } | unknown>;
  Event?: { id: number; name: string; abbr: string };
  Rounds?: Record<string, {
    id: number; type: string; label?: string; name?: number; sideLabel?: string; bye?: number | boolean;
    Results?: Record<string, { winloss?: string; point?: number }>;
    Judges?: Record<string, { paradigm?: number }>;
    Opponent?: { id: number; code: string };
  }>;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The code a team goes by, when a tournament wrote its debaters' names out
 * instead. Tabroom codes a team "University CC" — its school, then the first
 * letter of each debater's last name — and that is the name it carries from
 * tournament to tournament. Some tournaments (the Mid America Cup among them)
 * code it "University Sahas Chhabra & Gavin Chan" instead, which is a new team
 * as far as the rankings can tell. When every debater's full name is in the
 * code, it is put back the usual way: what comes before the names, then their
 * initials in the order they were written. Any other code is left as it is.
 */
export function conventionalCode(code: string, students: { first?: string; last?: string }[]): string {
  const c = (code || "").replace(/\s+/g, " ").trim();
  const people = students.filter((s) => s.first?.trim() && s.last?.trim());
  if (!c || !people.length) return c;
  const found = people.map((s) => {
    // a middle name or initial may sit between the two
    const m = new RegExp(`\\b${escRe(s.first!.trim())}\\s+(?:\\S+\\s+)?${escRe(s.last!.trim())}\\b`, "i").exec(c);
    return { s, at: m ? m.index : -1 };
  });
  const named = (list: typeof people) => {
    const at = found.find((f) => f.s === list[0])!.at;
    const prefix = c.slice(0, at).replace(/[\s&,+/-]+$/, "").trim();
    const initials = list.map((s) => s.last!.trim()[0].toUpperCase()).join("");
    return prefix ? `${prefix} ${initials}` : initials;
  };
  if (found.every((f) => f.at >= 0)) return named(found.slice().sort((a, b) => a.at - b.at).map((f) => f.s));
  // Tabroom cuts a code at 63 characters, sometimes mid-name ("… Kavin
  // Dassanaike-Perera & Adhhrith"): the first name found, and all that follows
  // it the start of the rest of the names written out, is the same team.
  const first = found.filter((f) => f.at >= 0).sort((a, b) => a.at - b.at)[0];
  if (!first || people.length > 3) return c;
  const rest = c.slice(first.at).toLowerCase();
  const others = people.filter((s) => s !== first.s);
  const orders = others.length === 2 ? [others, [others[1], others[0]]] : [others];
  for (const o of orders) {
    const list = [first.s, ...o];
    const written = list.map((s) => `${s.first!.trim()} ${s.last!.trim()}`).join(" & ").toLowerCase();
    if (written.startsWith(rest)) return named(list);
  }
  return c;
}

/**
 * The same, for an entry in a published field — where Tabroom names only one
 * of the debaters in full, and the pair only by surname ("Chhabra & Chan").
 * That is enough: the school is whatever comes before the first debater's
 * first name (known exactly for the one listed, taken as one word otherwise),
 * and the initials are the surnames' — in the order the code writes them, a
 * surname the code was cut off before coming last. So "University Sahas
 * Chhabra & Gavin Chan" looks itself up as "University CC". A code that does
 * not spell out the debaters comes back as it is.
 */
export function codeFromEntryName(code: string, name: string, known: { firstName?: string; lastName?: string }[] = []): string {
  const c = (code || "").replace(/\s+/g, " ").trim();
  if (!/&|\sand\s/i.test(c)) return c;
  const lasts = (name || "").split(/\s*&\s*/).map((l) => l.trim()).filter(Boolean);
  if (!lasts.length || lasts.length > 3) return c;
  const at = lasts.map((l) => { const m = new RegExp(`\\b${escRe(l)}\\b`, "i").exec(c); return m ? m.index : -1; });
  const seen = at.filter((i) => i >= 0);
  if (!seen.length) return c;
  const first = Math.min(...seen);
  const who = lasts[at.indexOf(first)];
  const before = c.slice(0, first).trimEnd();
  const k = known.find((s) => (s.lastName || "").trim().toLowerCase() === who.toLowerCase() && s.firstName?.trim());
  const given = k?.firstName!.trim() || "";
  const prefix = (given && before.toLowerCase().endsWith(given.toLowerCase())
    ? before.slice(0, before.length - given.length)
    : before.replace(/\s*\S+$/, "")).replace(/[\s&,+/-]+$/, "").trim();
  if (!prefix) return c;
  const order = lasts.map((l, i) => ({ l, at: at[i] < 0 ? Infinity : at[i] })).sort((a, b) => a.at - b.at);
  return `${prefix} ${order.map((o) => o.l[0].toUpperCase()).join("")}`;
}

/**
 * Read one event at one tournament into game rows. One request for the field,
 * then one per entry — a few hundred for a big Public Forum pool, which is why
 * this is an indexing job and not something a page does.
 */
export async function collectGames(tournId: number, eventAbbr: string): Promise<{ rows: GameRow[]; entries: number; name: string; start: string | null; judgeBallots: JudgeBallot[] }> {
  const meta = await getJson<{ name: string; start: string }>(`/rest/tourns/${tournId}`);
  const field = await getJson<{ Entries?: FieldEntry[]; name?: string }>(`/rest/tourns/${tournId}/events/${encodeURIComponent(eventAbbr)}/field`);
  let entries = field?.Entries || [];

  // Some tournaments publish results but not a field — the national championships
  // among them. Their published result sets name every entry, so the roster can be
  // rebuilt from one of those instead.
  if (!entries.length) {
    const index = await getJson<Record<string, { abbr: string; name: string; ResultSets?: { id: number; tag: string }[] }>>(`/rest/tourns/${tournId}/results`);
    const event = Object.values(index || {}).find((e) => e.abbr === eventAbbr);
    const sets = (event?.ResultSets || []).slice().sort((a, b) => {
      const rank = (t: string) => (t === "bracket" ? 0 : t === "seed" ? 1 : t === "final" ? 2 : 3);
      return rank(a.tag) - rank(b.tag);
    });
    const seen = new Map<number, FieldEntry>();
    for (const set of sets) {
      const doc = await getJson<{ results?: { Entry?: { id: number; code: string; name: string }; School?: { name: string } }[] }[]>(`/rest/tourns/${tournId}/results/${set.id}`);
      for (const row of (Array.isArray(doc) ? doc[0]?.results : undefined) || []) {
        if (row.Entry?.id && !seen.has(row.Entry.id)) {
          seen.set(row.Entry.id, { id: row.Entry.id, code: row.Entry.code, name: row.Entry.name, School: row.School });
        }
      }
      if (seen.size) break;
    }
    entries = [...seen.values()];
  }

  if (!entries.length) throw new Error(`no entries published for ${eventAbbr} at tournament ${tournId}`);

  const docs = await pool(entries, 6, (e) => getJson<RecordsDoc>(`/rest/tourns/${tournId}/entries/${e.id}/records`));

  const rows: GameRow[] = [];
  // Every ballot of a rated event, with its judge, for judge scoring habits.
  const judgeBallots: JudgeBallot[] = [];
  // each entry by the code it goes by — its debaters' names put back as initials
  const codeOf = new Map<number, string>();
  docs.forEach((doc, i) => {
    if (!doc) return;
    const people = Object.values(doc.Students || {}).filter((s): s is { first?: string; last?: string } => !!s && typeof s === "object");
    codeOf.set(entries[i].id, conventionalCode(entries[i].code, people));
  });
  docs.forEach((doc, i) => {
    if (!doc || !doc.Rounds) return;
    const entry = entries[i];
    // Judge habits are kept for every rated circuit, not just Public Forum.
    const eventName = doc.Event?.name || field?.name || eventAbbr;
    const circuit = circuitOf(meta?.name || "", eventName);
    if (circuit && counts(circuit, eventName)) judgeBallots.push(...ballotsFromRecords(doc));
    const students = Object.keys(doc.Students || {}).map(Number).filter(Boolean);
    for (const r of Object.values(doc.Rounds)) {
      const isPrelim = PRELIM_TYPES.has(r.type), isElim = ELIM_TYPES.has(r.type);
      if (!isPrelim && !isElim) continue;
      // Byes are not games, and neither is a round whose opponent Tabroom has not
      // filled in — a forfeit against a withdrawn entry reads that way.
      if (!r.Opponent?.id || r.bye) continue;
      const ballots = Object.values(r.Results || {});
      const won = ballots.filter((b) => b.winloss === "W").length;
      const lost = ballots.filter((b) => b.winloss === "L").length;
      if (!won && !lost) continue;                              // no decision posted
      const pointBallot = ballots.find((b) => typeof b.point === "number");
      rows.push({
        tourn_id: tournId, round_id: r.id, entry_id: entry.id, opp_entry_id: r.Opponent.id,
        event_id: doc.Event?.id ?? null, event_name: doc.Event?.name || field?.name || eventAbbr,
        tourn_name: meta?.name || `Tournament ${tournId}`, tourn_start: meta?.start || null,
        round_name: typeof r.name === "number" ? r.name : null, round_label: r.label || "",
        elim: isElim,
        code: codeOf.get(entry.id) || entry.code, opp_code: codeOf.get(r.Opponent.id) || r.Opponent.code, school: entry.School?.name || null,
        side: r.sideLabel || null,
        score: won > lost ? 1 : lost > won ? 0 : 0.5,
        ballots_for: won, ballots_against: lost,
        points: typeof pointBallot?.point === "number" ? pointBallot.point : null,
        student_ids: students,
      });
    }
  });
  return { rows, entries: entries.length, name: meta?.name || "", start: meta?.start || null, judgeBallots };
}

/** Read one event and store its rounds. Safe to re-run: rows are upserted by round and entry. */
export async function ingestTournament(db: SupabaseClient, tournId: number, eventAbbr: string): Promise<{ rows: number; entries: number; name: string; skipped: boolean }> {
  await loadCircuitOverrides(db);   // tournaments said to be college (or not)
  const out = await collectGames(tournId, eventAbbr);
  // A round is stored when it counts towards one of the circuits: top-division
  // Public Forum, or top-division policy at one of the college tournaments. A
  // high school policy or LD field belongs to neither and is read and dropped.
  const rows = out.rows.filter((r) => {
    const c = circuitOf(r.tourn_name, r.event_name);
    return c !== null && counts(c, r.event_name);
  });
  if (!rows.length) return { rows: 0, entries: out.entries, name: out.name, skipped: out.rows.length > 0 };
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("rating_games").upsert(rows.slice(i, i + 500), { onConflict: "tourn_id,round_id,entry_id" });
    if (error) throw new Error(error.message);
  }
  const circuit = circuitOf(out.name, rows[0]?.event_name ?? eventAbbr);
  if (circuit) await saveJudgeHabits(db, tournId, eventAbbr, out.start, judgeTallies(out.judgeBallots), circuit);
  return { rows: rows.length, entries: out.entries, name: out.name, skipped: false };
}

// ---------------------------------------------------------------------------
// Rating computation
// ---------------------------------------------------------------------------

interface Competitor {
  key: string;
  display: string;
  school: string | null;
  r: Rating;
  games: number; wins: number; losses: number; tournaments: number;
  pointsSum: number; pointsN: number;
  zSum: number; zN: number;
  lastPlayed: string | null;
  lastPeriod: number;                       // index of the last tournament played
  history: { tourn: string; start: string | null; rating: number; rd: number; w: number; l: number }[];
}

const blank = (key: string, display: string, school: string | null): Competitor => ({
  key, display, school, r: { ...UNRATED },
  games: 0, wins: 0, losses: 0, tournaments: 0,
  pointsSum: 0, pointsN: 0, zSum: 0, zN: 0,
  lastPlayed: null, lastPeriod: -1, history: [],
});

/**
 * Replay every stored round in tournament order and write the ratings table.
 * Each tournament is one rating period for both partnerships and debaters.
 */
/** The season a date falls in: August starts a new one, so 2026-09 is season 2026. */
export function seasonOf(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 7 ? y : y - 1;
}

export function currentSeason(now = new Date()): number {
  return seasonOf(now.toISOString())!;
}

/**
 * Rebuild the ratings table.
 *
 * This is the season leaderboard, so it counts this season only. Earlier seasons
 * stay in rating_games — they are what past meetings and the prediction's prior
 * are read from — but a team's standing here is what it has done since August.
 */
/**
 * One team, one name, whatever a tournament called it.
 *
 * A team is keyed by its code, and codes are not always the same: a round robin
 * lists its entries by school alone ("Emory", not "Emory GY"), and a code can be
 * written with its initials either way round. The debaters are the same people
 * in every one, and every round records their Tabroom student ids — so each
 * entry is renamed to the code its pair of debaters goes by most often,
 * preferring a code with initials to a bare school name. Both debaters must be
 * known for a two-person team, so partnerships sharing a school are never run
 * together; Lincoln-Douglas needs only the one.
 */
function sameTeamSameName(rows: GameRow[], circuit: Circuit): Set<string> {
  const size = circuit === "ld" ? 1 : 2;
  const pairOf = (r: GameRow) => {
    const ids = [...new Set(r.student_ids || [])];
    return ids.length === size ? ids.sort((a, b) => a - b).join("+") : null;
  };
  const initialled = (code: string) => /\s[A-Z]{1,4}$/.test(code.trim());
  // how often each pair has gone by each code
  const seen = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const p = pairOf(r);
    if (!p || !r.code) continue;
    const m = seen.get(p) || new Map<string, number>();
    m.set(r.code, (m.get(r.code) || 0) + 1);
    seen.set(p, m);
  }
  const nameOf = new Map<string, string>();
  for (const [p, m] of seen) {
    const codes = [...m.entries()].sort((a, b) => Number(initialled(b[0])) - Number(initialled(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]));
    nameOf.set(p, codes[0][0]);
  }
  // every entry at every tournament, by the name its debaters go by
  const entry = new Map<string, string>();
  for (const r of rows) {
    const p = pairOf(r);
    if (p && nameOf.has(p)) entry.set(r.tourn_id + ":" + r.entry_id, nameOf.get(p)!);
  }
  const renamed = new Set<string>();
  for (const r of rows) {
    const mine = entry.get(r.tourn_id + ":" + r.entry_id);
    if (mine && mine !== r.code) { renamed.add(r.code); r.code = mine; }
    const theirs = entry.get(r.tourn_id + ":" + r.opp_entry_id);
    if (theirs) r.opp_code = theirs;
  }
  return renamed;              // the names that turned out to be someone else's
}

export async function recompute(db: SupabaseClient, season = currentSeason(), circuit: Circuit = "pf"): Promise<{ teams: number; debaters: number; periods: number; games: number; skippedSeasons: number }> {
  await loadCircuitOverrides(db);   // tournaments said to be college (or not)
  const all: GameRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    // Order by the primary key as well as the date: every round of a tournament
    // shares one start time, and paging a sort with ties repeats some rows and
    // drops others, which would count games twice.
    const { data, error } = await db.from("rating_games").select("*")
      .order("tourn_start", { ascending: true })
      .order("tourn_id", { ascending: true })
      .order("round_id", { ascending: true })
      .order("entry_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...((data || []) as GameRow[]));
    if (!data || data.length < PAGE) break;
  }
  // Each circuit is rated on its own rounds only. Varsity or open division only,
  // whatever happens to be in the table: a JV or novice round is a different field
  // and must never reach a top-division standing.
  const counted = all.filter((g) => {
    const c = circuitOf(g.tourn_name, g.event_name);
    return c !== null && c === circuit && counts(c, g.event_name);
  });
  all.length = 0;
  all.push(...counted);
  const renamed = sameTeamSameName(all, circuit);

  // Keep this season only. Earlier rounds stay in the table — past meetings and
  // the prediction's prior read them — but they are not part of this standing.
  const before = all.length;
  const thisSeason = all.filter((g) => seasonOf(g.tourn_start) === season);
  all.length = 0;
  all.push(...thisSeason);
  const skippedSeasons = before - all.length;

  if (!all.length) return { teams: 0, debaters: 0, periods: 0, games: 0, skippedSeasons };

  // one period per tournament, oldest first
  const periods = new Map<number, GameRow[]>();
  for (const g of all) {
    const list = periods.get(g.tourn_id) || [];
    list.push(g);
    periods.set(g.tourn_id, list);
  }
  const order = Array.from(periods.entries()).sort((a, b) => {
    const sa = a[1][0].tourn_start || "", sb = b[1][0].tourn_start || "";
    return sa.localeCompare(sb) || a[0] - b[0];
  });

  const teams = new Map<string, Competitor>();
  const debaters = new Map<string, Competitor>();

  order.forEach(([, rows], period) => {
    // speaker points are only comparable inside one tournament, so z-score them there
    const pts = rows.map((r) => r.points).filter((p): p is number => p !== null);
    const mean = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : 0;
    const sd = pts.length > 1 ? Math.sqrt(pts.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (pts.length - 1)) : 0;

    // everyone's games this weekend, by competitor
    const teamGames = new Map<string, GameRow[]>();
    const debaterGames = new Map<string, GameRow[]>();
    for (const row of rows) {
      if (!row.code || !row.opp_code) continue;
      const t = teamGames.get(row.code) || [];
      t.push(row);
      teamGames.set(row.code, t);
      for (const sid of row.student_ids || []) {
        const key = String(sid);
        const d = debaterGames.get(key) || [];
        d.push(row);
        debaterGames.set(key, d);
      }
    }

    const step = (book: Map<string, Competitor>, played: Map<string, GameRow[]>, opponentOf: (row: GameRow) => string[], label: (row: GameRow) => { display: string; school: string | null }) => {
      // snapshot ratings at the start of the period, so results inside a weekend
      // do not feed back on each other
      const before = new Map<string, Rating>();
      for (const [key, c] of book) before.set(key, c.r);

      for (const [key, rows2] of played) {
        const first = rows2[0];
        const info = label(first);
        const c = book.get(key) || blank(key, info.display, info.school);
        c.display = info.display || c.display;
        c.school = info.school ?? c.school;

        const games: Game[] = [];
        for (const row of rows2) {
          for (const oppKey of opponentOf(row)) {
            const opp = before.get(oppKey) || (book.has(oppKey) ? book.get(oppKey)!.r : { ...UNRATED });
            games.push({ opponent: opp, score: row.score });
          }
        }
        // idle periods widen the deviation before this weekend counts
        const idle = c.lastPeriod < 0 ? 0 : period - c.lastPeriod - 1;
        const base = idle > 0 ? decay(c.r, Math.min(idle, 8)) : c.r;
        c.r = update(base, games);

        for (const row of rows2) {
          c.games++;
          if (row.score === 1) c.wins++; else if (row.score === 0) c.losses++;
          if (row.points !== null) {
            c.pointsSum += row.points; c.pointsN++;
            if (sd > 0) { c.zSum += (row.points - mean) / sd; c.zN++; }
          }
          if (!c.lastPlayed || (row.tourn_start || "") > c.lastPlayed) c.lastPlayed = row.tourn_start;
        }
        c.tournaments++;
        c.lastPeriod = period;
        c.history.push({
          tourn: first.tourn_name, start: first.tourn_start,
          rating: Math.round(c.r.rating), rd: Math.round(c.r.rd),
          w: rows2.filter((x) => x.score === 1).length,
          l: rows2.filter((x) => x.score === 0).length,
        });
        book.set(key, c);
      }
    };

    step(teams, teamGames, (row) => [row.opp_code], (row) => ({ display: row.code, school: row.school }));

    // a debater's opponents are the two people across the flow; fall back to the
    // opposing entry's rating when we do not know who they were
    const studentsByEntry = new Map<number, number[]>();
    for (const row of rows) if (row.student_ids?.length) studentsByEntry.set(row.entry_id, row.student_ids);
    step(
      debaters, debaterGames,
      (row) => (studentsByEntry.get(row.opp_entry_id) || []).map(String),
      (row) => ({ display: row.code, school: row.school }),
    );
  });

  const toRow = (kind: string) => (c: Competitor) => ({
    kind, key: c.key, display: c.display, school: c.school,
    rating: c.r.rating, rd: c.r.rd, vol: c.r.vol,
    games: c.games, wins: c.wins, losses: c.losses, tournaments: c.tournaments,
    points_avg: c.pointsN ? c.pointsSum / c.pointsN : null,
    points_z: c.zN ? c.zSum / c.zN : null,
    last_played: c.lastPlayed,
    history: c.history.slice(-24),
    updated_at: new Date().toISOString(),
  });

  const rows = [
    ...Array.from(teams.values()).map(toRow(CIRCUITS[circuit].teamKind)),
    ...Array.from(debaters.values()).map(toRow(CIRCUITS[circuit].debaterKind)),
  ];
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("ratings").upsert(rows.slice(i, i + 500), { onConflict: "kind,key" });
    if (error) throw new Error(error.message);
  }
  // A name folded into its team's real one ("Emory" into "Emory GY") must not
  // linger in the table as a team of its own — and nor must any team this
  // count no longer has: a tournament read again under better codes leaves
  // its old names behind ("University Sahas Chhabra & Gavin Chan").
  const gone = [...renamed].filter((k) => !teams.has(k));
  if (teams.size) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("ratings").select("key").eq("kind", CIRCUITS[circuit].teamKind).order("key").range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const r of (data || []) as { key: string }[]) if (!teams.has(r.key) && !gone.includes(r.key)) gone.push(r.key);
      if (!data || data.length < 1000) break;
    }
  }
  for (let i = 0; i < gone.length; i += 200) {
    const { error } = await db.from("ratings").delete().eq("kind", CIRCUITS[circuit].teamKind).in("key", gone.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }
  return { teams: teams.size, debaters: debaters.size, periods: order.length, games: all.length, skippedSeasons };
}

// ---------------------------------------------------------------------------
// Reading, for the rankings page and the simulator
// ---------------------------------------------------------------------------

export interface RatingRow {
  kind: string; key: string; display: string; school: string | null;
  rating: number; rd: number; vol: number;
  games: number; wins: number; losses: number; tournaments: number;
  points_avg: number | null; points_z: number | null;
  last_played: string | null;
  history: { tourn: string; start: string | null; rating: number; rd: number; w: number; l: number }[];
}

export async function loadRatings(db: SupabaseClient, kind: string): Promise<RatingRow[]> {
  // Paged, and ordered by the key as well as the rating: ties in a sort have no
  // guaranteed order, so paging without a tiebreaker repeats and drops rows.
  const out: RatingRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("ratings").select("*").eq("kind", kind)
      .order("rating", { ascending: false })
      .order("key", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data || []) as RatingRow[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/**
 * A code with Tabroom's stray double spaces collapsed. This is the literal
 * identity of an entry, so "Emerald KG" and "Emerald GK" stay apart here.
 */
export function canonCode(code: string): string {
  return code.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The same code with its initials read as a set, so a pairing written both ways
 * collapses to one key: "Emerald KG" and "Emerald GK", "Lincoln-Sudbury CA" and
 * "Lincoln-Sudbury AC".
 *
 * This is a guess, never an identity. Two different teams at one school can have
 * initials that are anagrams — Acton-Boxborough SV and VS are four different
 * people, as are BASIS Peoria CK and KC — so it is used only when the debaters
 * themselves are unknown, and only when exactly one rated partnership claims it.
 */
export function initialsKey(code: string): string {
  const cleaned = code.replace(/\s+/g, " ").trim();
  const m = cleaned.match(/^(.+)\s+([A-Za-z]{1,4})$/);
  if (!m) return cleaned.toLowerCase();
  return `${m[1].toLowerCase()} ${m[2].toLowerCase().split("").sort().join("")}`;
}

/** Index rating rows for lookup: partnerships by canonical code, debaters by student id. */
export function ratingIndex(rows: RatingRow[]): Map<string, RatingRow> {
  const m = new Map<string, RatingRow>();
  for (const r of rows) m.set(r.kind === "team" ? canonCode(r.key) : r.key, r);
  return m;
}

export interface ResolvedRating {
  rating: Rating;
  pointsZ: number;
  rated: boolean;
  source: "team" | "debaters" | "none";
  /** The partnership row this resolved to, when it resolved to one. */
  row?: RatingRow;
}

/**
 * Ways to find a partnership's rating, in order of how much they can be trusted:
 * the two debaters, one known debater, then the spelling of the code.
 */
export interface TeamIndex {
  byStudents: Map<string, RatingRow>;   // "1362322+1363031"
  byStudent: Map<string, RatingRow>;    // a single id, most recent partnership
  byCode: Map<string, RatingRow>;       // exact code
  byInitials: Map<string, RatingRow>;   // sorted initials, only where unambiguous
}

const studentsKey = (ids: number[]) => ids.slice().sort((a, b) => a - b).join("+");

/** Who competed under each code, from the stored rounds. */
export async function loadRosters(db: SupabaseClient): Promise<Map<string, { ids: number[]; start: string | null }>> {
  const out = new Map<string, { ids: number[]; start: string | null }>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("rating_games").select("code,student_ids,tourn_start,tourn_id,round_id,entry_id")
      .order("tourn_id", { ascending: true }).order("round_id", { ascending: true }).order("entry_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const g of data || []) {
      if (!g.student_ids?.length) continue;
      const prev = out.get(canonCode(g.code));
      if (!prev || (g.tourn_start || "") > (prev.start || "")) out.set(canonCode(g.code), { ids: g.student_ids, start: g.tourn_start });
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** Build the lookup. Ambiguous initial-spellings are left out rather than guessed at. */
export function buildTeamIndex(rows: RatingRow[], rosters: Map<string, { ids: number[]; start: string | null }>): TeamIndex {
  const byStudents = new Map<string, RatingRow>();
  const byStudent = new Map<string, RatingRow>();
  const byCode = new Map<string, RatingRow>();
  const initialsCount = new Map<string, Set<string>>();

  for (const r of rows) {
    const code = canonCode(r.key);
    byCode.set(code, r);
    const set = initialsCount.get(initialsKey(r.key)) || new Set<string>();
    set.add(code);
    initialsCount.set(initialsKey(r.key), set);

    const roster = rosters.get(code);
    if (roster?.ids.length) {
      byStudents.set(studentsKey(roster.ids), r);
      for (const id of roster.ids) {
        const held = byStudent.get(String(id));
        if (!held || (r.last_played || "") > (held.last_played || "")) byStudent.set(String(id), r);
      }
    }
  }

  const byInitials = new Map<string, RatingRow>();
  for (const [key, codes] of initialsCount) {
    if (codes.size === 1) {
      const only = byCode.get([...codes][0]);
      if (only) byInitials.set(key, only);
    }
  }
  return { byStudents, byStudent, byCode, byInitials };
}

/**
 * The rating a pairing debates at.
 *
 * A partnership that has competed keeps its own rating. A new pairing inherits
 * from its debaters, averaged and with the deviation widened, because two people
 * who have never debated together are a less certain quantity than either of them
 * alone. With neither, the entry is unrated and debates as the field average.
 */
export function resolveRating(
  code: string,
  studentIds: number[],
  teams: TeamIndex,
  debaters: Map<string, RatingRow>,
  /** What earlier seasons say, weighted down by how long ago they were. */
  priors?: PastPriors,
): ResolvedRating {
  // most trustworthy first: the two debaters, one debater, the exact code, then
  // the spelling of the code where only one team could possibly mean it
  // This exact pairing: both its debaters, its code, or a spelling only it could mean.
  const exact =
    (studentIds.length > 1 ? teams.byStudents.get(studentsKey(studentIds)) : undefined) ??
    teams.byCode.get(canonCode(code)) ??
    teams.byInitials.get(initialsKey(code));
  if (exact) {
    return { rating: { rating: exact.rating, rd: exact.rd, vol: exact.vol }, pointsZ: exact.points_z ?? 0, rated: true, source: "team", row: exact };
  }

  // Otherwise gather what is known about the people. A partnership found through
  // one debater is half of this pairing, not this pairing, so it informs the
  // rating rather than becoming it — and the deviation widens to say so.
  // This season's results lead. A record from earlier seasons still counts, but at
  // a fraction of the weight, so last year adjusts the number without setting it.
  const CURRENT = 1, PAST = 0.35;
  const parts: { rating: number; rd: number; vol: number; z: number; w: number }[] = [];

  // what this pairing did in earlier seasons, if it competed together then
  const teamPrior = priors?.teams.get(canonCode(code)) ?? priors?.teams.get(initialsKey(code));
  if (teamPrior) parts.push({ rating: teamPrior.rating, rd: teamPrior.rd, vol: teamPrior.vol, z: 0, w: PAST });

  for (const id of studentIds) {
    const d = debaters.get(String(id));
    if (d) parts.push({ rating: d.rating, rd: d.rd, vol: d.vol, z: d.points_z ?? 0, w: CURRENT });
    const prior = teams.byStudent.get(String(id));
    if (prior) parts.push({ rating: prior.rating, rd: prior.rd, vol: prior.vol, z: prior.points_z ?? 0, w: CURRENT });
    // and what they did in earlier seasons, whoever they debated with then
    const past = priors?.debaters.get(String(id));
    if (past) parts.push({ rating: past.rating, rd: past.rd, vol: past.vol, z: 0, w: PAST });
  }
  if (parts.length) {
    const total = parts.reduce((a, p) => a + p.w, 0);
    const mean = (pick: (p: typeof parts[number]) => number) => parts.reduce((a, p) => a + pick(p) * p.w, 0) / total;
    // nothing here is this pairing itself, so the deviation widens to say so
    const onlyPast = parts.every((p) => p.w === PAST);
    return {
      rating: { rating: mean((p) => p.rating), rd: Math.min(350, mean((p) => p.rd) + (onlyPast ? 90 : 60)), vol: mean((p) => p.vol) },
      pointsZ: mean((p) => p.z),
      rated: true,
      source: "debaters",
    };
  }
  return { rating: { ...UNRATED }, pointsZ: 0, rated: false, source: "none" };
}

/**
 * What earlier seasons say about a competitor, for the prediction to lean on.
 *
 * This is deliberately not the leaderboard. The season table counts this season
 * only; these are priors from before it, and each season back counts for less —
 * a round from three seasons ago carries a fifth of the weight of a recent one.
 * A team that broke at the TOC last year starts a new season looking strong,
 * without that result outranking anything earned since.
 */
export const PAST_SEASON_WEIGHTS = [0.6, 0.35, 0.2];   // one season back, two, three

export interface PastPriors {
  teams: Map<string, Rating>;      // canonical code
  debaters: Map<string, Rating>;   // student id
  rounds: number;
  seasons: Record<string, number>;
}

export async function pastSeasonPriors(db: SupabaseClient, season = currentSeason(), circuit: Circuit = "pf"): Promise<PastPriors> {
  await loadCircuitOverrides(db);   // tournaments said to be college (or not)
  const rows: GameRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("rating_games").select("*")
      .order("tourn_start", { ascending: true })
      .order("tourn_id", { ascending: true })
      .order("round_id", { ascending: true })
      .order("entry_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data || []) as GameRow[]));
    if (!data || data.length < PAGE) break;
  }

  const seasons: Record<string, number> = {};
  const weighted = rows.flatMap((g) => {
    if (circuitOf(g.tourn_name, g.event_name) !== circuit || !counts(circuit, g.event_name)) return [];
    const s = seasonOf(g.tourn_start);
    if (s === null || s >= season) return [];
    const back = season - s;
    const weight = PAST_SEASON_WEIGHTS[back - 1];
    if (!weight) return [];
    seasons[String(s)] = (seasons[String(s)] || 0) + 1;
    return [{ g, weight }];
  });

  // One weighted update per competitor against the field average: these are
  // priors, not a standing, so they do not need a period-by-period replay.
  const byTeam = new Map<string, Game[]>();
  const byDebater = new Map<string, Game[]>();
  for (const { g, weight } of weighted) {
    const game: Game = { opponent: { ...UNRATED }, score: g.score, weight };
    const code = canonCode(g.code);
    byTeam.set(code, [...(byTeam.get(code) || []), game]);
    for (const id of g.student_ids || []) {
      const key = String(id);
      byDebater.set(key, [...(byDebater.get(key) || []), game]);
    }
  }

  const rate = (book: Map<string, Game[]>) => {
    const out = new Map<string, Rating>();
    for (const [key, games] of book) out.set(key, update({ ...UNRATED }, games));
    return out;
  };

  return { teams: rate(byTeam), debaters: rate(byDebater), rounds: weighted.length, seasons };
}

/** Every past meeting between these teams: code -> opponent code -> {w, l}. */
export async function headToHead(db: SupabaseClient, codes: string[], circuit: Circuit = "pf"): Promise<Record<string, Record<string, { w: number; l: number }>>> {
  await loadCircuitOverrides(db);   // tournaments said to be college (or not)
  const out: Record<string, Record<string, { w: number; l: number }>> = {};
  if (!codes.length) return out;
  for (let i = 0; i < codes.length; i += 200) {
    const slice = codes.slice(i, i + 200);
    // Paged with the primary key as the order, so no meeting is counted twice or missed.
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db.from("rating_games").select("code,opp_code,score,tourn_id,round_id,entry_id,event_name,tourn_name")
        .in("code", slice)
        .order("tourn_id", { ascending: true })
        .order("round_id", { ascending: true })
        .order("entry_id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      for (const g of data || []) {
        // A JV meeting says little about a varsity one, and a Public Forum meeting
        // nothing at all about a policy one, so both filters apply here too.
        if (circuitOf(g.tourn_name, g.event_name) !== circuit || !counts(circuit, g.event_name)) continue;
        const row = (out[canonCode(g.code)] = out[canonCode(g.code)] || {});
        const cell = (row[canonCode(g.opp_code)] = row[canonCode(g.opp_code)] || { w: 0, l: 0 });
        if (g.score === 1) cell.w++; else if (g.score === 0) cell.l++;
      }
      if (!data || data.length < PAGE) break;
    }
  }
  return out;
}
