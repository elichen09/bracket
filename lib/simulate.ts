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

/** One prelim round that has already been posted, from this team's side of it. */
export interface KnownPrelim {
  round: number;
  opp: string | null;
  won: boolean | null;          // null when paired but not yet decided
  points: number | null;
  bye: boolean;
}

/**
 * What the tournament has already done. A round in here is not simulated: it is
 * applied, so every later round pairs from the standings that actually exist.
 */
/** One elim match as it was actually drawn, and its result if there is one. */
export interface KnownElimMatch { a: string | null; b: string | null; winner: string | null }
export interface KnownElimStage { label: string; matches: KnownElimMatch[] }

export interface KnownState {
  prelims: Record<string, KnownPrelim[]>;      // entry code -> its posted rounds
  prelimsDone: number;
  pendingRound: number | null;                 // paired but not yet debated
  brokeCodes: string[] | null;                 // the real break field, once elims start
  /**
   * The bracket as it was really drawn, in order. A bracket that exists is not
   * re-seeded: a tournament's own draw is the truth, and rebuilding it from
   * seeds would invent matchups that never happened. Stages with no winner are
   * simulated in place; stages past the end of this list are drawn from the
   * survivors.
   */
  elimStages: KnownElimStage[];
}

export interface SimConfig {
  prelims: number;              // 6 at Yale
  randomRounds: number;         // first N prelims paired at random, then power-paired
  breakWins: number;            // all teams with at least this many wins break (4)
  runs: number;                 // Monte Carlo runs
  headToHead: Record<string, Record<string, { w: number; l: number }>>;
  seed?: number;                // deterministic runs when given
  known?: KnownState;           // rounds already debated, applied rather than guessed
  breakCap?: number;            // ceiling on the break field, cutting the last record bracket on speaks
  seedJitter?: number;          // how far a pairing wanders from seed order; see SEED_JITTER
}

/**
 * One round as the simulation ran it, with the reasoning kept alongside the
 * result: `chance` is what the model gave this team before the round, and the
 * rest is where that number came from.
 */
export interface SimRound {
  round: number; code: string; opp: string; won: boolean; recordBefore: string;
  chance: number;          // this team's chance of winning, before the round
  base: number;            // the part of it that came from the two ratings
  form: number;            // what speaker-point form moved it, signed
  h2h: number;             // what previous meetings moved it, signed
  h2hW: number; h2hL: number;   // this team's record against that opponent
  rating: number; oppRating: number;
  actual?: boolean;        // true when this round was debated, not simulated
}
/** One entry's simulated weekend. `seed` is where they finished the prelims, 1 being first. */
export interface SimEntryResult { code: string; wins: number; losses: number; seed: number; rounds: SimRound[] }
export interface SimElimMatch {
  round: string; a: string | null; b: string | null; winner: string | null; bye: boolean;
  chance: number | null;   // chance `a` won, null for a bye
  form: number; h2hW: number; h2hL: number;
  aRating: number; bRating: number;
}

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

/** Who a team is likely to draw in the next round that has not been debated. */
export interface NextRound {
  round: number;
  published: boolean;      // true when Tabroom has already posted the pairing
  matchups: { code: string; wins: number; losses: number; opponents: { opp: string; pct: number }[] }[];
}

