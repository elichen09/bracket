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
  seedSigma?: number;           // how well the seed order is known, in places; see SEED_SIGMA
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

/** Roughly a standard normal, from three uniforms. */
const gauss = (rand: () => number) => (rand() + rand() + rand() - 1.5) * 2;

/**
 * Read the seeds back out of a bracket that has actually been drawn.
 *
 * Seeding is a prediction until the tournament breaks. After that it is not: the
 * draw itself says what the seeds were, because a bracket is invertible. Byes go
 * to the top seeds, and every pair in the opening round sums to one more than the
 * bracket width, so the real matchups pin almost every seed down.
 *
 * What the draw cannot say is which of two teams in a room was the higher seed,
 * and which of several byes came first. Those are settled by this site's own
 * estimate, which is the only part left guessing. Without this the page labels a
 * real bracket with predicted seeds and the two disagree: at the Season Opener
 * only 2 of 53 opening matches summed to 129, so a correct bracket read as a
 * broken one.
 */
function seedsFromBracket(broke: Standing[], stages: KnownElimStage[]): Map<string, number> | null {
  if (!stages.length || !broke.length) return null;
  const last = stages[stages.length - 1];
  if (!last.matches.length) return null;

  let width = 1;
  while (width < broke.length) width *= 2;
  const order = seedOrder(width);          // order[slot] is the seed sitting there

  // this site's order, best first, used only to break what the draw leaves open
  const guess = new Map<string, number>();
  broke.forEach((st, i) => guess.set(st.team.code, i));
  const rank = (code: string) => guess.get(code) ?? Number.MAX_SAFE_INTEGER;

  // the match each team played in each stage, so the draw can be walked backwards
  const playedIn = stages.map((st) => {
    const m = new Map<string, KnownElimMatch>();
    for (const match of st.matches) {
      if (match.a) m.set(match.a, match);
      if (match.b) m.set(match.b, match);
    }
    return m;
  });

  // Rebuild the draw as a tree. Working back from the final, each team came out
  // of a match in an earlier stage, or entered on a bye and is a leaf.
  interface Node { team?: string; kids?: [Node, Node]; size: number; best: number }
  const build = (team: string, stage: number): Node => {
    if (stage < 0) return { team, size: 1, best: rank(team) };
    const m = playedIn[stage].get(team);
    if (!m || !m.a || !m.b) return build(team, stage - 1);   // sat the stage out
    const kids: [Node, Node] = [build(m.a, stage - 1), build(m.b, stage - 1)];
    return { kids, size: kids[0].size + kids[1].size, best: Math.min(kids[0].best, kids[1].best) };
  };
  // The last stage that is known roots the draw. When that is the final there is
  // one root and the whole tree hangs off it; part way through there are several,
  // one per match still to be decided, plus a root for every team that has broken
  // but not yet entered. Treating the last known stage as the final is what broke
  // this: mid-bracket it built a tree from a single match and left the rest of the
  // field unseeded.
  const top = stages.length - 2;
  const roots: Node[] = [];
  const seen = new Set<string>();
  const keep = (node: Node) => {
    const walk = (x: Node) => { if (x.team !== undefined) seen.add(x.team); else x.kids?.forEach(walk); };
    walk(node);
    roots.push(node);
  };
  for (const m of last.matches) {
    if (m.a && m.b) {
      const kids: [Node, Node] = [build(m.a, top), build(m.b, top)];
      keep({ kids, size: kids[0].size + kids[1].size, best: Math.min(kids[0].best, kids[1].best) });
    } else if (m.a || m.b) {
      keep(build((m.a || m.b)!, top));
    }
  }
  for (const st of broke) {
    if (!seen.has(st.team.code)) keep({ team: st.team.code, size: 1, best: rank(st.team.code) });
  }
  if (!roots.length) return null;

  // Each root owns an equal stretch of the bracket, so the stretches are matched
  // to the roots by strength: the draw that is known keeps its shape, and what is
  // not yet drawn is laid out the way it is projected.
  let span = 1;
  while (span * roots.length < width) span *= 2;
  if (span * roots.length !== width) return null;

  // How many real teams a stretch of the bracket holds: the seeds past the break
  // are the empty slots that byes sit opposite.
  const capacity = (lo: number, hi: number) => {
    let n = 0;
    for (let i = lo; i < hi; i++) if (order[i] <= broke.length) n++;
    return n;
  };

  // Lay the tree over the bracket. Which child takes the upper half is settled by
  // how many teams it holds, since the halves rarely hold the same number once
  // byes are in; where they do, this site's own order breaks the tie.
  const out = new Map<string, number>();
  const place = (node: Node, lo: number, hi: number): void => {
    if (node.team !== undefined) {
      for (let i = lo; i < hi; i++) {
        if (order[i] <= broke.length) { out.set(node.team, order[i]); return; }
      }
      return;
    }
    if (!node.kids) return;
    const mid = (lo + hi) >> 1;
    let [x, y] = node.kids;
    const want = capacity(lo, mid);
    if (x.size !== want && y.size === want) [x, y] = [y, x];
    else if (x.size === y.size && y.best < x.best) [x, y] = [y, x];
    place(x, lo, mid);
    place(y, mid, hi);
  };
  const spots: { lo: number; best: number; holds: number }[] = [];
  for (let lo = 0; lo < width; lo += span) {
    let best = Number.MAX_SAFE_INTEGER;
    for (let i = lo; i < lo + span; i++) if (order[i] < best) best = order[i];
    spots.push({ lo, best, holds: capacity(lo, lo + span) });
  }

  // A root has to go somewhere that fits it. A stretch of the bracket opposite a
  // bye holds one team, not two, so sorting roots by strength alone can drop a
  // whole match into a bye's place and leave one of its teams with nowhere to sit.
  // That team then has no seed, the map is rejected as incomplete, and the page
  // falls back to projected seeds over a real draw: the bracket a person sees as
  // scrambled. Within a size, strength decides which stretch.
  const byHolds = new Map<number, { lo: number; best: number; holds: number }[]>();
  for (const spot of spots) byHolds.set(spot.holds, [...(byHolds.get(spot.holds) || []), spot]);
  const bySize = new Map<number, Node[]>();
  for (const r of roots) bySize.set(r.size, [...(bySize.get(r.size) || []), r]);

  for (const [size, group] of bySize) {
    const open = byHolds.get(size);
    if (!open || open.length !== group.length) return null;
    group.sort((a, b) => a.best - b.best);
    open.sort((a, b) => a.best - b.best);
    group.forEach((r, i) => place(r, open[i].lo, open[i].lo + span));
  }

  // all of the field or none of it, so a caller never mixes drawn seeds with guesses
  return out.size === broke.length ? out : null;
}

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

