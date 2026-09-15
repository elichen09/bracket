import type { Picks, Results, Tournament } from "./types";

/**
 * The bracket engine. Pure functions, shared by the browser (rendering, live
 * scoring) and the API routes (validating picks, pruning, locking).
 */

export interface Team {
  seed: number;
  name: string;
}

export interface Match {
  a: Team | null;
  b: Team | null;
  bye: boolean;
  winner: Team | null;
  loser: Team | null;
  official: { margin: string; side: string } | null;
}

export interface Model {
  entries: (Team | null)[];
  size: number;
  rounds: number;
  first: number;         // matches in the opening round
  locked: number;        // leading rounds that are truth, not picks
  names: string[];
  pts: number[];         // base points per round (0 for locked rounds)
  results: Results;
  gapDiv: number;        // seeds of gap per upset-bonus point
  baseTotal: number;     // points available without bonuses
  totalPicks: number;
  teamCount: number;
  byes: number;
}

const ROUND_BY_MATCHES: Record<number, string> = {
  64: "Runoff", 32: "Triple Octas", 16: "Double Octas", 8: "Octafinals",
  4: "Quarterfinals", 2: "Semifinals", 1: "Finals",
};

export function parseSlot(raw: string): Team | null {
  if (!raw) return null;
  const m = String(raw).match(/^(\d+)\.\s*(.+)$/);
  return m ? { seed: Number(m[1]), name: m[2].trim() } : { seed: 0, name: String(raw) };
}

export function model(t: Pick<Tournament, "slots" | "results" | "locked_rounds">): Model {
  const slots = t.slots || [];
  const size = slots.length;
  const rounds = size ? Math.round(Math.log(size) / Math.log(2)) : 0;
  const first = size / 2;
  const locked = Math.min(Number(t.locked_rounds) || 0, Math.max(rounds - 1, 0));
  const names: string[] = [];
  const pts: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const n = first >> r;
    names.push(ROUND_BY_MATCHES[n] || `Round of ${n * 2}`);
    pts.push(r < locked ? 0 : Math.pow(2, r - locked));
  }
  const entries = slots.map(parseSlot);
  const byes = entries.filter((e) => !e).length;
  let lockedMatches = 0;
  for (let q = 0; q < locked; q++) lockedMatches += first >> q;
  if (locked > 0) lockedMatches -= byes;
  return {
    entries, size, rounds, first, locked, names, pts,
    results: t.results || {},
    gapDiv: size >= 64 ? 8 : 4,
    baseTotal: rounds ? (rounds - locked) * (first >> locked) : 0,
    totalPicks: size ? size - 1 - byes - lockedMatches : 0,
    teamCount: size - byes,
    byes,
  };
}

/** Upset bonus: 1 point per `gapDiv` seeds of gap, capped at twice the round's base value. */
export function bonusFor(M: Model, r: number, winner: Team | null, loser: Team | null): number {
  if (!winner || !loser || winner.seed <= loser.seed) return 0;
  return Math.min(Math.floor((winner.seed - loser.seed) / M.gapDiv), M.pts[r] * 2);
}

/** New brackets close once any result lands in the first scored round. */
export function entriesClosed(M: Model): boolean {
  return Object.keys(M.results[String(M.locked)] || {}).length > 0;
}

/**
 * Resolve the bracket round by round.
 *  - "real":  winners come only from reported results.
 *  - "picks": winners follow `pm`, except in locked rounds, which follow results.
 */
export function build(M: Model, mode: "real" | "picks", pm: Picks = {}): Match[][] {
  const out: Match[][] = [];
  let field = M.entries.slice();
  for (let r = 0; r < M.rounds; r++) {
    const n = M.first >> r;
    const matches: Match[] = [];
    const next: (Team | null)[] = [];
    const rr = M.results[String(r)] || {};
    for (let m = 0; m < n; m++) {
      const a = field[2 * m] ?? null;
      const b = field[2 * m + 1] ?? null;
      const bye = r === 0 && !!a !== !!b;
      const res = rr[String(m)];
      let winner: Team | null = null;
      let loser: Team | null = null;
      let official: Match["official"] = null;
      if (bye) {
        winner = a || b;
      } else if (a && b && res && (mode === "real" || r < M.locked)) {
        winner = a.seed === res[0] ? a : b;
        loser = winner === a ? b : a;
        official = { margin: res[1], side: res[2] };
      } else if (a && b && mode === "picks") {
        const p = pm[`${r}:${m}`];
        if (p === a.seed) winner = a;
        else if (p === b.seed) winner = b;
        loser = winner ? (winner === a ? b : a) : null;
      }
      matches.push({ a, b, bye, winner, loser, official });
      next.push(winner);
    }
    out.push(matches);
    field = next;
  }
  return out;
}

