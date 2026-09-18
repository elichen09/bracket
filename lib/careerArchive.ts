import type { SupabaseClient } from "@supabase/supabase-js";
import { careerFor } from "./career";
import type { CareerRecord, CareerTournament, CareerRound } from "./career";
import type { GameRow } from "./ratings";

/**
 * A debater's record, assembled from archived rounds rather than scraped from
 * their Tabroom page.
 *
 * Everything here comes from the public API: whole tournaments are read into
 * rating_games, and a person's history is simply their rows in it. That is
 * shallower than the page Tabroom renders — it reaches back only as far as the
 * tournaments this site has archived — but it needs no login, never gets
 * throttled, and improves every time another tournament is read in.
 *
 * The shape matches what the career charts already draw, so the same panel
 * renders either source.
 */

const seasonStart = (ymd: string): number => {
  const d = new Date(ymd);
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 7 ? y : y - 1;
};

const seasonLabel = (start: number) => `${start}–${String(start + 1).slice(2)}`;

/**
 * Roll a set of tournaments up into the seasons and totals the career panel draws.
 * Shared, so a merged record counts the same way an archived one does.
 */
export function summarise(studentId: number, list: CareerTournament[]): CareerRecord {
  const tournaments = list.slice().sort((a, b) => b.start.localeCompare(a.start));

  const bySeason = new Map<number, CareerTournament[]>();
  for (const t of tournaments) {
    const s = seasonStart(t.start);
    bySeason.set(s, [...(bySeason.get(s) || []), t]);
  }
  const seasons = [...bySeason.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([start, group]) => {
      const pts = group.flatMap((t) => t.rounds.filter((r) => !r.elim && r.points !== null).map((r) => r.points as number));
      return {
        label: seasonLabel(start),
        tournaments: group.length,
        prelimW: group.reduce((n, t) => n + t.prelimW, 0),
        prelimL: group.reduce((n, t) => n + t.prelimL, 0),
        elimW: group.reduce((n, t) => n + t.elimW, 0),
        elimL: group.reduce((n, t) => n + t.elimL, 0),
        breaks: group.filter((t) => t.broke).length,
        titles: group.filter((t) => t.won).length,
        avgPoints: pts.length ? Math.round((pts.reduce((a, b) => a + b, 0) / pts.length) * 100) / 100 : null,
      };
    });

  const all = tournaments.flatMap((t) => t.rounds);
  return {
    studentId,
    fetchedAt: new Date().toISOString(),
    tournaments,
    seasons,
    totals: {
      tournaments: tournaments.length,
      prelimW: tournaments.reduce((n, t) => n + t.prelimW, 0),
      prelimL: tournaments.reduce((n, t) => n + t.prelimL, 0),
      elimW: tournaments.reduce((n, t) => n + t.elimW, 0),
      elimL: tournaments.reduce((n, t) => n + t.elimL, 0),
      breaks: tournaments.filter((t) => t.broke).length,
      titles: tournaments.filter((t) => t.won).length,
      ballotsWon: all.reduce((n, r) => n + r.ballotsWon, 0),
      ballotsLost: all.reduce((n, r) => n + r.ballotsLost, 0),
      affW: all.filter((r) => r.side === "Aff" && r.result === "W").length,
      affL: all.filter((r) => r.side === "Aff" && r.result === "L").length,
      negW: all.filter((r) => r.side === "Neg" && r.result === "W").length,
      negL: all.filter((r) => r.side === "Neg" && r.result === "L").length,
      opponents: new Set(all.map((r) => r.opponent).filter(Boolean)).size,
      judges: 0,
    },
  };
}

