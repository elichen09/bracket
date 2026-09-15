/**
 * Team statistics from Tabroom's public REST API (api.tabroom.com/v1). No login
 * is needed for published results; this module fetches the handful of documents
 * a tournament exposes — the field, the prelim seeds, the speaker awards, final
 * places, and one "records" document per entry — and compiles them into a single
 * shape the dossier UI can draw from.
 *
 * Everything is cached in memory per server instance and the API route adds
 * CDN cache headers, so a busy pool page never hammers Tabroom.
 */

import type { CareerRecord } from "./career";

const API = "https://api.tabroom.com/v1";

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export interface JudgeVote { name: string; paradigm: number | null; vote: "W" | "L" | null }

export interface RoundStat {
  name: number;
  label: string;
  type: "prelim" | "elim" | "bye" | "other";
  side: "Aff" | "Neg" | null;
  opponent: { id: number; code: string; seed: number | null; prelimWins: number | null } | null;
  result: "W" | "L" | "B" | null;      // B = bye
  ballots: { for: number; against: number };
  points: number | null;               // team points on the ballot (prelims)
  studentPoints: Record<string, number | null>;
  judges: JudgeVote[];
  room: string | null;
}

export interface SpeakerStat {
  studentId: number;
  name: string;
  rank: number | null;
  of: number;
  points: number | null;          // total prelim points
  pointsDropped: number | null;   // -1 high/low
  percentile: number | null;
  perRound: (number | null)[];    // aligned with stats.rounds
}

export interface FieldRow { entryId: number; code: string; seed: number; wins: number | null; points: number | null; oppSeed: number | null; place: string | null; placeRank: number | null }

export interface TeamStats {
  tournId: number;
  entryId: number;
  code: string;
  name: string;
  school: string | null;
  students: { id: number; first: string; last: string }[];
  event: { id: number; abbr: string; name: string } | null;
  seed: { rank: number; of: number; wins: number | null; points: number | null; pointsDropped: number | null; oppSeedAvg: number | null; percentile: number | null } | null;
  finalPlace: { place: string; rank: number; of: number } | null;
  rounds: RoundStat[];
  prelims: { wins: number; losses: number; byes: number; aff: { w: number; l: number }; neg: { w: number; l: number }; pointsAvg: number | null; pointsHigh: number | null; pointsLow: number | null };
  elims: { wins: number; losses: number; ballotsFor: number; ballotsAgainst: number; rounds: number };
  speakers: SpeakerStat[];
  judges: { name: string; paradigm: number | null; rounds: number; wins: number; losses: number }[];
  field: { size: number; pointsAvg: number | null; rows: FieldRow[]; speakerPoints: number[] };
  /** Each debater's full Tabroom record, keyed by student id (filled in by the API route). */
  career: Record<string, CareerRecord>;
  careerNote: string | null;
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; ttl: number; value: Promise<any> }>();

let bypass = false;
/** Run `fn` with every Tabroom API read going to the network (the results still refresh the cache). */
export async function withFreshData<T>(fn: () => Promise<T>): Promise<T> {
  const prev = bypass; bypass = true;
  try { return await fn(); } finally { bypass = prev; }
}

