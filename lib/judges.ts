import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * How judges score.
 *
 * Most tournaments hold speaker points back until they are over, and the seeds
 * that decide every power-paired round are built from them, so mid-weekend the
 * points a team earned have to be estimated. A single round's points are mostly
 * the judge: measured on five tournaments with every point known, knowing each
 * judge's habit explains about as much again as the team's own level and the
 * result together. Who judged a round is public as soon as the decision is.
 *
 * A habit is how far a judge's points sit from what the same result earned at the
 * same tournament, on Tabroom's scale (the two speakers together). It is read
 * from every archived tournament with points posted, prelims only, and kept per
 * tournament so that one can be left out: a tournament replayed from its own
 * archive would otherwise be predicted from the answer.
 *
 * Stored in `ratings` as kind "judge", keyed by Tabroom's paradigm id, which
 * follows a judge from tournament to tournament. `points_avg` is the raw mean
 * deviation, `games` the ballots behind it, and `history` the per-tournament
 * sums it is built from.
 */

export interface JudgeBallot {
  paradigm: number;
  point: number;          // team total the judge gave
  won: boolean;
}

export interface JudgeTally { n: number; sum: number }

/** Ballots are worth a habit only with points on the usual scale; forfeits score far below it. */
const PLAUSIBLE_POINTS = 40;

/**
 * Each judge's deviation at one tournament: points given, less the tournament's
 * average for a win or a loss.
 */
export function judgeTallies(ballots: JudgeBallot[]): Map<number, JudgeTally> {
  const usable = ballots.filter((b) => b.paradigm > 0 && b.point > PLAUSIBLE_POINTS);
  const mean = (won: boolean) => {
    const xs = usable.filter((b) => b.won === won).map((b) => b.point);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  };
  const byResult = { win: mean(true), loss: mean(false) };
  const out = new Map<number, JudgeTally>();
  for (const b of usable) {
    const t = out.get(b.paradigm) || { n: 0, sum: 0 };
    t.n++;
    t.sum += b.point - (b.won ? byResult.win : byResult.loss);
    out.set(b.paradigm, t);
  }
  return out;
}

/** The ballots in one entry's records document that a habit can be read from. */
export function ballotsFromRecords(doc: {
  Rounds?: Record<string, {
    type: string; bye?: number | boolean;
    Results?: Record<string, { winloss?: string; point?: number }>;
    Judges?: Record<string, { paradigm?: number }>;
  }>;
} | null): JudgeBallot[] {
  const out: JudgeBallot[] = [];
  for (const r of Object.values(doc?.Rounds || {})) {
    if ((r.type !== "prelim" && r.type !== "highlow") || r.bye) continue;
    // Results and Judges are keyed by the same ballot id, so each point is tied
    // to the judge who gave it even on a panel.
    for (const [ballot, res] of Object.entries(r.Results || {})) {
      const paradigm = r.Judges?.[ballot]?.paradigm;
      if (!paradigm || typeof res.point !== "number" || (res.winloss !== "W" && res.winloss !== "L")) continue;
      out.push({ paradigm, point: res.point, won: res.winloss === "W" });
    }
  }
  return out;
}

/** One tournament event's share of a judge's habit; `tourn` is "tournId:eventAbbr". */
interface HistoryItem { tourn: string; start: string | null; n: number; sum: number }

/** Fold one event's tallies into the stored habits. Reading the event again replaces its share. */
export async function saveJudgeHabits(
  db: SupabaseClient, tournId: number, eventAbbr: string, start: string | null, tallies: Map<number, JudgeTally>,
): Promise<number> {
  const source = `${tournId}:${eventAbbr}`;
  const keys = [...tallies.keys()].map(String);
  const existing = new Map<string, HistoryItem[]>();
  for (let i = 0; i < keys.length; i += 200) {
    const { data, error } = await db.from("ratings").select("key,history").eq("kind", "judge").in("key", keys.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const row of data || []) existing.set(row.key, (row.history as HistoryItem[]) || []);
  }

  const rows = keys.map((key) => {
    const t = tallies.get(Number(key))!;
    const history = (existing.get(key) || []).filter((h) => h.tourn !== source);
    history.push({ tourn: source, start, n: t.n, sum: Math.round(t.sum * 100) / 100 });
    const n = history.reduce((a, h) => a + h.n, 0);
    const sum = history.reduce((a, h) => a + h.sum, 0);
    return {
      kind: "judge", key, display: "", school: null,
      games: n, tournaments: history.length,
      points_avg: n ? sum / n : null,
      last_played: history.map((h) => h.start).filter(Boolean).sort().pop() ?? null,
      history, updated_at: new Date().toISOString(),
    };
  });
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("ratings").upsert(rows.slice(i, i + 500), { onConflict: "kind,key" });
    if (error) throw new Error(error.message);
  }
  return rows.length;
}

/**
 * How many ballots of evidence a habit is worth trusting fully. A judge seen on
 * three ballots is pulled most of the way back to average, since three rounds of
 * points are mostly the teams.
 */
const HABIT_PRIOR_BALLOTS = 4;

/**
 * The habits of the given judges, as an expected points offset, leaving out one
 * tournament's share when asked.
 */
export async function loadJudgeHabits(
  db: SupabaseClient, paradigms: number[], excludeTourn?: number,
): Promise<Record<string, number>> {
  const keys = [...new Set(paradigms.filter((p) => p > 0))].map(String);
  const out: Record<string, number> = {};
  for (let i = 0; i < keys.length; i += 200) {
    const { data, error } = await db.from("ratings").select("key,history").eq("kind", "judge").in("key", keys.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      const history = ((row.history as HistoryItem[]) || []).filter((h) => excludeTourn === undefined || h.tourn.split(":")[0] !== String(excludeTourn));
      const n = history.reduce((a, h) => a + h.n, 0);
      if (!n) continue;
      out[row.key] = history.reduce((a, h) => a + h.sum, 0) / (n + HABIT_PRIOR_BALLOTS);
    }
  }
  return out;
}
