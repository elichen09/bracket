import type { SupabaseClient } from "@supabase/supabase-js";
import { UNRATED, update, type Game, type Rating } from "./glicko";
import { canonCode, initialsKey, type TeamIndex } from "./ratings";
import { weightedHistory, seasonStart, SEASON_WEIGHTS } from "./seasons";

/**
 * Ratings built from a debater's own Tabroom record, four seasons deep.
 *
 * The tracked-tournament table only knows the handful of tournaments this site
 * follows, which leaves most of a big field unrated. A debater's record page
 * holds everything they have ever debated, so for the entries of a tournament we
 * read those instead and rate the people from years of rounds.
 *
 * Older seasons count less rather than not at all: a round from three seasons ago
 * is fed in at a fifth of the weight of one from this season, so it still shapes
 * the rating without deciding it.
 *
 * These are written under their own rating kind. The tracked-tournament pass
 * rewrites every `debater` row from scratch, so career ratings live beside them
 * as `career` rather than being overwritten each time results come in.
 */

export const CAREER_KIND = "career";

export interface CareerRatingResult {
  rated: number;
  noRecord: number;
  failed: number;
  firstError: string | null;    // why fetches failed, when any did
  rounds: number;
  seasons: Record<string, number>;
}

/** The season a date falls in, as the ratings mean it. */
export function currentSeasonFor(date = new Date()): number {
  return seasonStart(date.toISOString());
}

/**
 * Rate these debaters from their own histories and store the result.
 * `teams` is used to value the opposition: an opponent is named only by its entry
 * code, so its rating is whatever this site knows that code to be worth.
 */
export async function rateFromCareers(
  db: SupabaseClient,
  people: { id: number; name: string; school?: string | null }[],
  teams: TeamIndex,
  opts: { currentSeason?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<CareerRatingResult> {
  const currentSeason = opts.currentSeason ?? currentSeasonFor();
  const ids = people.map((p) => p.id);
  const { rounds, records, failed, firstError } = await weightedHistory(db, ids, currentSeason, opts.onProgress);

  const byStudent = new Map<number, typeof rounds>();
  for (const r of rounds) {
    const list = byStudent.get(r.studentId) || [];
    list.push(r);
    byStudent.set(r.studentId, list);
  }

  const opponentRating = (code: string): Rating => {
    const row = teams.byCode.get(canonCode(code)) ?? teams.byInitials.get(initialsKey(code));
    return row ? { rating: row.rating, rd: row.rd, vol: row.vol } : { ...UNRATED };
  };

  const seasons: Record<string, number> = {};
  const rows: any[] = [];

  for (const p of people) {
    const mine = byStudent.get(p.id);
    if (!mine?.length) continue;

    // oldest first, so the rating walks forward through their career
    mine.sort((a, b) => a.start.localeCompare(b.start));
    const games: Game[] = mine.map((r) => {
      seasons[String(r.season)] = (seasons[String(r.season)] || 0) + 1;
      return { opponent: opponentRating(r.opponent), score: r.score, weight: r.weight };
    });

    let rating: Rating = { ...UNRATED };
    // one update per season, so recent form moves the number more than old form
    const bySeason = new Map<number, Game[]>();
    mine.forEach((r, i) => {
      const list = bySeason.get(r.season) || [];
      list.push(games[i]);
      bySeason.set(r.season, list);
    });
    for (const season of Array.from(bySeason.keys()).sort((a, b) => a - b)) {
      rating = update(rating, bySeason.get(season)!);
    }

    const wins = mine.filter((r) => r.score === 1).length;
    const losses = mine.filter((r) => r.score === 0).length;
    const pts = mine.map((r) => r.points).filter((x): x is number => x !== null);
    const rec = records.get(p.id);

    rows.push({
      kind: CAREER_KIND,
      key: String(p.id),
      display: p.name || `Debater ${p.id}`,
      school: p.school ?? null,
      rating: rating.rating,
      rd: rating.rd,
      vol: rating.vol,
      games: mine.length,
      wins,
      losses,
      tournaments: rec ? rec.tournaments.length : new Set(mine.map((r) => r.tournId)).size,
      points_avg: pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : null,
      points_z: null,
      last_played: mine[mine.length - 1]?.start ?? null,
      history: (rec?.seasons ?? []).slice(0, 6).map((s) => ({
        tourn: s.label, start: null, rating: Math.round(rating.rating), rd: Math.round(rating.rd), w: s.prelimW + s.elimW, l: s.prelimL + s.elimL,
      })),
      updated_at: new Date().toISOString(),
    });
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("ratings").upsert(rows.slice(i, i + 500), { onConflict: "kind,key" });
    if (error) throw new Error(error.message);
  }

  return {
    rated: rows.length,
    noRecord: people.length - rows.length - failed.length,
    failed: failed.length,
    firstError,
    rounds: rounds.length,
    seasons,
  };
}

/** What the weights mean, for the interface to explain itself. */
export function seasonWeightTable(currentSeason: number): { season: string; weight: number }[] {
  return SEASON_WEIGHTS.map((w, i) => ({
    season: `${currentSeason - i}–${String(currentSeason - i + 1).slice(2)}`,
    weight: w,
  }));
}
