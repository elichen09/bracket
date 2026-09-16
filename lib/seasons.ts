import type { SupabaseClient } from "@supabase/supabase-js";
import { careerFor, type CareerRecord } from "./career";
import { canonCode } from "./ratings";

/**
 * Four seasons of results, weighted so the current one matters most.
 *
 * The rating games table only holds tournaments this site tracks, which is a
 * handful. A debater's Tabroom record page holds everything they have ever
 * debated, so for a field of entries we read those records instead and build the
 * ratings from years of rounds rather than from one weekend.
 *
 * Each round is weighted by how old its season is. Nothing is thrown away inside
 * the window: a round from three seasons ago still counts, it just counts less
 * than one from this month.
 */

/** A debate season runs August to July, so "2025–26" starts in August 2025. */
export function seasonStart(iso: string): number {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 7 ? y : y - 1;
}

export function seasonLabel(start: number): string {
  return `${start}–${String(start + 1).slice(2)}`;
}

/** Current season full, then progressively less. Beyond this window a round is ignored. */
export const SEASON_WEIGHTS = [1, 0.6, 0.35, 0.2];

export function weightForSeason(start: number, current: number): number {
  const back = current - start;
  if (back < 0) return SEASON_WEIGHTS[0];
  return SEASON_WEIGHTS[back] ?? 0;
}

export interface WeightedRound {
  studentId: number;
  tournId: number;
  tournName: string;
  start: string;
  season: number;
  weight: number;
  elim: boolean;
  opponent: string;          // the opposing entry's code, canonicalised
  partner: string | null;    // who they debated with that weekend, when Tabroom says
  event: string;
  score: number;             // 1 win, 0 loss, 0.5 undecided
  points: number | null;     // this debater's speaker points that round
}

/**
 * Every round these debaters have on record inside the window, weighted by season.
 * Career records are cached for twelve hours, so a repeat run is cheap.
 */
export async function weightedHistory(
  db: SupabaseClient,
  studentIds: number[],
  currentSeason: number,
  onProgress?: (done: number, total: number) => void,
): Promise<{ rounds: WeightedRound[]; records: Map<number, CareerRecord>; failed: number[]; firstError: string | null }> {
  const rounds: WeightedRound[] = [];
  const records = new Map<number, CareerRecord>();
  const failed: number[] = [];
  let firstError: string | null = null;
  let done = 0;

  // Tabroom serves these pages one at a time from a single logged-in session, so
  // they are fetched in sequence rather than in parallel. A page that actually hit
  // the network is followed by a pause: asking this page for hundreds of records
  // back to back is both rude and counterproductive, since the site starts
  // answering with an empty shell instead of the record.
  const PACE_MS = 2500;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const id of studentIds) {
    const startedAt = Date.now();
    try {
      const rec = await careerFor(db, id);
      records.set(id, rec);
      if (!rec.empty) {
        for (const t of rec.tournaments) {
          const season = seasonStart(t.start);
          const weight = weightForSeason(season, currentSeason);
          if (weight <= 0) continue;
          for (const r of t.rounds) {
            if (!r.result || !r.opponent) continue;
            rounds.push({
              studentId: id,
              tournId: t.tournId,
              tournName: t.name,
              start: t.start,
              season,
              weight,
              elim: r.elim,
              opponent: canonCode(r.opponent),
              partner: t.partner,
              event: t.event,
              score: r.result === "W" ? 1 : 0,
              points: r.points,
            });
          }
        }
      }
    } catch (e: any) {
      failed.push(id);
      if (!firstError) firstError = String(e?.message || e);
    }
    done++;
    onProgress?.(done, studentIds.length);
    // a cached record returns in a few milliseconds and needs no cooling off
    if (Date.now() - startedAt > 300) await sleep(PACE_MS);
  }
  return { rounds, records, failed, firstError };
}
