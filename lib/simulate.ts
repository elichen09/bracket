import { expectedScore, UNRATED, type Rating } from "./glicko";

/**
 * A predicted tournament, for pools that have not debated yet.
 *
 * Prelims run the way they actually run: the first two rounds are randomly
 * paired, and every round after that is power-paired, so 2-0s meet 2-0s and
 * 1-1s meet 1-1s. Then everyone at or above the break record debates elims.
 *
 * A round is decided by the Glicko-2 expectation between the two entries, then
 * adjusted two ways the ratings alone do not capture:
 *   - speaker-point form, as a small shift from each team's mean z-score;
 *   - head to head, so a team that has actually beaten this opponent before is
 *     given some of that back, weighted by how many times they have met.
 * The result stays a probability, so favourites lose at a believable rate.
 */

export interface SimTeam {
  code: string;
  school: string | null;
  seed: number;                 // entry order, used only to break ties
  rating: Rating;
  pointsZ: number;              // mean speaker-point z-score, 0 when unknown
  rated: boolean;               // false when this entry has no rating history
  source: "team" | "debaters" | "none";   // where that rating came from
}

export interface SimConfig {
  prelims: number;              // 6 at Yale
  randomRounds: number;         // first N prelims paired at random, then power-paired
  breakWins: number;            // all teams with at least this many wins break (4)
  runs: number;                 // Monte Carlo runs
  headToHead: Record<string, Record<string, { w: number; l: number }>>;
  seed?: number;                // deterministic runs when given
}

export interface SimRound { round: number; code: string; opp: string; won: boolean; recordBefore: string }
/** One entry's simulated weekend. `seed` is where they finished the prelims, 1 being first. */
export interface SimEntryResult { code: string; wins: number; losses: number; seed: number; rounds: SimRound[] }
export interface SimElimMatch { round: string; a: string | null; b: string | null; winner: string | null; bye: boolean }

export interface SimSample {
  prelims: SimEntryResult[];
  breakField: { code: string; wins: number; losses: number; seed: number }[];
  elims: SimElimMatch[][];
  champion: string | null;
}

export interface SimOdds {
  code: string;
  school: string | null;
  rating: number;
  rated: boolean;
  breakPct: number;
  champPct: number;
  finalPct: number;
  semiPct: number;
  meanWins: number;
  recordSpread: Record<string, number>;   // "6-0" -> how many runs ended there
}

export interface SimResult {
  odds: SimOdds[];
  sample: SimSample;
  runs: number;
  breakSizeAvg: number;
  config: { prelims: number; breakWins: number; randomRounds: number };
}

// ---------------------------------------------------------------------------
// deterministic random
// ---------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Tabroom emits stray double spaces in codes, so head-to-head is keyed canonically. */
const canon = (code: string) => code.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Probability `a` beats `b`. Glicko first, then the two adjustments, kept small
 * so they colour the pick rather than overturn the ratings.
 */
export function winChance(a: SimTeam, b: SimTeam, h2h: SimConfig["headToHead"]): number {
  let p = expectedScore(a.rating, b.rating);

  // speaker-point form: a full standard deviation of edge is worth ~6 points of probability
  const form = (a.pointsZ - b.pointsZ) * 0.06;
  p += form;

  // head to head between these two specific teams
  const rec = h2h[canon(a.code)]?.[canon(b.code)];
  if (rec && rec.w + rec.l > 0) {
    const n = rec.w + rec.l;
    const observed = rec.w / n;
    const weight = Math.min(0.25, 0.08 * n);           // caps at a quarter of the answer
    p = p * (1 - weight) + observed * weight;
  }

  return Math.max(0.03, Math.min(0.97, p));
}

// ---------------------------------------------------------------------------
// one tournament
// ---------------------------------------------------------------------------

interface Standing { team: SimTeam; wins: number; losses: number; speaks: number; met: Set<string>; rounds: SimRound[] }

/**
 * Speaker points for one round. Centred on what this team usually earns, a little
 * higher for winning, and with enough spread that two teams on the same record do
 * not always seed the same way — which is the point of seeding on speaks at all.
 */
function roundSpeaks(team: SimTeam, won: boolean, rand: () => number): number {
  const noise = (rand() + rand() + rand() - 1.5) * 0.9;   // roughly normal, about ±1
  return 28.5 + team.pointsZ * 0.6 + (won ? 0.3 : 0) + noise;
}

function pairRandom(pool: Standing[], rand: () => number): [Standing, Standing][] {
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const out: [Standing, Standing][] = [];
  for (let i = 0; i + 1 < shuffled.length; i += 2) out.push([shuffled[i], shuffled[i + 1]]);
  return out;
}