/** Rounds for these debaters, newest tournament first, as career records. */
export async function careersFromArchive(db: SupabaseClient, studentIds: number[]): Promise<Map<number, CareerRecord>> {
  const out = new Map<number, CareerRecord>();
  if (!studentIds.length) return out;

  const rows: GameRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("rating_games").select("*")
      .overlaps("student_ids", studentIds)
      .order("tourn_id", { ascending: true })
      .order("round_id", { ascending: true })
      .order("entry_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data || []) as GameRow[]));
    if (!data || data.length < PAGE) break;
  }

  for (const id of studentIds) {
    const mine = rows.filter((r) => (r.student_ids || []).includes(id));
    if (!mine.length) {
      out.set(id, emptyRecord(id));
      continue;
    }

    // group into tournaments
    const byTourn = new Map<number, GameRow[]>();
    for (const r of mine) byTourn.set(r.tourn_id, [...(byTourn.get(r.tourn_id) || []), r]);

    const tournaments: CareerTournament[] = [];
    for (const [tournId, group] of byTourn) {
      const first = group[0];
      const rounds: CareerRound[] = group
        .slice()
        .sort((a, b) => Number(a.elim) - Number(b.elim) || (a.round_name ?? 0) - (b.round_name ?? 0))
        .map((g) => ({
          tournId,
          round: g.round_label || String(g.round_name ?? "?"),
          elim: g.elim,
          result: g.score === 1 ? "W" : g.score === 0 ? "L" : null,
          ballotsWon: g.ballots_for,
          ballotsLost: g.ballots_against,
          side: g.side === "Aff" || g.side === "Neg" ? g.side : null,
          opponent: g.opp_code,
          judge: "",
          points: g.points,
        }));

      const prelims = rounds.filter((r) => !r.elim);
      const elims = rounds.filter((r) => r.elim);
      const pts = prelims.map((r) => r.points).filter((x): x is number => x !== null);
      const last = elims[elims.length - 1];
      // the partner is whoever else was on the entry
      const partnerId = (first.student_ids || []).find((s) => s !== id) ?? null;

      tournaments.push({
        tournId,
        name: first.tourn_name,
        start: (first.tourn_start || "").slice(0, 10),
        event: first.event_name,
        level: "",
        entryId: first.entry_id,
        partner: partnerId ? `debater ${partnerId}` : null,
        rounds,
        prelimW: prelims.filter((r) => r.result === "W").length,
        prelimL: prelims.filter((r) => r.result === "L").length,
        elimW: elims.filter((r) => r.result === "W").length,
        elimL: elims.filter((r) => r.result === "L").length,
        broke: elims.length > 0,
        deepest: last ? last.round : null,
        won: !!last && last.result === "W" && /final/i.test(last.round) && !/semi|quarter|octa|doub|trip|runoff/i.test(last.round),
        avgPoints: pts.length ? Math.round((pts.reduce((a, b) => a + b, 0) / pts.length) * 100) / 100 : null,
      });
    }

    out.set(id, summarise(id, tournaments));  }

  return out;
}

/**
 * A debater's record for showing a person, as opposed to for rating them.
 *
 * Their own Tabroom page goes back years and is far deeper than anything this
 * site has archived, so it is asked first. When Tabroom refuses — it throttles
 * that page, and sometimes answers with an empty shell — the archived rounds
 * stand in, so the panel is thinner rather than blank.
 *
 * Ratings never come through here. Those are built only from the archive, which
 * needs no login and cannot be throttled away.
 */
export async function careersDeep(db: SupabaseClient, studentIds: number[]): Promise<Map<number, CareerRecord & { source?: "tabroom" | "archive" }>> {
  const archive = await careersFromArchive(db, studentIds);
  const out = new Map<number, CareerRecord & { source?: "tabroom" | "archive" }>();

  for (const id of studentIds) {
    let deep: CareerRecord | null = null;
    try {
      const scraped = await careerFor(db, id);
      if (!scraped.empty && scraped.tournaments.length) deep = scraped;
    } catch {
      // throttled, logged out, or offline — the archive covers it
    }
    const fallback = archive.get(id) ?? emptyRecord(id);
    out.set(id, deep ? { ...merge(id, deep, fallback), source: "tabroom" } : { ...fallback, source: "archive" });
  }
  return out;
}

/**
 * Both sources, tournament by tournament.
 *
 * Tabroom's own page reaches back years, further than anything archived here, so
 * it leads. But it is not always complete: for Emory GY's win at Coon 2026 it
 * listed the doubles and none of the four elims after it, which reads as going
 * out in the doubles rather than winning the tournament. The archive is read from
 * the results API a round at a time and had all five, so where it holds more of a
 * tournament, its rounds are the ones counted — keeping the names and partner the
 * scraped page knows and this site does not.
 */
function merge(studentId: number, deep: CareerRecord, archive: CareerRecord): CareerRecord {
  const byId = new Map(deep.tournaments.map((t) => [t.tournId, t]));
  for (const mine of archive.tournaments) {
    const theirs = byId.get(mine.tournId);
    if (theirs && theirs.rounds.length >= mine.rounds.length) continue;
    byId.set(mine.tournId, theirs ? {
      ...mine,
      name: theirs.name || mine.name,
      event: theirs.event || mine.event,
      level: theirs.level || mine.level,
      partner: theirs.partner ?? mine.partner,
    } : mine);
  }
  return summarise(studentId, [...byId.values()]);
}

function emptyRecord(studentId: number): CareerRecord {
  return {
    studentId,
    fetchedAt: new Date().toISOString(),
    empty: true,
    tournaments: [],
    seasons: [],
    totals: {
      tournaments: 0, prelimW: 0, prelimL: 0, elimW: 0, elimL: 0, breaks: 0, titles: 0,
      ballotsWon: 0, ballotsLost: 0, affW: 0, affL: 0, negW: 0, negL: 0, opponents: 0, judges: 0,
    },
  };
}
