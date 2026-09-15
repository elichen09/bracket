import type { SupabaseClient } from "@supabase/supabase-js";
import { TabroomSession } from "./tabroom";

/**
 * A debater's whole competitive record, from Tabroom's per-student results page
 * (index/results/team_results.mhtml?id1=<student id>). The page needs a login and
 * renders client-side from two JSON blobs embedded in its script — `panels`
 * (every round ever debated) and `summaryTable` (partner per entry) — which is
 * exactly what we want. We parse those, never the markup.
 *
 * Fetching costs a logged-in page load per debater, so records are cached: in
 * Supabase (`student_records`, 12h) when the table exists, and in memory as a
 * fallback. One Tabroom session is shared per server instance.
 */

export interface CareerRound {
  tournId: number;
  round: string;
  elim: boolean;
  result: "W" | "L" | null;
  ballotsWon: number;
  ballotsLost: number;
  side: "Aff" | "Neg" | null;
  opponent: string;
  judge: string;
  points: number | null;
}

export interface CareerTournament {
  tournId: number;
  name: string;
  start: string;            // YYYY-MM-DD
  event: string;
  level: string;
  entryId: number;
  partner: string | null;
  rounds: CareerRound[];
  prelimW: number; prelimL: number;
  elimW: number; elimL: number;
  broke: boolean;
  deepest: string | null;   // last elim round debated
  won: boolean;             // took the final
  avgPoints: number | null;
}

export interface CareerSeason {
  label: string;            // "2025–26"
  tournaments: number;
  prelimW: number; prelimL: number;
  elimW: number; elimL: number;
  breaks: number;
  titles: number;
  avgPoints: number | null;
}

export interface CareerRecord {
  studentId: number;
  fetchedAt: string;
  tournaments: CareerTournament[];   // newest first
  seasons: CareerSeason[];           // newest first
  totals: { tournaments: number; prelimW: number; prelimL: number; elimW: number; elimL: number; breaks: number; titles: number; ballotsWon: number; ballotsLost: number; affW: number; affL: number; negW: number; negL: number; opponents: number; judges: number };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface Panel {
  ballots_lost?: number; ballots_won?: number; decision_str?: string; elim?: number; entry_id?: number;
  event_level?: string; event_name?: string; judge_raw?: string; opponent?: string; round_label?: string | number;
  round_name?: number; side?: string; speaker1_pts?: string | number; tourn?: string; tourn_id?: number; tourn_start?: string;
}

function grabJson(html: string, name: string): any {
  const key = `var ${name} = `;
  const i = html.indexOf(key);
  if (i < 0) return null;
  let j = html.indexOf("\n", i);
  if (j < 0) j = html.length;
  const text = html.slice(i + key.length, j).trim().replace(/;$/, "");
  try { return JSON.parse(text); } catch { return null; }
}

const seasonOf = (ymd: string): string => {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7));
  const start = m >= 8 ? y : y - 1;
  return `${start}–${String(start + 1).slice(2)}`;
};