export function eliminated(real: Match[][]): Record<number, true> {
  const dead: Record<number, true> = {};
  real.forEach((ms) => ms.forEach((mt) => { if (mt.winner && mt.loser) dead[mt.loser.seed] = true; }));
  return dead;
}

export interface Score {
  pts: number; base: number; bonus: number;
  correct: number; judged: number; made: number; live: number;
  rounds: { correct: number; judged: number; pts: number }[];
}

export function score(M: Model, mine: Match[][], real: Match[][], dead: Record<number, true>): Score {
  const s: Score = { pts: 0, base: 0, bonus: 0, correct: 0, judged: 0, made: 0, live: 0, rounds: [] };
  for (let r = 0; r < M.rounds; r++) {
    const row = { correct: 0, judged: 0, pts: 0 };
    for (let m = 0; m < real[r].length; m++) {
      const truth = real[r][m];
      const pick = mine[r][m].winner;
      if (truth.bye || r < M.locked) continue;
      if (pick) s.made++;
      if (truth.winner) {
        row.judged++; s.judged++;
        if (pick && pick.seed === truth.winner.seed) {
          const b = bonusFor(M, r, truth.winner, truth.loser);
          row.correct++; row.pts += M.pts[r] + b;
          s.correct++; s.base += M.pts[r]; s.bonus += b;
        }
      } else if (!pick || !dead[pick.seed]) {
        s.live += M.pts[r];
      }
    }
    s.rounds.push(row);
  }
  s.pts = s.base + s.bonus;
  return s;
}

export interface Progress {
  real: Match[][];
  liveRound: number | null;
  done: number;
  total: number;
  champ: Team | null;
  complete: boolean;
}

export function progress(M: Model): Progress {
  const real = build(M, "real");
  let live: number | null = null, total = 0, done = 0;
  for (let r = 0; r < M.rounds; r++) for (let m = 0; m < real[r].length; m++) {
    const mt = real[r][m];
    if (mt.bye) continue;
    total++;
    if (mt.winner) done++;
    else if (live === null) live = r;
  }
  const champ = M.rounds ? real[M.rounds - 1][0].winner : null;
  return { real, liveRound: live, done, total, champ, complete: !!champ };
}

/** Drop picks that no longer name one of the match's entrants (after an upstream change). */
export function prune(M: Model, picks: Picks): Picks {
  const out: Picks = { ...picks };
  for (let pass = 0; pass < M.rounds; pass++) {
    const mine = build(M, "picks", out);
    let changed = false;
    for (let r = 0; r < M.rounds; r++) for (let m = 0; m < mine[r].length; m++) {
      const key = `${r}:${m}`;
      const p = out[key];
      if (p === undefined) continue;
      const mt = mine[r][m];
      const ok = (mt.a && mt.a.seed === p) || (mt.b && mt.b.seed === p);
      if (!ok || mt.bye || r < M.locked) { delete out[key]; changed = true; }
    }
    if (!changed) break;
  }
  return out;
}

/** Keep only well-formed keys with numeric seeds. */
export function cleanPicks(obj: unknown, rounds = 64): Picks {
  const out: Picks = {};
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const m = k.match(/^(\d+):(\d+)$/);
      if (m && Number(m[1]) < rounds && typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}

/**
 * Matches whose real result is already in cannot be re-picked. Returns the keys
 * in `next` that differ from `prev` on a decided match.
 */
export function illegalChanges(M: Model, prev: Picks, next: Picks): string[] {
  const real = build(M, "real");
  const bad: string[] = [];
  for (let r = 0; r < M.rounds; r++) for (let m = 0; m < real[r].length; m++) {
    const key = `${r}:${m}`;
    if (real[r][m].winner && !real[r][m].bye && prev[key] !== next[key]) bad.push(key);
  }
  return bad;
}