async function getJson<T = any>(path: string, ttlMs: number): Promise<T> {
  const hit = cache.get(path);
  if (!bypass && hit && Date.now() - hit.at < hit.ttl) return hit.value as Promise<T>;
  const value = (async () => {
    const res = await fetch(API + path, {
      headers: { accept: "application/json", "user-agent": "TheBreak bracket-pool (personal, low volume)" },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`tabroom ${res.status} for ${path}`);
    return res.json();
  })();
  cache.set(path, { at: Date.now(), ttl: ttlMs, value });
  value.catch(() => cache.delete(path));
  return value;
}

const MIN = 60_000;

interface ResultSetMeta { id: number; tag: string; label: string; entity?: string }
interface EventMeta { id: number; name: string; abbr: string; ResultSets: ResultSetMeta[] }

/** The event that owns a bracket result set, with its published result-set ids. */
export async function eventForBracket(tournId: number, resultId: number): Promise<EventMeta | null> {
  const j = await getJson<Record<string, EventMeta>>(`/rest/tourns/${tournId}/results`, 10 * MIN);
  for (const ev of Object.values(j || {})) {
    if ((ev.ResultSets || []).some((r) => r.id === resultId)) return ev;
  }
  return null;
}

export interface FieldEntry { id: number; code: string; name: string; School?: { id: number; name: string }; Students?: { id: number; firstName: string; lastName: string }[] }

/** Public tournament header: name and dates. Null if unknown. */
export async function tournMeta(tournId: number): Promise<{ id: number; name: string; start: string | null } | null> {
  try {
    const j = await getJson<{ id: number; name: string; start?: string }>(`/rest/tourns/${tournId}`, 6 * 60 * MIN);
    return j && j.id ? { id: j.id, name: j.name || "", start: j.start || null } : null;
  } catch { return null; }
}

export async function fieldFor(tournId: number, abbr: string): Promise<FieldEntry[]> {
  const j = await getJson<{ Entries?: FieldEntry[] }>(`/rest/tourns/${tournId}/events/${encodeURIComponent(abbr)}/field`, 30 * MIN);
  return j?.Entries || [];
}

export interface ResultSetDoc {
  id: number; tag: string; label: string;
  headers: Record<string, { tag: string; description: string }>;
  results: { rank: number; place: string; percentile: number; Entry: { id: number; code: string; name: string }; School?: { name: string }; Student?: { id: number; first: string; last: string }; entityName?: string; values: Record<string, string> }[];
}

export interface BracketSetDoc {
  rounds?: Record<string, { label: string; type: string; order: number; Sections?: Record<string, { bye?: number; Entries?: Record<string, { id: number; code: string }> }> }>;
}

/** The event's round list (prelims and elims, in order). Empty if unavailable. */
export async function eventRounds(tournId: number, abbr: string): Promise<{ id: number; name: number; label: string; type: string }[]> {
  try {
    const j = await getJson<{ rounds?: { id: number; name: number; label: string; type: string }[] }>(`/rest/tourns/${tournId}/events/byAbbr/${encodeURIComponent(abbr)}`, 30 * MIN);
    return (j?.rounds || []).slice().sort((a, b) => Number(a.name) - Number(b.name));
  } catch { return []; }
}

/** A published bracket result set: rounds → sections → entries. */
export async function bracketSet(tournId: number, id: number): Promise<BracketSetDoc | null> {
  try {
    const j = await getJson<BracketSetDoc[]>(`/rest/tourns/${tournId}/results/${id}`, 10 * MIN);
    return Array.isArray(j) ? j[0] || null : null;
  } catch { return null; }
}

export async function resultSet(tournId: number, id: number): Promise<ResultSetDoc | null> {
  try {
    const j = await getJson<ResultSetDoc[]>(`/rest/tourns/${tournId}/results/${id}`, 10 * MIN);
    return Array.isArray(j) ? j[0] || null : null;
  } catch { return null; }
}

interface RecordsDoc {
  id: number; code: string; name: string;
  Students: Record<string, { name: string; first: string; last: string }>;
  Event: { id: number; abbr: string; name: string };
  Rounds: Record<string, {
    id: number; type: string; label: string; name: number; side?: number; sideLabel?: string; bye?: boolean | number;
    Results?: Record<string, { id: number; winloss?: string; point?: number; Students?: Record<string, { point?: number }> }>;
    Judges?: Record<string, { name: string; first: string; last: string; paradigm?: number }>;
    Opponent?: { id: number; code: string };
    Room?: { name: string };
  }>;
}

async function records(tournId: number, entryId: number, ttl: number): Promise<RecordsDoc> {
  return getJson<RecordsDoc>(`/rest/tourns/${tournId}/entries/${entryId}/records`, ttl);
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

export function headerKey(doc: ResultSetDoc | null, test: (tag: string, desc: string) => boolean): string | null {
  if (!doc) return null;
  for (const [k, h] of Object.entries(doc.headers || {})) if (test(h.tag || "", h.description || "")) return k;
  return null;
}
export const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export interface CompileOptions {
  live: boolean;
  /** Bracket seeds by team code, from the tournament's own slot list — used when Tabroom hasn't published a seed table. */
  seeds?: Record<string, number>;
}

/**
 * Compile the dossier for one team, identified by its Tabroom code ("Emory GY").
 * `resultId` is the bracket result set the tournament was registered with; it
 * pins down the event.
 */
export async function teamStats(tournId: number, resultId: number, code: string, opts: CompileOptions): Promise<TeamStats> {
  const ttl = opts.live ? 5 * MIN : 60 * MIN;
  const ev = await eventForBracket(tournId, resultId);
  if (!ev) throw new Error("Tabroom has not published results for this event yet");
  const field = await fieldFor(tournId, ev.abbr);
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const me = field.find((e) => norm(e.code) === norm(code));
  if (!me) throw new Error(`"${code}" is not in Tabroom's field for ${ev.name}`);

  const sets = ev.ResultSets || [];
  const pick = (tag: string) => sets.filter((r) => r.tag === tag).sort((a, b) => b.id - a.id)[0];
  const [seedDoc, spkDoc, finDoc, rec] = await Promise.all([
    pick("seed") ? resultSet(tournId, pick("seed").id) : Promise.resolve(null),
    pick("speaker") ? resultSet(tournId, pick("speaker").id) : Promise.resolve(null),
    pick("final") ? resultSet(tournId, pick("final").id) : Promise.resolve(null),
    records(tournId, me.id, ttl),
  ]);

  // --- field table from the seed set --------------------------------------
  const kWins = headerKey(seedDoc, (t, d) => /^WinPm/i.test(t) || /wins in prelims/i.test(d));
  const kPtsDrop = headerKey(seedDoc, (t, d) => /-1HL/i.test(t) || /dropping 1/i.test(d));
  const kPts = headerKey(seedDoc, (t, d) => /^PtsPm$/i.test(t) || /^ ?points in prelims$/i.test(d));
  const kOpp = headerKey(seedDoc, (t, d) => /^OSdPm/i.test(t) || /opponent average seed/i.test(d));
  const seedRows = seedDoc?.results || [];
  const byEntry = new Map<number, FieldRow>();
  for (const r of seedRows) {
    byEntry.set(r.Entry.id, {
      entryId: r.Entry.id, code: r.Entry.code, seed: r.rank,
      wins: kWins ? num(r.values[kWins]) : null,
      points: kPts ? num(r.values[kPts]) : (kPtsDrop ? num(r.values[kPtsDrop]) : null),
      oppSeed: kOpp ? num(r.values[kOpp]) : null,
      place: null, placeRank: null,
    });
  }
  // No seed table (common for high-school events that only publish a bracket and
  // speaker awards): build the field from the speaker set — team points = the sum
  // of both debaters' points — and take seeds from the bracket itself.
  const kSpkTotalEarly = headerKey(spkDoc, (t, d) => /^Pts$/i.test(t) || /^speaker points in prelims$/i.test(d));
  const seedsByCode = new Map<string, number>(Object.entries(opts.seeds || {}).map(([c, n]) => [norm(c), n]));
  if (!byEntry.size && spkDoc && kSpkTotalEarly) {
    const sum = new Map<number, { code: string; pts: number }>();
    for (const r of spkDoc.results || []) {
      const v = num(r.values[kSpkTotalEarly]);
      if (v === null) continue;
      const cur = sum.get(r.Entry.id) || { code: r.Entry.code, pts: 0 };
      cur.pts += v; sum.set(r.Entry.id, cur);
    }
    const ordered = Array.from(sum.entries()).sort((a, b) => b[1].pts - a[1].pts);
    ordered.forEach(([id, v], i) => {
      byEntry.set(id, { entryId: id, code: v.code, seed: seedsByCode.get(norm(v.code)) ?? (i + 1), wins: null, points: Math.round(v.pts * 10) / 10, oppSeed: null, place: null, placeRank: null });
    });
  }
  const finRows = finDoc?.results || [];
  for (const r of finRows) {
    const row = byEntry.get(r.Entry.id);
    if (row) { row.place = r.place; row.placeRank = r.rank; }
  }
  const rows = Array.from(byEntry.values()).sort((a, b) => a.seed - b.seed);
  const pts = rows.map((r) => r.points).filter((x): x is number => x !== null);
  const fieldSize = rows.length || field.length;

  // --- the team's seed line -----------------------------------------------
  const mySeedRow = seedRows.find((r) => r.Entry.id === me.id) || null;
  let seed: TeamStats["seed"] = mySeedRow ? {
    rank: mySeedRow.rank, of: seedRows.length,
    wins: kWins ? num(mySeedRow.values[kWins]) : null,
    points: kPts ? num(mySeedRow.values[kPts]) : null,
    pointsDropped: kPtsDrop ? num(mySeedRow.values[kPtsDrop]) : null,
    oppSeedAvg: kOpp ? num(mySeedRow.values[kOpp]) : null,
    percentile: num(mySeedRow.percentile),
  } : null;
  const myFin = finRows.find((r) => r.Entry.id === me.id) || null;
  const finalPlace = myFin ? { place: myFin.place, rank: myFin.rank, of: finRows.length } : null;

  // --- rounds -------------------------------------------------------------
  const students = Object.entries(rec.Students || {}).map(([id, s]) => ({ id: Number(id), first: s.first, last: s.last }));
  const roundsRaw = Object.values(rec.Rounds || {}).sort((a, b) => Number(a.name) - Number(b.name));
  const rounds: RoundStat[] = roundsRaw.map((r) => {
    const results = Object.values(r.Results || {});
    const judges = Object.entries(r.Judges || {});
    const votes: JudgeVote[] = judges.map(([bid, j]) => {
      const b = (r.Results || {})[bid];
      const v = b?.winloss === "W" ? "W" : b?.winloss === "L" ? "L" : null;
      return { name: j.name || `${j.last}, ${j.first}`, paradigm: j.paradigm ?? null, vote: v };
    });
    const wins = results.filter((b) => b.winloss === "W").length;
    const losses = results.filter((b) => b.winloss === "L").length;
    const isElim = r.type === "elim" || r.type === "final";
    const bye = !!r.bye || (!r.Opponent && !results.length);
    let result: RoundStat["result"] = null;
    if (bye) result = "B";
    else if (wins + losses > 0) result = wins > losses ? "W" : "L";
    const pointBallot = results.find((b) => typeof b.point === "number");
    const studentPoints: Record<string, number | null> = {};
    for (const s of students) {
      const p = pointBallot?.Students?.[String(s.id)]?.point;
      studentPoints[String(s.id)] = typeof p === "number" ? p : null;
    }
    const opp = r.Opponent ? byEntry.get(r.Opponent.id) : undefined;
    return {
      name: Number(r.name), label: r.label || `Round ${r.name}`,
      type: bye ? "bye" : isElim ? "elim" : (r.type === "prelim" || r.type === "highlow") ? "prelim" : "other",
      side: r.sideLabel === "Aff" || r.sideLabel === "Neg" ? r.sideLabel : r.side === 1 ? "Aff" : r.side === 2 ? "Neg" : null,
      opponent: r.Opponent ? { id: r.Opponent.id, code: r.Opponent.code, seed: opp?.seed ?? null, prelimWins: opp?.wins ?? null } : null,
      result, ballots: { for: wins, against: losses },
      points: typeof pointBallot?.point === "number" ? pointBallot.point : null,
      studentPoints, judges: votes, room: r.Room?.name || null,
    };
  });

  const prelimRounds = rounds.filter((r) => r.type === "prelim");
  const elimRounds = rounds.filter((r) => r.type === "elim");
  const tally = (rs: RoundStat[]) => ({ w: rs.filter((r) => r.result === "W").length, l: rs.filter((r) => r.result === "L").length });
  const prelimPts = prelimRounds.map((r) => r.points).filter((x): x is number => x !== null);
  const prelims = {
    wins: tally(prelimRounds).w, losses: tally(prelimRounds).l,
    byes: rounds.filter((r) => r.type === "bye").length,
    aff: tally(prelimRounds.filter((r) => r.side === "Aff")),
    neg: tally(prelimRounds.filter((r) => r.side === "Neg")),
    pointsAvg: prelimPts.length ? prelimPts.reduce((a, b) => a + b, 0) / prelimPts.length : null,
    pointsHigh: prelimPts.length ? Math.max(...prelimPts) : null,
    pointsLow: prelimPts.length ? Math.min(...prelimPts) : null,
  };
  const elims = {
    wins: tally(elimRounds).w, losses: tally(elimRounds).l,
    ballotsFor: elimRounds.reduce((a, r) => a + r.ballots.for, 0),
    ballotsAgainst: elimRounds.reduce((a, r) => a + r.ballots.against, 0),
    rounds: elimRounds.length,
  };

  if (!seed) {
    const fromBracket = seedsByCode.get(norm(me.code));
    const mine = byEntry.get(me.id);
    const oppSeeds = prelimRounds.map((r) => r.opponent?.seed).filter((x): x is number => typeof x === "number");
    if (fromBracket || mine) {
      seed = {
        rank: fromBracket ?? mine!.seed, of: Math.max(seedsByCode.size, byEntry.size),
        wins: prelims.wins, points: mine?.points ?? null, pointsDropped: null,
        oppSeedAvg: oppSeeds.length ? Math.round((oppSeeds.reduce((a, b) => a + b, 0) / oppSeeds.length) * 100) / 100 : null,
        percentile: null,
      };
    }
  }

  // --- speakers -----------------------------------------------------------
  const kSpkTotal = headerKey(spkDoc, (t, d) => /^Pts$/i.test(t) || /^speaker points in prelims$/i.test(d));
  const kSpkDrop = headerKey(spkDoc, (t, d) => /^Pts -1HL$/i.test(t) || /-1 best/i.test(d));
  const spkRows = spkDoc?.results || [];
  const speakers: SpeakerStat[] = students.map((s) => {
    const row = spkRows.find((r) => r.Student?.id === s.id) || null;
    return {
      studentId: s.id, name: `${s.first} ${s.last}`.trim(),
      rank: row ? row.rank : null, of: spkRows.length,
      points: row && kSpkTotal ? num(row.values[kSpkTotal]) : null,
      pointsDropped: row && kSpkDrop ? num(row.values[kSpkDrop]) : null,
      percentile: row ? num(row.percentile) : null,
      perRound: rounds.map((r) => r.studentPoints[String(s.id)] ?? null),
    };
  });
  const speakerPoints = kSpkTotal ? spkRows.map((r) => num(r.values[kSpkTotal])).filter((x): x is number => x !== null) : [];

  // --- judges -------------------------------------------------------------
  const jmap = new Map<string, { name: string; paradigm: number | null; rounds: number; wins: number; losses: number }>();
  for (const r of rounds) for (const j of r.judges) {
    const k = j.paradigm ? `p${j.paradigm}` : j.name;
    const cur = jmap.get(k) || { name: j.name, paradigm: j.paradigm, rounds: 0, wins: 0, losses: 0 };
    cur.rounds++; if (j.vote === "W") cur.wins++; else if (j.vote === "L") cur.losses++;
    jmap.set(k, cur);
  }

  return {
    tournId, entryId: me.id, code: me.code, name: rec.name || me.name,
    school: me.School?.name || null,
    students,
    event: { id: ev.id, abbr: ev.abbr, name: ev.name },
    seed, finalPlace, rounds, prelims, elims, speakers,
    judges: Array.from(jmap.values()).sort((a, b) => b.rounds - a.rounds || a.name.localeCompare(b.name)),
    field: { size: fieldSize, pointsAvg: pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : null, rows, speakerPoints },
    career: {}, careerNote: null,
    fetchedAt: new Date().toISOString(),
  };
}