/** Turn the page's embedded data into a record. Exported for tests. */
export function parseStudentRecord(html: string, studentId: number): CareerRecord {
  const panels: Record<string, Panel> = grabJson(html, "panels") || {};
  const summary: Record<string, { third_speaker?: string }> = grabJson(html, "summaryTable") || {};
  if (!Object.keys(panels).length) throw new Error("Tabroom returned no record for that debater");

  const byTourn = new Map<number, CareerTournament>();
  for (const p of Object.values(panels)) {
    if (!p || !p.tourn_id || !p.tourn_start) continue;
    let t = byTourn.get(p.tourn_id);
    if (!t) {
      t = {
        tournId: p.tourn_id, name: p.tourn || `Tournament ${p.tourn_id}`, start: p.tourn_start,
        event: p.event_name || "", level: p.event_level || "", entryId: p.entry_id || 0,
        partner: (p.entry_id && summary[String(p.entry_id)]?.third_speaker) || null,
        rounds: [], prelimW: 0, prelimL: 0, elimW: 0, elimL: 0, broke: false, deepest: null, won: false, avgPoints: null,
      };
      byTourn.set(p.tourn_id, t);
    }
    const won = Number(p.ballots_won || 0), lost = Number(p.ballots_lost || 0);
    const result: CareerRound["result"] = p.decision_str === "W" ? "W" : p.decision_str === "L" ? "L" : won > lost ? "W" : lost > won ? "L" : null;
    const pts = p.speaker1_pts === undefined || p.speaker1_pts === null || String(p.speaker1_pts).trim() === "" ? null : Number(String(p.speaker1_pts).trim());
    t.rounds.push({
      tournId: p.tourn_id, round: String(p.round_label ?? p.round_name ?? "?"), elim: Number(p.elim) === 1, result,
      ballotsWon: won, ballotsLost: lost,
      side: p.side === "Aff" || p.side === "Neg" ? p.side : null,
      opponent: (p.opponent || "").trim(), judge: (p.judge_raw || "").trim(),
      points: pts !== null && Number.isFinite(pts) ? pts : null,
    });
  }

  const tournaments = Array.from(byTourn.values()).map((t) => {
    t.rounds.sort((a, b) => Number(a.elim) - Number(b.elim) || (Number(a.round) || 0) - (Number(b.round) || 0));
    for (const r of t.rounds) {
      if (!r.result) continue;
      if (r.elim) { if (r.result === "W") t.elimW++; else t.elimL++; }
      else { if (r.result === "W") t.prelimW++; else t.prelimL++; }
    }
    const elims = t.rounds.filter((r) => r.elim);
    t.broke = elims.length > 0;
    t.deepest = elims.length ? elims[elims.length - 1].round : null;
    const last = elims[elims.length - 1];
    t.won = !!last && last.result === "W" && /final/i.test(last.round) && !/semi|quarter|octa|doub|trip|runoff/i.test(last.round);
    const pts = t.rounds.filter((r) => !r.elim && r.points !== null).map((r) => r.points as number);
    t.avgPoints = pts.length ? Math.round((pts.reduce((a, b) => a + b, 0) / pts.length) * 100) / 100 : null;
    return t;
  }).sort((a, b) => b.start.localeCompare(a.start));

  const seasonMap = new Map<string, CareerSeason & { ptsSum: number; ptsN: number }>();
  for (const t of tournaments) {
    const label = seasonOf(t.start);
    const s = seasonMap.get(label) || { label, tournaments: 0, prelimW: 0, prelimL: 0, elimW: 0, elimL: 0, breaks: 0, titles: 0, avgPoints: null, ptsSum: 0, ptsN: 0 };
    s.tournaments++; s.prelimW += t.prelimW; s.prelimL += t.prelimL; s.elimW += t.elimW; s.elimL += t.elimL;
    if (t.broke) s.breaks++; if (t.won) s.titles++;
    for (const r of t.rounds) if (!r.elim && r.points !== null) { s.ptsSum += r.points; s.ptsN++; }
    seasonMap.set(label, s);
  }
  const seasons = Array.from(seasonMap.values()).map(({ ptsSum, ptsN, ...s }) => ({ ...s, avgPoints: ptsN ? Math.round((ptsSum / ptsN) * 100) / 100 : null }))
    .sort((a, b) => b.label.localeCompare(a.label));

  const all = tournaments.flatMap((t) => t.rounds);
  const totals = {
    tournaments: tournaments.length,
    prelimW: tournaments.reduce((a, t) => a + t.prelimW, 0), prelimL: tournaments.reduce((a, t) => a + t.prelimL, 0),
    elimW: tournaments.reduce((a, t) => a + t.elimW, 0), elimL: tournaments.reduce((a, t) => a + t.elimL, 0),
    breaks: tournaments.filter((t) => t.broke).length, titles: tournaments.filter((t) => t.won).length,
    ballotsWon: all.reduce((a, r) => a + r.ballotsWon, 0), ballotsLost: all.reduce((a, r) => a + r.ballotsLost, 0),
    affW: all.filter((r) => r.side === "Aff" && r.result === "W").length, affL: all.filter((r) => r.side === "Aff" && r.result === "L").length,
    negW: all.filter((r) => r.side === "Neg" && r.result === "W").length, negL: all.filter((r) => r.side === "Neg" && r.result === "L").length,
    opponents: new Set(all.map((r) => r.opponent).filter(Boolean)).size,
    judges: new Set(all.map((r) => r.judge).filter(Boolean)).size,
  };
  return { studentId, fetchedAt: new Date().toISOString(), tournaments, seasons, totals };
}

// ---------------------------------------------------------------------------
// Fetching + cache
// ---------------------------------------------------------------------------

let session: TabroomSession | null = null;
const memory = new Map<number, { at: number; value: Promise<CareerRecord> }>();
const TTL = 12 * 3600_000;

function tabroom(): TabroomSession {
  if (session) return session;
  const u = process.env.TABROOM_USERNAME, p = process.env.TABROOM_PASSWORD;
  if (!u || !p) throw new Error("TABROOM_USERNAME / TABROOM_PASSWORD are not set");
  session = new TabroomSession(u, p);
  return session;
}

async function fetchRecord(studentId: number): Promise<CareerRecord> {
  const html = await tabroom().page(`/index/results/team_results.mhtml?id1=${studentId}`);
  return parseStudentRecord(html, studentId);
}

/** The record for one debater — from the Supabase cache, memory, or Tabroom. `fresh` skips every cache and re-pulls. */
export async function careerFor(db: SupabaseClient | null, studentId: number, fresh = false): Promise<CareerRecord> {
  const mem = memory.get(studentId);
  if (!fresh && mem && Date.now() - mem.at < TTL) return mem.value;

  if (db && !fresh) {
    try {
      const { data } = await db.from("student_records").select("payload,fetched_at").eq("student_id", studentId).maybeSingle();
      if (data && Date.now() - new Date(data.fetched_at).getTime() < TTL) {
        const rec = data.payload as CareerRecord;
        memory.set(studentId, { at: Date.now(), value: Promise.resolve(rec) });
        return rec;
      }
    } catch { /* table missing or unreachable: fall through to a live fetch */ }
  }

  const value = fetchRecord(studentId);
  memory.set(studentId, { at: Date.now(), value });
  value.catch(() => memory.delete(studentId));
  const rec = await value;
  if (db) {
    try { await db.from("student_records").upsert({ student_id: studentId, payload: rec, fetched_at: rec.fetchedAt }, { onConflict: "student_id" }); } catch { /* cache is best-effort */ }
  }
  return rec;
}