interface Standing {
  team: SimTeam; wins: number; losses: number; speaks: number;
  scores: number[];            // each round on its own, so the ends can be dropped
  met: Set<string>; rounds: SimRound[];
}

/**
 * The points a tournament seeds on: every round except the team's best and worst.
 *
 * Not the running total. Tabroom drops the high and the low before seeding, and
 * the difference decides real seeds: at Grapevine, Plano Senior SG leads Bellaire
 * AC 356.9 to 355.9 on the raw total and trails 238.2 to 238.4 once the ends come
 * off, and the tournament seeded Bellaire AC above them. Measured against the
 * byes, which by definition go to the very top seeds, the raw total gets 3 of 4
 * right at Grapevine and 10 of 11 at the Season Opener; dropping the ends gets
 * every one.
 */
function adjustedPoints(scores: number[]): number {
  if (scores.length < 3) return scores.reduce((a, b) => a + b, 0);
  const sorted = scores.slice().sort((a, b) => a - b);
  return sorted.slice(1, -1).reduce((a, b) => a + b, 0);
}

/** The same, per round, so a team that has debated fewer is not punished for it. */
function seedRate(s: Standing): number {
  const counted = s.scores.length >= 3 ? s.scores.length - 2 : s.scores.length;
  return adjustedPoints(s.scores) / Math.max(1, counted);
}

/**
 * Speaker points for one round. Centred on what this team usually earns, a little
 * higher for winning, and with enough spread that two teams on the same record do
 * not always seed the same way — which is the point of seeding on speaks at all.
 */
function roundSpeaks(team: SimTeam, won: boolean, rand: () => number): number {
  const noise = (rand() + rand() + rand() - 1.5) * 0.9;   // roughly normal, about ±1
  return expectedSpeaks(team, won) + noise;
}