export interface SimResult {
  odds: SimOdds[];
  sample: SimSample;
  runs: number;
  breakSizeAvg: number;
  config: { prelims: number; breakWins: number; randomRounds: number };
  nextRound: NextRound | null;
  /** How much of the tournament was fact rather than estimate. */
  known: { prelimsDone: number; entriesWithResults: number } | null;
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
export interface WinBreakdown {
  p: number;          // chance `a` wins, after everything
  base: number;       // the Glicko expectation on its own
  form: number;       // what speaker-point form moved it, signed
  h2h: number;        // what previous meetings moved it, signed
  w: number; l: number;   // `a`'s record against `b`
}

/**
 * The estimate, with its parts kept.
 *
 * A probability on its own is not an explanation. Keeping the three terms apart
 * lets the page say which one actually decided the round: a rating gap, a team
 * that speaks better, or a result these two have already produced.
 */
export function breakdown(a: SimTeam, b: SimTeam, h2h: SimConfig["headToHead"]): WinBreakdown {
  const base = expectedScore(a.rating, b.rating);

  // speaker-point form: a full standard deviation of edge is worth ~6 points of probability
  const form = (a.pointsZ - b.pointsZ) * 0.06;
  const afterForm = base + form;
  let p = afterForm;

  // head to head between these two specific teams
  const rec = h2h[canon(a.code)]?.[canon(b.code)];
  let w = 0, l = 0;
  if (rec && rec.w + rec.l > 0) {
    w = rec.w; l = rec.l;
    const n = w + l;
    const observed = w / n;
    const weight = Math.min(0.25, 0.08 * n);           // caps at a quarter of the answer
    p = p * (1 - weight) + observed * weight;
  }

  return { p: Math.max(0.03, Math.min(0.97, p)), base, form, h2h: p - afterForm, w, l };
}

/** Probability `a` beats `b`, when the reasoning behind it is not needed. */
export function winChance(a: SimTeam, b: SimTeam, h2h: SimConfig["headToHead"]): number {
  return breakdown(a, b, h2h).p;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** One side's view of a breakdown; `flip` turns it around for the other team. */
function sideOf(bd: WinBreakdown, self: SimTeam, opp: SimTeam, flip: boolean) {
  return {
    chance: r3(flip ? 1 - bd.p : bd.p),
    base: r3(flip ? 1 - bd.base : bd.base),
    form: r3(flip ? -bd.form : bd.form),
    h2h: r3(flip ? -bd.h2h : bd.h2h),
    h2hW: flip ? bd.l : bd.w,
    h2hL: flip ? bd.w : bd.l,
    rating: Math.round(self.rating.rating),
    oppRating: Math.round(opp.rating.rating),
  };
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

/** This team's posted round, if that round has been posted for them. */
function knownFor(known: SimConfig["known"], code: string, round: number): KnownPrelim | null {
  if (!known) return null;
  const list = known.prelims[code];
  if (!list) return null;
  for (const r of list) if (r.round === round) return r;
  return null;
}

/**
 * Pair the teams that still have to debate this round.
 *
 * A pairing Tabroom has already published is used as it stands rather than
 * guessed at, which is the difference between predicting a round and reporting
 * one. Whatever is left is paired the way the tournament would pair it.
 */
function pairFor(live: Standing[], round: number, cfg: SimConfig, rand: () => number): [Standing, Standing][] {
  const out: [Standing, Standing][] = [];
  if (!live.length) return out;
  const used = new Set<string>();

  if (cfg.known) {
    const byCode = new Map(live.map((s) => [s.team.code, s]));
    for (const s of live) {
      if (used.has(s.team.code)) continue;
      const k = knownFor(cfg.known, s.team.code, round);
      const other = k?.opp ? byCode.get(k.opp) : undefined;
      if (!other || used.has(other.team.code)) continue;
      used.add(s.team.code);
      used.add(other.team.code);
      out.push([s, other]);
    }
  }

  const rest = used.size ? live.filter((s) => !used.has(s.team.code)) : live;
  if (!rest.length) return out;
  return out.concat(round <= cfg.randomRounds ? pairRandom(rest, rand) : pairPower(rest, rand, cfg.seedJitter ?? SEED_JITTER));
}

function pairRandom(pool: Standing[], rand: () => number): [Standing, Standing][] {
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const out: [Standing, Standing][] = [];
  for (let i = 0; i + 1 < shuffled.length; i += 2) out.push([shuffled[i], shuffled[i + 1]]);
  keepSchoolsApart(out);
  return out;
}

/**
 * How much a real pairing wanders from the seed order, in speaker points.
 *
 * A tabroom seeds the bracket and pairs high against low, but it also has to
 * honour sides, keep schools apart and avoid rematches, so the result is never
 * exactly the seed order. Measured against the Season Opener and Grapevine, the
 * rank sum of a real pairing averages almost exactly one bracket-width, so the
 * rule is high-low; the jitter is what stops it being rigid.
 *
 * The value is measured, not guessed. Sweeping it against the rounds those two
 * tournaments actually paired, the probability the model puts on the opponent a
 * team really drew peaks between 0.25 and 0.5 and falls away either side. Larger
 * values keep raising the chance the true opponent appears somewhere in the top
 * few, which looks like an improvement and is not: it is the same confidence
 * spread over more teams.
 */
const SEED_JITTER = 0.4;

/** Two entries a tabroom will not put in the same room. */
function sameSchool(a: Standing, b: Standing): boolean {
  return !!a.team.school && a.team.school === b.team.school;
}

/**
 * Take two teams from one school out of the same room.
 *
 * Pairing a bracket greedily cannot avoid this on its own: by the time the last
 * two teams are left there is no choice to make, so whoever remains is paired
 * whatever their school. The fix is to swap partners with another pair, which
 * every tabroom does and which is why not one of the 1,238 real pairings across
 * Grapevine and the Season Opener put two entries from the same school together.
 */
function keepSchoolsApart(pairs: [Standing, Standing][]): void {
  for (let x = 0; x < pairs.length; x++) {
    if (!sameSchool(pairs[x][0], pairs[x][1])) continue;
    for (let y = 0; y < pairs.length; y++) {
      if (x === y) continue;
      const [a1, b1] = pairs[x];
      const [a2, b2] = pairs[y];
      if (!sameSchool(a1, b2) && !sameSchool(a2, b1)) {
        pairs[x] = [a1, b2];
        pairs[y] = [a2, b1];
        break;
      }
    }
  }
}

/**
 * Power pairing, the way a tabroom actually does it.
 *
 * Inside each win bracket, teams are seeded on speaker points and then paired
 * high against low: the top of the bracket draws the bottom, the second draws
 * the second from bottom, and so on. That is not a detail. Pairing at random
 * inside the bracket spreads the guess over everyone on the same record, which
 * is worse than useless for predicting an opponent; high-low concentrates it on
 * the handful of teams a person could actually draw.
 *
 * A bracket with an odd number of teams pulls one UP from the bracket below,
 * rather than pushing its own odd team down. Tabroom chooses the team with the
 * worst average opponent seed: the one that has faced the weakest schedule, and
 * so has the least claim on the record it is sitting on. That team joins at the
 * bottom of the higher bracket, so high-low sets it against the top seed there.
 *
 * Grapevine's round six is exactly this. Three teams sat at 5-0, so the top seed
 * drew a pull-up and the other two met each other. Checked against every real
 * pull-up at Grapevine and the Season Opener, the team chosen was the worst in
 * its bracket by that measure every time.
 */
function pairPower(pool: Standing[], rand: () => number, jitter = SEED_JITTER): [Standing, Standing][] {
  // Bracket on losses, not wins. A team that has had a bye carries one round
  // fewer, so a 4-0 belongs with the undefeated 5-0s rather than with the 4-1s.
  // Grouping on wins files it in the wrong bracket and pairs it against the
  // wrong half of the field.
  const brackets = new Map<number, Standing[]>();
  for (const s of pool) {
    const b = brackets.get(s.losses) || [];
    b.push(s);
    brackets.set(s.losses, b);
  }

  // Seed on speaker points per round rather than the running total, for the same
  // reason: a team with a bye should not sink for having debated once less.
  const rounds = (s: Standing) => Math.max(1, s.wins + s.losses);
  const rate = (s: Standing) => s.speaks / rounds(s);

  // The standings as they stand, best first, which is what an opponent's seed
  // means; and from that, how weak a schedule each team has faced.
  const rankOf = new Map<string, number>();
  pool.slice()
    .sort((a, b) => a.losses - b.losses || rate(b) - rate(a) || a.team.seed - b.team.seed)
    .forEach((st, i) => rankOf.set(st.team.code, i + 1));
  const weakness = new Map<Standing, number>();
  for (const st of pool) {
    let sum = 0, n = 0;
    for (const code of st.met) {
      const r = rankOf.get(code);
      if (r !== undefined) { sum += r; n++; }
    }
    weakness.set(st, n ? sum / n : 0);
  }

  const order = Array.from(brackets.keys()).sort((a, b) => a - b);
  const seeded = new Map<number, Standing[]>();
  for (const losses of order) {
    const group = brackets.get(losses)!.slice();
    const key = new Map<Standing, number>();
    for (const s of group) key.set(s, rate(s) + (rand() + rand() - 1) * jitter / rounds(s));
    group.sort((a, b) => key.get(b)! - key.get(a)! || a.team.seed - b.team.seed);
    seeded.set(losses, group);
  }

  const out: [Standing, Standing][] = [];
  for (let i = 0; i < order.length; i++) {
    const group = seeded.get(order[i])!;

    // An odd bracket pulls one up from the bracket below, taken from its lower
    // third, and that team joins at the bottom — so high-low sets it against the
    // top seed. Pulling cascades: the bracket below is now one lighter, which can
    // make it odd in turn, exactly as a real pairing cascades down the standings.
    if (group.length % 2 === 1 && i + 1 < order.length) {
      const below = seeded.get(order[i + 1])!;
      if (below.length) {
        let pick = 0;
        for (let k = 1; k < below.length; k++) {
          if ((weakness.get(below[k]) ?? 0) > (weakness.get(below[pick]) ?? 0)) pick = k;
        }
        group.push(below.splice(pick, 1)[0]);
      }
    }

    // High against low, stepping up from the bottom to dodge a rematch or a
    // school clash. The walk cannot help the last pair in a bracket, which has no
    // choice left, so the bracket is repaired once it is laid out.
    const made: [Standing, Standing][] = [];
    while (group.length > 1) {
      const a = group.shift()!;
      let j = group.length - 1;
      while (j > 0 && (a.met.has(group[j].team.code) || sameSchool(a, group[j]))) j--;
      made.push([a, group.splice(j, 1)[0]]);
    }
    keepSchoolsApart(made);
    for (const pair of made) out.push(pair);
    // a lone team in the lowest bracket has nobody to draw: that is a bye
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

  // The first round still to be debated. This follows how far the tournament has
  // actually got, not the first gap in the data: a couple of teams always have a
  // round missing because they dropped, and letting them define "next" would aim
  // the whole prediction at a round the field finished hours ago.
  const openFrom = cfg.known ? cfg.known.prelimsDone + 1 : 1;
  let firstOpen = -1;
  const nextPairing = new Map<string, string>();
  const openStandings = new Map<string, { wins: number; losses: number }>();

  for (let round = 1; round <= cfg.prelims; round++) {
    const paired = new Set<string>();

    // A round that has been debated is a fact, so it is applied rather than
    // re-run. Each team carries its own posted result, so the two sides need no
    // matching up, and every later round pairs off the standings that really exist.
    const live: Standing[] = [];
    for (const s of standings) {
      const k = knownFor(cfg.known, s.team.code, round);
      if (!k || k.won === null) { live.push(s); continue; }
      const before = `${s.wins}-${s.losses}`;
      if (k.won) s.wins++; else s.losses++;
      s.speaks += k.points !== null ? k.points : roundSpeaks(s.team, k.won, rand);
      if (k.opp) s.met.add(k.opp);
      paired.add(s.team.code);
      if (keepSample) s.rounds.push({
        round, code: s.team.code, opp: k.bye ? "bye" : (k.opp || "unknown"), won: k.won, recordBefore: before,
        chance: 1, base: 1, form: 0, h2h: 0, h2hW: 0, h2hL: 0,
        rating: Math.round(s.team.rating.rating), oppRating: 0, actual: true,
      });
    }

    if (firstOpen < 0 && live.length && round >= openFrom) firstOpen = round;
    // The standings teams carry into that round, which is what the next-round
    // view has to label them with. By the end of the run they read 4-2 instead.
    if (round === firstOpen && !openStandings.size) {
      for (const s of standings) openStandings.set(s.team.code, { wins: s.wins, losses: s.losses });
    }
    const pairs = pairFor(live, round, cfg, rand);
    for (const [x, y] of pairs) {
      if (round === firstOpen) {
        nextPairing.set(x.team.code, y.team.code);
        nextPairing.set(y.team.code, x.team.code);
      }
      paired.add(x.team.code); paired.add(y.team.code);
      const bd = breakdown(x.team, y.team, cfg.headToHead);
      const p = bd.p;
      const xWins = rand() < p;
      const before = `${x.wins}-${x.losses}`, beforeY = `${y.wins}-${y.losses}`;
      if (xWins) { x.wins++; y.losses++; } else { y.wins++; x.losses++; }
      x.speaks += roundSpeaks(x.team, xWins, rand);
      y.speaks += roundSpeaks(y.team, !xWins, rand);
      x.met.add(y.team.code); y.met.add(x.team.code);
      if (keepSample) {
        x.rounds.push({ round, code: x.team.code, opp: y.team.code, won: xWins, recordBefore: before, ...sideOf(bd, x.team, y.team, false) });
        y.rounds.push({ round, code: y.team.code, opp: x.team.code, won: !xWins, recordBefore: beforeY, ...sideOf(bd, y.team, x.team, true) });
      }
    }
    // an odd field leaves one team unpaired: that is a bye, and a bye is a win
    for (const s of standings) {
      if (!paired.has(s.team.code)) {
        if (round === firstOpen) nextPairing.set(s.team.code, "bye");
        s.wins++;
        s.speaks += roundSpeaks(s.team, true, rand);   // a bye is scored as an average round
        if (keepSample) s.rounds.push({
          round, code: s.team.code, opp: "bye", won: true, recordBefore: `${s.wins - 1}-${s.losses}`,
          chance: 1, base: 1, form: 0, h2h: 0, h2hW: 0, h2hL: 0,
          rating: Math.round(s.team.rating.rating), oppRating: 0,
        });
      }
    }
  }

  // seeding: wins first, then speaker form, then entry order
  // wins first, then speaker points inside each win bracket, exactly as a real
  // tournament seeds: two 6-0 teams are separated by the speaks they earned
  const seeded = standings.slice().sort((a, b) =>
    b.wins - a.wins || b.speaks - a.speaks || a.team.seed - b.team.seed);
  // Who breaks. Once elims have started the real field is known and is used as
  // it stands. Otherwise everyone on the break record advances, capped when the
  // tournament breaks a fixed number — and because `seeded` is already ordered by
  // wins and then speaker points, cutting at the cap splits the last record
  // bracket on speaks, which is how a real break line falls.
  let broke: Standing[];
  if (cfg.known?.brokeCodes && cfg.known.brokeCodes.length) {
    const real = new Set(cfg.known.brokeCodes);
    broke = seeded.filter((s) => real.has(s.team.code));
  } else {
    broke = seeded.filter((s) => s.wins >= cfg.breakWins);
    if (cfg.breakCap && cfg.breakCap > 0 && broke.length > cfg.breakCap) broke = broke.slice(0, cfg.breakCap);
  }

  // Byes to the top seeds until the field is a power of two, laid out in the
  // standard rainbow order so the bracket behaves like a real one: the top seed
  // meets the bottom, and the top two seeds can only meet in the final.
  let size = 1;
  while (size < broke.length) size *= 2;
  const field: (Standing | null)[] = seedOrder(size).map((seed) => broke[seed - 1] ?? null);

  const elims: SimElimMatch[][] = [];

  // A bracket the tournament actually drew is replayed, not redrawn. Decided
  // matches stand; undecided ones are simulated where they sit; teams that enter
  // later had a bye and join when the real bracket says they did.
  const knownStages = cfg.known?.elimStages ?? [];
  let survivors: (Standing | null)[] | null = null;
  for (const stage of knownStages) {
    const matches: SimElimMatch[] = [];
    const advancing: (Standing | null)[] = [];
    for (const m of stage.matches) {
      const A = m.a ? byCode.get(m.a) ?? null : null;
      const B = m.b ? byCode.get(m.b) ?? null : null;
      if (A && B) {
        const bd = breakdown(A.team, B.team, cfg.headToHead);
        const aWon = m.winner ? m.winner === A.team.code : rand() < bd.p;
        const w = aWon ? A : B;
        advancing.push(w);
        matches.push({
          round: stage.label, a: A.team.code, b: B.team.code, winner: w.team.code, bye: false,
          chance: m.winner ? null : r3(bd.p), form: r3(bd.form), h2hW: bd.w, h2hL: bd.l,
          aRating: Math.round(A.team.rating.rating), bRating: Math.round(B.team.rating.rating),
        });
      } else {
        const w = A || B;
        advancing.push(w);
        matches.push({
          round: stage.label, a: A?.team.code ?? null, b: B?.team.code ?? null, winner: w?.team.code ?? null, bye: true,
          chance: null, form: 0, h2hW: 0, h2hL: 0,
          aRating: Math.round(A?.team.rating.rating ?? 0), bRating: Math.round(B?.team.rating.rating ?? 0),
        });
      }
    }
    elims.push(matches);
    survivors = advancing;
  }

  // Teams the bracket has not reached yet are still in it. A break that is not a
  // power of two sends its top seeds straight to the second stage, so rewinding to
  // the end of the first one leaves them waiting rather than out: dropping them
  // would erase the very teams most likely to win.
  let alive: (Standing | null)[];
  if (survivors) {
    const entered = new Set<string>();
    for (const stage of knownStages) {
      for (const m of stage.matches) { if (m.a) entered.add(m.a); if (m.b) entered.add(m.b); }
    }
    const waiting = broke.filter((s) => !entered.has(s.team.code));
    const pool = [...survivors.filter((x): x is Standing => !!x), ...waiting];
    const rank = new Map(broke.map((s, i) => [s.team.code, i]));
    pool.sort((a, b) => (rank.get(a.team.code) ?? 1e9) - (rank.get(b.team.code) ?? 1e9));
    let width = 1;
    while (width < pool.length) width *= 2;
    alive = seedOrder(width).map((seed) => pool[seed - 1] ?? null);
  } else {
    alive = field;
  }
  while (alive.length > 1) {
    const next: (Standing | null)[] = [];
    const matches: SimElimMatch[] = [];
    const name = elimRoundName(alive.length / 2);
    for (let i = 0; i < alive.length / 2; i++) {
      const a = alive[2 * i];                               // adjacent slots meet, as the order intends
      const b = alive[2 * i + 1];
      if (a && b) {
        const bd = breakdown(a.team, b.team, cfg.headToHead);
        const p = bd.p;
        const aWins = rand() < p;
        const w = aWins ? a : b;
        next.push(w);
        matches.push({
          round: name, a: a.team.code, b: b.team.code, winner: w.team.code, bye: false,
          chance: r3(bd.p), form: r3(bd.form), h2hW: bd.w, h2hL: bd.l,
          aRating: Math.round(a.team.rating.rating), bRating: Math.round(b.team.rating.rating),
        });
      } else {
        const w = a || b;
        next.push(w);
        matches.push({
          round: name, a: a?.team.code ?? null, b: b?.team.code ?? null, winner: w?.team.code ?? null, bye: true,
          chance: null, form: 0, h2hW: 0, h2hL: 0,
          aRating: Math.round(a?.team.rating.rating ?? 0), bRating: Math.round(b?.team.rating.rating ?? 0),
        });
      }
    }
    elims.push(matches);
    alive = next;
  }

  const champion = alive[0]?.team.code ?? null;
  return { standings, seeded, broke, elims, champion, byCode, firstOpen, nextPairing, openStandings };
}

// ---------------------------------------------------------------------------
// many tournaments
// ---------------------------------------------------------------------------

export function simulate(teams: SimTeam[], cfg: SimConfig): SimResult {
  const rand = rng(cfg.seed ?? Math.floor(Math.random() * 2 ** 31));
  const tally = new Map<string, { breaks: number; champ: number; final: number; semi: number; wins: number; records: Record<string, number> }>();
  for (const t of teams) tally.set(t.code, { breaks: 0, champ: 0, final: 0, semi: 0, wins: 0, records: {} });

  let breakSizeTotal = 0;
  let openRound = -1;
  const nextTally = new Map<string, Map<string, number>>();
  const atOpen = new Map<string, { wins: number; losses: number }>();
  for (let run = 0; run < cfg.runs; run++) {
    const { standings, broke, elims, champion, firstOpen, nextPairing, openStandings } = runOnce(teams, cfg, rand, false);
    openRound = firstOpen;
    if (openStandings.size) for (const [code, st] of openStandings) atOpen.set(code, st);
    for (const [code, opp] of nextPairing) {
      const m = nextTally.get(code) || new Map<string, number>();
      m.set(opp, (m.get(opp) || 0) + 1);
      nextTally.set(code, m);
    }
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

  const nextRound: NextRound | null = openRound > 0 ? {
    round: openRound,
    published: cfg.known?.pendingRound === openRound,
    matchups: [...nextTally.entries()].map(([code, m]) => {
      const st = atOpen.get(code);
      return {
        code,
        wins: st?.wins ?? 0,
        losses: st?.losses ?? 0,
        opponents: [...m.entries()]
          .map(([opp, n]) => ({ opp, pct: (n / cfg.runs) * 100 }))
          .sort((a, b) => b.pct - a.pct)
          .slice(0, 8),
      };
    }).sort((a, b) => b.wins - a.wins || a.code.localeCompare(b.code)),
  } : null;

  const known = cfg.known ? {
    prelimsDone: cfg.known.prelimsDone,
    entriesWithResults: Object.keys(cfg.known.prelims).length,
  } : null;

  return {
    odds, sample, runs: cfg.runs, breakSizeAvg: breakSizeTotal / cfg.runs,
    config: { prelims: cfg.prelims, breakWins: cfg.breakWins, randomRounds: cfg.randomRounds },
    nextRound, known,
  };
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