/** Power pairing: inside each win bracket, pair teams off, avoiding rematches where possible. */
function pairPower(pool: Standing[], rand: () => number): [Standing, Standing][] {
  const brackets = new Map<number, Standing[]>();
  for (const s of pool) {
    const b = brackets.get(s.wins) || [];
    b.push(s);
    brackets.set(s.wins, b);
  }
  const out: [Standing, Standing][] = [];
  let carry: Standing | null = null;
  for (const wins of Array.from(brackets.keys()).sort((a, b) => b - a)) {
    let group = brackets.get(wins)!.slice();
    for (let i = group.length - 1; i > 0; i--) {     // shuffle inside the bracket
      const j = Math.floor(rand() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
    if (carry) { group.unshift(carry); carry = null; }
    while (group.length > 1) {
      const a = group.shift()!;
      let idx = group.findIndex((c) => !a.met.has(c.team.code));
      if (idx < 0) idx = 0;
      out.push([a, group.splice(idx, 1)[0]]);
    }
    if (group.length) carry = group[0];              // odd team drops to the next bracket
  }
  return out;
}

/**
 * Standard "rainbow" bracket order for a field of `size` seeds: 1, 8, 4, 5, 2, 7,
 * 3, 6 for eight, and so on. Adjacent slots meet, so the top seed draws the
 * bottom one and the top two seeds can only meet in the final. Byes fall to the
 * top seeds naturally, because the seeds beyond the break sit opposite them.
 */
function seedOrder(size: number): number[] {
  let arr = [1];
  while (arr.length < size) {
    const n = arr.length * 2;
    const next: number[] = [];
    for (const s of arr) next.push(s, n + 1 - s);
    arr = next;
  }
  return arr;
}

const ROUND_NAMES = ["Finals", "Semifinals", "Quarterfinals", "Octafinals", "Double Octas", "Triple Octas", "Quadruple Octas"];

function elimRoundName(matches: number): string {
  const i = Math.log2(matches);
  return Number.isInteger(i) && ROUND_NAMES[i] ? ROUND_NAMES[i] : `Round of ${matches * 2}`;
}

function runOnce(teams: SimTeam[], cfg: SimConfig, rand: () => number, keepSample: boolean) {
  const standings: Standing[] = teams.map((team) => ({ team, wins: 0, losses: 0, speaks: 0, met: new Set<string>(), rounds: [] }));
  const byCode = new Map(standings.map((s) => [s.team.code, s]));

  for (let round = 1; round <= cfg.prelims; round++) {
    const pairs = round <= cfg.randomRounds ? pairRandom(standings, rand) : pairPower(standings, rand);
    const paired = new Set<string>();
    for (const [x, y] of pairs) {
      paired.add(x.team.code); paired.add(y.team.code);
      const p = winChance(x.team, y.team, cfg.headToHead);
      const xWins = rand() < p;
      const before = `${x.wins}-${x.losses}`, beforeY = `${y.wins}-${y.losses}`;
      if (xWins) { x.wins++; y.losses++; } else { y.wins++; x.losses++; }
      x.speaks += roundSpeaks(x.team, xWins, rand);
      y.speaks += roundSpeaks(y.team, !xWins, rand);
      x.met.add(y.team.code); y.met.add(x.team.code);
      if (keepSample) {
        x.rounds.push({ round, code: x.team.code, opp: y.team.code, won: xWins, recordBefore: before });
        y.rounds.push({ round, code: y.team.code, opp: x.team.code, won: !xWins, recordBefore: beforeY });
      }
    }
    // an odd field leaves one team unpaired: that is a bye, and a bye is a win
    for (const s of standings) {
      if (!paired.has(s.team.code)) {
        s.wins++;
        s.speaks += roundSpeaks(s.team, true, rand);   // a bye is scored as an average round
        if (keepSample) s.rounds.push({ round, code: s.team.code, opp: "bye", won: true, recordBefore: `${s.wins - 1}-${s.losses}` });
      }
    }
  }

  // seeding: wins first, then speaker form, then entry order
  // wins first, then speaker points inside each win bracket, exactly as a real
  // tournament seeds: two 6-0 teams are separated by the speaks they earned
  const seeded = standings.slice().sort((a, b) =>
    b.wins - a.wins || b.speaks - a.speaks || a.team.seed - b.team.seed);
  const broke = seeded.filter((s) => s.wins >= cfg.breakWins);

  // Byes to the top seeds until the field is a power of two, laid out in the
  // standard rainbow order so the bracket behaves like a real one: the top seed
  // meets the bottom, and the top two seeds can only meet in the final.
  let size = 1;
  while (size < broke.length) size *= 2;
  const field: (Standing | null)[] = seedOrder(size).map((seed) => broke[seed - 1] ?? null);

  const elims: SimElimMatch[][] = [];
  let alive: (Standing | null)[] = field;
  while (alive.length > 1) {
    const next: (Standing | null)[] = [];
    const matches: SimElimMatch[] = [];
    const name = elimRoundName(alive.length / 2);
    for (let i = 0; i < alive.length / 2; i++) {
      const a = alive[2 * i];                               // adjacent slots meet, as the order intends
      const b = alive[2 * i + 1];
      if (a && b) {
        const p = winChance(a.team, b.team, cfg.headToHead);
        const aWins = rand() < p;
        const w = aWins ? a : b;
        next.push(w);
        matches.push({ round: name, a: a.team.code, b: b.team.code, winner: w.team.code, bye: false });
      } else {
        const w = a || b;
        next.push(w);
        matches.push({ round: name, a: a?.team.code ?? null, b: b?.team.code ?? null, winner: w?.team.code ?? null, bye: true });
      }
    }
    elims.push(matches);
    alive = next;
  }

  const champion = alive[0]?.team.code ?? null;
  return { standings, seeded, broke, elims, champion, byCode };
}

// ---------------------------------------------------------------------------
// many tournaments
// ---------------------------------------------------------------------------

export function simulate(teams: SimTeam[], cfg: SimConfig): SimResult {
  const rand = rng(cfg.seed ?? Math.floor(Math.random() * 2 ** 31));
  const tally = new Map<string, { breaks: number; champ: number; final: number; semi: number; wins: number; records: Record<string, number> }>();
  for (const t of teams) tally.set(t.code, { breaks: 0, champ: 0, final: 0, semi: 0, wins: 0, records: {} });

  let breakSizeTotal = 0;
  for (let run = 0; run < cfg.runs; run++) {
    const { standings, broke, elims, champion } = runOnce(teams, cfg, rand, false);
    breakSizeTotal += broke.length;
    for (const s of standings) {
      const t = tally.get(s.team.code)!;
      t.wins += s.wins;
      const rec = `${s.wins}-${s.losses}`;
      t.records[rec] = (t.records[rec] || 0) + 1;
    }
    for (const s of broke) tally.get(s.team.code)!.breaks++;
    if (champion) tally.get(champion)!.champ++;
    const finalRound = elims[elims.length - 1];
    if (finalRound) for (const m of finalRound) { if (m.a) tally.get(m.a)!.final++; if (m.b) tally.get(m.b)!.final++; }
    const semiRound = elims[elims.length - 2];
    if (semiRound) for (const m of semiRound) { if (m.a) tally.get(m.a)!.semi++; if (m.b) tally.get(m.b)!.semi++; }
  }

  // one full tournament to show underneath the odds
  const one = runOnce(teams, cfg, rand, true);
  const sample: SimSample = {
    prelims: one.seeded.map((s, i) => ({ code: s.team.code, wins: s.wins, losses: s.losses, seed: i + 1, rounds: s.rounds })),
    breakField: one.broke.map((s, i) => ({ code: s.team.code, wins: s.wins, losses: s.losses, seed: i + 1 })),
    elims: one.elims,
    champion: one.champion,
  };

  const odds: SimOdds[] = teams.map((t) => {
    const x = tally.get(t.code)!;
    return {
      code: t.code, school: t.school, rating: Math.round(t.rating.rating), rated: t.rated,
      breakPct: (x.breaks / cfg.runs) * 100,
      champPct: (x.champ / cfg.runs) * 100,
      finalPct: (x.final / cfg.runs) * 100,
      semiPct: (x.semi / cfg.runs) * 100,
      meanWins: x.wins / cfg.runs,
      recordSpread: x.records,
    };
  }).sort((a, b) => b.breakPct - a.breakPct || b.champPct - a.champPct || b.meanWins - a.meanWins);

  return { odds, sample, runs: cfg.runs, breakSizeAvg: breakSizeTotal / cfg.runs, config: { prelims: cfg.prelims, breakWins: cfg.breakWins, randomRounds: cfg.randomRounds } };
}

/**
 * Build a simulated entry from a resolved rating: the partnership's own if it has
 * one, otherwise its debaters', otherwise the field average. An entry with no
 * history debates as an average unrated team, which is the honest default.
 */
export function teamFrom(
  code: string,
  school: string | null,
  seed: number,
  resolved: { rating: { rating: number; rd: number; vol: number }; pointsZ: number; rated: boolean; source: "team" | "debaters" | "none" } | null,
): SimTeam {
  return {
    code, school, seed,
    rating: resolved ? { ...resolved.rating } : { ...UNRATED },
    pointsZ: resolved?.pointsZ ?? 0,
    rated: !!resolved?.rated,
    source: resolved?.source ?? "none",
  };
}