/**
 * What a team is expected to earn in a round, before any luck.
 *
 * Used for rounds that have been debated but whose speaker points are not
 * published. Most tournaments hold speaks back until they are over, so this is
 * the ordinary case mid-weekend, and it is not the same as a round that has not
 * happened: the result is known, only the points are missing. Drawing a random
 * score for each of those piles invented variance on top of the seed-order
 * uncertainty that is already modelled and measured, and makes the seeding worse
 * than simply using the best estimate.
 */
function expectedSpeaks(team: SimTeam, won: boolean): number {
  return 28.5 + team.pointsZ * 0.6 + (won ? 0.3 : 0);
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
  return out.concat(round <= cfg.randomRounds ? pairRandom(rest, rand) : pairPower(rest, rand, cfg.seedSigma ?? SEED_SIGMA));
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
 * How well the seed order is known, in places.
 *
 * The pairing rule itself is not in doubt: a tabroom seeds each bracket and
 * pairs high against low. What is in doubt is the seed order this works from.
 * Tabroom seeds on adjusted speaker points and tiebreaks this site cannot see,
 * so the order here is an estimate, and in a bracket of twenty-four a couple of
 * places of error changes who meets whom.
 *
 * So the uncertainty is put where it belongs. Each team's position is drawn
 * around its estimated place with this spread, and the bracket is re-sorted
 * before pairing: sigma is literally "the seed order is known to within about
 * this many places". Perturbing the points instead, as this used to, barely
 * reorders a bracket whose points are well separated, which left the model
 * naming two possible opponents out of a bracket of six and giving the real one
 * nothing at all.
 *
 * The value is chosen by calibration rather than by hit rate. Scoring it on how
 * often it is exactly right rewards confident guesses and is indifferent to
 * putting zero on what actually happened, which is the failure worth avoiding.
 *
 * Swept against the rounds Grapevine and the Season Opener actually paired: at
 * three places the model still considers the opponent a team really drew in 56%
 * of cases, against 10% when the order is taken as exact, and the probability it
 * puts on that opponent when it does consider it is at its best. Going wider
 * keeps nudging coverage up but pays for it in sharpness and halves how often
 * the top pick is right, which is spreading confidence rather than earning it.
 */
const SEED_SIGMA = 3;

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
function pairPower(pool: Standing[], rand: () => number, sigma = SEED_SIGMA): [Standing, Standing][] {
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
  const rate = (s: Standing) => seedRate(s);

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
    // the order this site can work out, best first
    group.sort((a, b) => rate(b) - rate(a) || a.team.seed - b.team.seed);
    // then move each team around its place by however well that order is known
    const placed = group.map((st, i) => ({ st, at: i + gauss(rand) * sigma }));
    placed.sort((a, b) => a.at - b.at);
    seeded.set(losses, placed.map((x) => x.st));
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
  const standings: Standing[] = teams.map((team) => ({ team, wins: 0, losses: 0, speaks: 0, scores: [], met: new Set<string>(), rounds: [] }));
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
      const got = k.points !== null ? k.points : expectedSpeaks(s.team, k.won);
      s.speaks += got;
      s.scores.push(got);
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
      const xGot = roundSpeaks(x.team, xWins, rand);
      const yGot = roundSpeaks(y.team, !xWins, rand);
      x.speaks += xGot; x.scores.push(xGot);
      y.speaks += yGot; y.scores.push(yGot);
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
        const byeGot = roundSpeaks(s.team, true, rand);   // a bye is scored as an average round
        s.speaks += byeGot;
        s.scores.push(byeGot);
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
    b.wins - a.wins || adjustedPoints(b.scores) - adjustedPoints(a.scores) || a.team.seed - b.team.seed);
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

  // A replayed bracket has to be put back in the order it was drawn. Results come
  // back in whatever order the entries were read, so without this a round's
  // matches sit in an arbitrary sequence and the tree does not line up: a match
  // appears nowhere near the two it follows from, which is what makes a correct
  // bracket look scrambled. The recovered seeds give each team its slot, and a
  // match belongs where its higher slot puts it.
  const drawnSeeds = seedsFromBracket(broke, knownStages);
  let drawnWidth = 1;
  while (drawnWidth < broke.length) drawnWidth *= 2;
  const slotOfSeed = new Map<number, number>();
  seedOrder(drawnWidth).forEach((seed, slot) => slotOfSeed.set(seed, slot));
  const slotOf = (code: string | null): number => {
    const seed = code ? drawnSeeds?.get(code) : undefined;
    const slot = seed === undefined ? undefined : slotOfSeed.get(seed);
    return slot === undefined ? Number.MAX_SAFE_INTEGER : slot;
  };

  let survivors: (Standing | null)[] | null = null;
  const entered = new Set<string>();
  for (let depth = 0; depth < knownStages.length; depth++) {
    const stage = knownStages[depth];
    const matches: SimElimMatch[] = [];
    const advancing: (Standing | null)[] = [];

    // A break that is not a power of two opens with a partial round, and Tabroom
    // reports only the rooms that actually debated. The teams sitting it out are
    // missing from the results altogether, so the column comes up short: at the
    // Season Opener 53 matches where the bracket needs 64 places. Nothing in the
    // next round can then sit against what feeds it. Put those teams back as the
    // byes they are.
    const drawnList = stage.matches.slice();
    if (depth === 0) {
      const inRound = new Set<string>();
      for (const m of stage.matches) { if (m.a) inRound.add(m.a); if (m.b) inRound.add(m.b); }
      for (const st of broke) {
        if (!inRound.has(st.team.code)) drawnList.push({ a: st.team.code, b: null, winner: st.team.code });
      }
    }

    const drawn = drawnSeeds
      ? drawnList.sort((x, y) => Math.min(slotOf(x.a), slotOf(x.b)) - Math.min(slotOf(y.a), slotOf(y.b)))
      : drawnList;
    for (const m of drawn) {
      if (m.a) entered.add(m.a);
      if (m.b) entered.add(m.b);
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
    // Who is still to enter. This once rebuilt its own list from the raw stage
    // data, which has no byes in it, so a team given a bye counted twice: once
    // among the survivors and again as still waiting. The pool then overflowed
    // the bracket and the page grew a phantom round that was the opening one
    // inverted, 53 byes against 11 debated.
    const waiting = broke.filter((s) => !entered.has(s.team.code));
    const pool = [...survivors.filter((x): x is Standing => !!x), ...waiting];
    if (drawnSeeds && knownStages.length) {
      // Carry the draw forward. These teams already hold places in the bracket
      // they came out of, and a place halves each round: slot s becomes s >> k
      // after k rounds. Re-laying them in a fresh bracket by rating instead threw
      // that away, which is why every round after the replayed ones came out
      // unordered and sitting against the wrong matches.
      const done = knownStages.length;
      const span = Math.max(1, drawnWidth >> done);
      const carried: (Standing | null)[] = new Array(span).fill(null);
      for (const st of pool) {
        const slot = slotOf(st.team.code);
        if (slot === Number.MAX_SAFE_INTEGER) continue;
        const at = slot >> done;
        if (at < span && !carried[at]) carried[at] = st;
      }
      alive = carried;
    } else {
      // No recovered draw to follow, so seed what is left on the standings.
      const rank = new Map(broke.map((s, i) => [s.team.code, i]));
      pool.sort((a, b) => (rank.get(a.team.code) ?? 1e9) - (rank.get(b.team.code) ?? 1e9));
      let left = 1;
      while (left < pool.length) left *= 2;
      alive = seedOrder(left).map((seed) => pool[seed - 1] ?? null);
    }
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
    breakField: (() => {
      // Once a bracket exists the seeds come from it, not from the projection.
      const real = seedsFromBracket(one.broke, cfg.known?.elimStages ?? []);
      // Falling back per team is what produces duplicates: a team the draw did not
      // place would take an index already given to somebody else, so two teams end
      // up seeded 1 and the bracket reads as nonsense. Either the draw seeds the
      // whole field or none of it.
      const complete = real && one.broke.every((s) => real.has(s.team.code));
      return one.broke
        .map((s, i) => ({
          code: s.team.code, wins: s.wins, losses: s.losses,
          seed: complete ? real!.get(s.team.code)! : i + 1,
        }))
        .sort((a, b) => a.seed - b.seed);
    })(),
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
