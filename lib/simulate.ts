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
  judges?: number[];            // paradigm ids of whoever judged it
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
  withdrawn?: Record<string, number>;          // entries no longer in the field -> last prelim they debated
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
  judgeHabits?: Record<string, number>;   // paradigm id -> points that judge gives above or below the norm
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

  /** The best seed a stretch of the bracket holds. */
  const bestSeed = (lo: number, hi: number): number => {
    let best = Number.MAX_SAFE_INTEGER;
    for (let i = lo; i < hi; i++) if (order[i] <= broke.length && order[i] < best) best = order[i];
    return best;
  };

  const place = (node: Node, lo: number, hi: number): void => {
    if (node.team !== undefined) {
      let at = -1;
      for (let i = lo; i < hi; i++) {
        if (order[i] <= broke.length && (at < 0 || order[i] < order[at])) at = i;
      }
      if (at >= 0) out.set(node.team, order[at]);
      return;
    }
    if (!node.kids) return;
    const mid = (lo + hi) >> 1;
    let [x, y] = node.kids;
    const want = capacity(lo, mid);
    if (x.size !== want && y.size === want) {
      [x, y] = [y, x];
    } else if (x.size === y.size) {
      // Rows alternate which side is drawn on top, so the earlier half of a
      // stretch is not always the stronger one: in the second row the top slot
      // holds seed 65 and the one under it holds 64. A side has to be placed by
      // the seed it would take, not by where it sits, or the better team is
      // handed the worse seed and the two swap against the real bracket.
      const strongerFirst = bestSeed(lo, mid) < bestSeed(mid, hi);
      if (strongerFirst !== (x.best <= y.best)) [x, y] = [y, x];
    }
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
  guessed: number;             // debated rounds whose points were not published, so were estimated
  pulled: number;              // times pulled up into a higher bracket, less times pulled down
  byes: number;
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
 * The spread is a single round's: two judges' points for the same team differ by
 * about a point and a half.
 */
function roundSpeaks(team: SimTeam, won: boolean, scale: PointsScale, rand: () => number): number {
  return expectedSpeaks(team, won, scale) + gauss(rand) * ROUND_POINTS_SD;
}

/** A team's points for a round, on the tournament's own scale. */
interface PointsScale { mean: number }

/**
 * What a team is expected to earn in a round, before any luck.
 *
 * Used for rounds that have been debated but whose speaker points are not
 * published. Most tournaments hold speaks back until they are over, so this is
 * the ordinary case mid-weekend: the result is known, only the points are
 * missing, and the seeds that decide the next pairing are built from them.
 *
 * Measured on five tournaments with every point known, a single round's team
 * points are mostly the judge: the team's level and the result explain about a
 * fifth of the variation. Of what can be seen before points are posted, the
 * result is the largest part, a win being worth about a point. The team's rating
 * and its points history add a little. The judge's habit, read from how they
 * scored at other tournaments (lib/judges.ts), adds more than both. Everything is
 * on the scale Tabroom
 * publishes, the two speakers together, and centred on this tournament's own
 * average when any of its rounds have posted points; mixing a one-speaker
 * estimate with posted team totals would scramble the seeds outright.
 */
function expectedSpeaks(team: SimTeam, won: boolean, scale: PointsScale, judgeLean = 0): number {
  return scale.mean + judgeLean
    + (won ? WIN_POINTS / 2 : -WIN_POINTS / 2)
    + team.pointsZ * POINTS_Z_WEIGHT
    + ((team.rating.rating - 1500) / 100) * RATING_POINTS;
}

const WIN_POINTS = 1.0;
const POINTS_Z_WEIGHT = 0.3;
const RATING_POINTS = 0.2;
const ROUND_POINTS_SD = 1.5;
const TEAM_POINTS_MEAN = 57.5;
const JUDGE_WEIGHT = 1.0;

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
function pairFor(live: Standing[], field: Standing[], round: number, cfg: SimConfig, rand: () => number): PairedRound {
  const out: [Standing, Standing][] = [];
  if (!live.length) return { pairs: out, order: [] };
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
  if (!rest.length) return { pairs: out, order: [] };
  if (round <= cfg.randomRounds) return { pairs: out.concat(pairRandom(rest, rand)), order: [] };
  const powered = pairPower(rest, field, rand, round === cfg.randomRounds + 1);
  return { pairs: out.concat(powered.pairs), order: powered.order };
}

/** A round's pairings, and the order the power-pairing ranked the teams in. */
interface PairedRound { pairs: [Standing, Standing][]; order: string[] }

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
 * How far the seed order is trusted, and in what units.
 *
 * Points are what this site cannot always see. A round with published points
 * seeds almost exactly as Tabroom does, so the average is only nudged; a round
 * whose points are estimated from the team's usual form could be off by most of
 * a point, and the order is loosened to match. SOP_SIGMA is a smaller wobble on
 * the final ordering, in seed places, for the tiebreaks this site does not have.
 *
 * Both were swept against the rounds Glenbrooks, John Edie, the TOC, Grapevine
 * and the Season Opener actually paired. Wider values spread the list over more
 * teams without putting the real opponent in it any more often.
 */
const POINTS_SIGMA = 0.05;
const GUESSED_POINTS_SIGMA = 0.8;
const SOP_SIGMA = 1;

/**
 * Power pairing, as Tabroom's own pairing code does it (pair_debate.mas).
 *
 * Every team in the field is seeded: wins first, then points with the best and
 * worst rounds dropped, averaged over the rounds debated. Each team's SOP is its
 * seed plus the average seed of the opponents it has met, so a team that has had
 * an easy schedule sits lower than its record alone suggests. An opponent who
 * has since dropped out has no seed, and counts as zero.
 *
 * Brackets are filled from the top. A bracket with an odd number of teams pulls
 * one up: the team with the most wins left, and among those the weakest
 * schedule, which is the highest average opponent seed. A team that has already
 * been pulled up on balance is passed over. A bracket is also topped up if one
 * school holds more than half of it, since those teams could not all be paired.
 *
 * Inside the bracket the best SOP takes the worst SOP it is allowed to meet, then
 * the next best takes the worst left, and so on; a rematch or a school-mate is
 * skipped. When that leaves someone stranded, pairings are undone from the
 * bottom until the stranded team fits.
 *
 * The first power-paired round is the exception. With two rounds debated there
 * is nothing left once the high and low are dropped, so tournaments fall through
 * to whatever their next tiebreak is: opponent wins at some, raw points at
 * others. That round is drawn from a mix, because which one a tournament uses is
 * not published.
 *
 * Replaying Glenbrooks, John Edie, the TOC, Grapevine and the Season Opener one
 * round at a time from round three, the opponent a team really drew is among the
 * five the Next round tab lists 70% of the time, and first 28% of the time. The
 * high-low on points this replaced managed 20% and 4%. The first power round is
 * still the weak one, and at a field the size of the Opener's it is little better
 * than a guess.
 */
function pairPower(pool: Standing[], field: Standing[], rand: () => number, firstPowered: boolean): PairedRound {
  const wins = (s: Standing) => s.wins;

  // Opponent wins, for tournaments whose first power round falls through to it.
  const byCode = new Map(field.map((s) => [s.team.code, s]));
  const oppWins = (s: Standing) => {
    let n = 0;
    for (const code of s.met) n += byCode.get(code)?.wins ?? 0;
    return n;
  };
  const total = (s: Standing) => s.scores.reduce((a, b) => a + b, 0);
  const average = (s: Standing) => total(s) / Math.max(1, s.scores.length);

  // one draw of how this tournament breaks ties in the first power round
  const style = firstPowered ? rand() : 1;
  const points = (s: Standing) => {
    const share = s.scores.length ? s.guessed / s.scores.length : 1;
    const noise = gauss(rand) * (POINTS_SIGMA + (GUESSED_POINTS_SIGMA - POINTS_SIGMA) * share);
    if (style < 0.25) return oppWins(s) * 1000 + total(s) / 1000;
    if (style < 0.75) return average(s) + noise;
    if (firstPowered) return rand();
    return seedRate(s) + noise;
  };

  // seeds across the whole field, dense, 1 the best
  const keyed = field.map((s) => ({ s, w: wins(s), p: points(s), t: total(s) }));
  keyed.sort((a, b) => b.w - a.w || b.p - a.p || b.t - a.t);
  const seed = new Map<string, number>();
  let place = 0;
  keyed.forEach((k, i) => {
    const prev = keyed[i - 1];
    if (!prev || prev.w !== k.w || prev.p !== k.p || prev.t !== k.t) place++;
    seed.set(k.s.team.code, place);
  });

  const oppSeed = new Map<Standing, number>();
  const sop = new Map<Standing, number>();
  const tie = new Map<Standing, number>();
  for (const s of pool) {
    let sum = 0, n = 0;
    for (const code of s.met) { sum += seed.get(code) ?? 0; n++; }
    const os = n ? sum / n : 0;
    oppSeed.set(s, os);
    sop.set(s, (seed.get(s.team.code) ?? place) + os + gauss(rand) * SOP_SIGMA);
    tie.set(s, rand());
  }
  const seedOf = (s: Standing) => seed.get(s.team.code) ?? place;
  const clash = (a: Standing, b: Standing) => a === b || a.met.has(b.team.code) || b.met.has(a.team.code) || sameSchool(a, b);
  const bySop = (a: Standing, b: Standing) => sop.get(a)! - sop.get(b)! || seedOf(a) - seedOf(b) || tie.get(a)! - tie.get(b)!;

  const opp = new Map<Standing, Standing>();
  const pairs: [Standing, Standing][] = [];
  const pair = (a: Standing, b: Standing) => { opp.set(a, b); opp.set(b, a); };

  // An odd field leaves one team out: the worst SOP in the lowest bracket that has
  // not had a bye already.
  const rest = pool.slice();
  if (rest.length % 2 === 1) {
    const low = Math.min(...rest.map(wins));
    const eligible = rest.filter((s) => wins(s) === low && s.byes === 0);
    const from = eligible.length ? eligible : rest.filter((s) => wins(s) === low);
    from.sort(bySop);
    const out = from[from.length - 1];
    rest.splice(rest.indexOf(out), 1);
  }

  const top = rest.length ? Math.max(...rest.map(wins)) : -1;
  for (let x = top; x >= 0; x--) {
    const bracket = rest.filter((s) => wins(s) >= x && !opp.has(s));
    const inBracket = new Set(bracket);

    for (let guard = 0; guard < 100; guard++) {
      const schools = new Map<string, number>();
      for (const s of bracket) if (s.team.school) schools.set(s.team.school, (schools.get(s.team.school) || 0) + 1);
      const biggest = Math.max(0, ...schools.values());
      const even = bracket.length % 2 === 0 && bracket.length - biggest >= biggest;
      if (even || opp.size + bracket.length >= rest.length) break;
      const candidates = rest
        .filter((s) => !inBracket.has(s) && !opp.has(s))
        .sort((a, b) => wins(b) - wins(a) || oppSeed.get(b)! - oppSeed.get(a)! || seedOf(b) - seedOf(a) || tie.get(a)! - tie.get(b)!);
      if (!candidates.length) break;
      const pick = candidates.find((s) => s.pulled <= 0) ?? candidates[0];
      bracket.push(pick);
      inBracket.add(pick);
    }

    const order = bracket.slice().sort(bySop);
    const greedy = (taken: Map<Standing, Standing>) => {
      for (const a of order) {
        if (taken.has(a)) continue;
        for (let j = order.length - 1; j >= 0; j--) {
          const b = order[j];
          if (taken.has(b) || clash(a, b)) continue;
          taken.set(a, b); taken.set(b, a);
          break;
        }
      }
    };
    let trial = new Map(opp);
    greedy(trial);
    if (order.some((s) => !trial.has(s))) {
      // Undo pairings from the bottom one at a time. After each, the worst team
      // still stranded is paired first, then the rest of the bracket again.
      const retry = new Map(trial);
      for (let j = order.length - 1; j >= 0; j--) {
        const stranded = order.filter((s) => !retry.has(s));
        const child = stranded[stranded.length - 1];
        if (!child) break;
        const k = order[j];
        if (k === child || !retry.has(k)) continue;
        const was = retry.get(k)!;
        retry.delete(k); retry.delete(was);
        for (let i = order.length - 1; i >= 0; i--) {
          const b = order[i];
          if (!retry.has(b) && !clash(child, b)) { retry.set(child, b); retry.set(b, child); break; }
        }
        greedy(retry);
        if (order.every((s) => retry.has(s))) { trial = retry; break; }
      }
    }
    for (const [a, b] of trial) if (!opp.has(a)) pair(a, b);
    // anyone still unpaired drops into the next bracket down
  }

  // whatever could not be placed at all is paired among itself
  const left = rest.filter((s) => !opp.has(s));
  for (let i = 0; i + 1 < left.length; i += 2) pair(left[i], left[i + 1]);

  const seen = new Set<Standing>();
  for (const [a, b] of opp) {
    if (seen.has(a)) continue;
    seen.add(a); seen.add(b);
    pairs.push([a, b]);
  }
  keepSchoolsApart(pairs);

  const order = pool.slice().sort((a, b) => wins(b) - wins(a) || bySop(a, b)).map((s) => s.team.code);
  return { pairs, order };
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
    arr.forEach((s, i) => {
      const other = n + 1 - s;
      // Alternate which side of the pair is drawn on top. Every other row flips,
      // which is what puts the two best seeds at opposite ends of the column and
      // is how the tournament's own bracket reads. Without the flip the pairs are
      // right but the column is stacked in the wrong order.
      if (i % 2 === 0) next.push(s, other);
      else next.push(other, s);
    });
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
  const fresh = (team: SimTeam): Standing => ({
    team, wins: 0, losses: 0, speaks: 0, scores: [], met: new Set<string>(), rounds: [], guessed: 0, pulled: 0, byes: 0,
  });
  const standings: Standing[] = teams.map(fresh);
  const byCode = new Map(standings.map((s) => [s.team.code, s]));

  // Entries that dropped out are gone from the field, but not from the rounds they
  // debated: their opponents still met them, and Tabroom still seeded them while
  // they were in. Each is rebuilt from its opponents' side of those rounds, so the
  // teams that met them seed as they really did.
  const ghostRows = new Map<string, KnownPrelim[]>();
  if (cfg.known) {
    for (const [code, rows] of Object.entries(cfg.known.prelims)) {
      for (const r of rows) {
        if (!r.opp || r.bye || r.won === null || byCode.has(r.opp)) continue;
        const list = ghostRows.get(r.opp) || [];
        list.push({ round: r.round, opp: code, won: !r.won, points: null, bye: false });
        ghostRows.set(r.opp, list);
      }
    }
  }
  const ghosts: Standing[] = [...ghostRows.keys()].map((code) =>
    fresh({ code, school: null, seed: 1e6, rating: { ...UNRATED }, pointsZ: 0, rated: false, source: "none" }));
  const everyone = new Map(byCode);
  for (const g of ghosts) everyone.set(g.team.code, g);
  // The scale this tournament's points are on, from whatever it has posted.
  const posted: number[] = [];
  if (cfg.known) for (const rows of Object.values(cfg.known.prelims)) for (const r of rows) {
    if (!r.bye && r.points !== null && r.points > 40) posted.push(r.points);
  }
  const scale: PointsScale = { mean: posted.length >= 10 ? posted.reduce((a, b) => a + b, 0) / posted.length : TEAM_POINTS_MEAN };
  // How the judges of a round usually score, which is most of what can be known
  // about points that have not been posted.
  const judgeLean = (judges: number[] | undefined): number => {
    if (!judges?.length || !cfg.judgeHabits) return 0;
    let sum = 0;
    for (const j of judges) sum += cfg.judgeHabits[String(j)] ?? 0;
    return (sum / judges.length) * JUDGE_WEIGHT;
  };
  const rowFor = (s: Standing, round: number) =>
    ghostRows.has(s.team.code) ? ghostRows.get(s.team.code)!.find((r) => r.round === round) ?? null : knownFor(cfg.known, s.team.code, round);

  // The first round still to be debated. This follows how far the tournament has
  // actually got, not the first gap in the data: a couple of teams always have a
  // round missing because they dropped, and letting them define "next" would aim
  // the whole prediction at a round the field finished hours ago.
  const openFrom = cfg.known ? cfg.known.prelimsDone + 1 : 1;
  let firstOpen = -1;
  const nextPairing = new Map<string, string>();
  let nextOrder: string[] = [];
  const openStandings = new Map<string, { wins: number; losses: number }>();

  for (let round = 1; round <= cfg.prelims; round++) {
    const paired = new Set<string>();
    const winsBefore = new Map<Standing, number>();
    for (const s of everyone.values()) winsBefore.set(s, s.wins);
    const met: [Standing, Standing][] = [];

    // A dropped entry is in the rounds it has a result for and no others. Live, an
    // entry missing from the field has already withdrawn, so it is not paired again.
    const inRound = (g: Standing) => !!rowFor(g, round) || (cfg.known?.withdrawn?.[g.team.code] ?? 0) >= round;
    // An entry in the field with no result in the last round debated has stopped
    // turning up, and a tabroom does not pair a team that is not there.
    const showed = (s: Standing) => !cfg.known || cfg.known.prelimsDone < 1 || round <= cfg.known.prelimsDone
      ? true
      : !!knownFor(cfg.known, s.team.code, cfg.known.prelimsDone);
    const present = [...standings.filter(showed), ...ghosts.filter(inRound)];

    // A round that has been debated is a fact, so it is applied rather than
    // re-run. Each team carries its own posted result, so the two sides need no
    // matching up, and every later round pairs off the standings that really exist.
    const live: Standing[] = [];
    for (const s of present) {
      let k = rowFor(s, round);
      // A round the field has finished that this entry has nothing for is one it
      // was not in, typically a late arrival, and Tabroom scores that as a bye.
      // Simulating it instead gives the team a different record in every run and
      // blurs the whole bracket it lands in.
      if (!k && cfg.known && round <= cfg.known.prelimsDone && !ghostRows.has(s.team.code) && cfg.known.prelims[s.team.code]?.length) {
        k = { round, opp: null, won: true, points: null, bye: true };
      }
      if (!k || k.won === null) { live.push(s); continue; }
      const before = `${s.wins}-${s.losses}`;
      if (k.won) s.wins++; else s.losses++;
      // A forfeit is posted as a bye on one side. Tabroom leaves those rounds out of
      // both teams' schedules, so neither counts the other as an opponent.
      const forfeit = k.bye || (!!k.opp && !!rowFor(everyone.get(k.opp) ?? s, round)?.bye);
      // A bye has no points to seed on, so it is left out of the average rather
      // than filled in; Tabroom's seeds read that way.
      if (k.bye) s.byes++;
      else {
        const got = k.points !== null ? k.points : expectedSpeaks(s.team, k.won, scale, judgeLean(k.judges));
        if (k.points === null) s.guessed++;
        s.speaks += got;
        s.scores.push(got);
      }
      if (k.opp && !forfeit) {
        s.met.add(k.opp);
        const o = everyone.get(k.opp);
        if (o && s.team.code < k.opp) met.push([s, o]);
      }
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
    const { pairs, order } = pairFor(live, present, round, cfg, rand);
    if (round === firstOpen) nextOrder = order;
    for (const [x, y] of pairs) {
      met.push([x, y]);
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
      const xGot = roundSpeaks(x.team, xWins, scale, rand);
      const yGot = roundSpeaks(y.team, !xWins, scale, rand);
      x.speaks += xGot; x.scores.push(xGot);
      y.speaks += yGot; y.scores.push(yGot);
      x.met.add(y.team.code); y.met.add(x.team.code);
      if (keepSample) {
        x.rounds.push({ round, code: x.team.code, opp: y.team.code, won: xWins, recordBefore: before, ...sideOf(bd, x.team, y.team, false) });
        y.rounds.push({ round, code: y.team.code, opp: x.team.code, won: !xWins, recordBefore: beforeY, ...sideOf(bd, y.team, x.team, true) });
      }
    }
    // A power-paired round moves teams between brackets, and Tabroom will not pull
    // the same team up twice, so each move is counted against the records the
    // teams carried into it.
    if (round > cfg.randomRounds) {
      for (const [x, y] of met) {
        const wx = winsBefore.get(x) ?? 0, wy = winsBefore.get(y) ?? 0;
        if (wx < wy) { x.pulled++; y.pulled--; } else if (wx > wy) { x.pulled--; y.pulled++; }
      }
    }
    // an odd field leaves one team unpaired: that is a bye, and a bye is a win
    for (const s of present) {
      if (!paired.has(s.team.code)) {
        if (ghostRows.has(s.team.code)) continue;
        if (round === firstOpen) nextPairing.set(s.team.code, "bye");
        s.wins++;
        s.byes++;   // a win with no points, like a posted bye
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
  // Adjusted points PER ROUND, not accumulated. A team that has had a bye debates
  // one round fewer, so any total quietly pushes it down the board however well it
  // has spoken. Bergen RZ finished 4-1 over five rounds at the Season Opener and
  // VDA-Vancouver 5-1 over six; VDA leads on wins and on total points by a wide
  // margin, yet the tournament seeded Bergen RZ 16 and VDA 17, because Bergen RZ
  // averaged 58.60 a round against 58.35. Measured across the four pairs this got
  // wrong, the per-round figure orders every one of them the way the tournament
  // did, where the total manages two and win percentage none.
  const seeded = standings.slice().sort((a, b) =>
    b.wins - a.wins || seedRate(b) - seedRate(a) || a.team.seed - b.team.seed);
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

    // Sort by the first slot a room occupies. This has to read the same slots the
    // rooms are printed in, so the sides are put in slot order first and the rows
    // sorted after: swapping the sides afterwards left every row correct inside
    // and the column stacked wrong.
    if (drawnSeeds) {
      for (const m of drawnList) {
        if (m.a && m.b && slotOf(m.a) > slotOf(m.b)) { const sw = m.a; m.a = m.b; m.b = sw; }
      }
    }
    const drawn = drawnSeeds
      ? drawnList.sort((x, y) => Math.min(slotOf(x.a), slotOf(x.b)) - Math.min(slotOf(y.a), slotOf(y.b)))
      : drawnList;
    for (const m of drawn) {
      if (m.a) entered.add(m.a);
      if (m.b) entered.add(m.b);
      let A = m.a ? byCode.get(m.a) ?? null : null;
      let B = m.b ? byCode.get(m.b) ?? null : null;
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
  return { standings, seeded, broke, elims, champion, byCode, firstOpen, nextPairing, nextOrder, openStandings };
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
  const placeTally = new Map<string, { sum: number; n: number }>();
  const atOpen = new Map<string, { wins: number; losses: number }>();
  for (let run = 0; run < cfg.runs; run++) {
    const { standings, broke, elims, champion, firstOpen, nextPairing, nextOrder, openStandings } = runOnce(teams, cfg, rand, false);
    openRound = firstOpen;
    nextOrder.forEach((code, i) => {
      const p = placeTally.get(code) || { sum: 0, n: 0 };
      p.sum += i; p.n++;
      placeTally.set(code, p);
    });
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

  // Where each team sat in the power-paired order, on average, for filling out a
  // short list of opponents.
  const ladder = [...placeTally.entries()]
    .sort((a, b) => a[1].sum / a[1].n - b[1].sum / b[1].n)
    .map(([code]) => code);
  const rung = new Map(ladder.map((code, i) => [code, i]));
  const schoolOf = new Map(teams.map((t) => [t.code, t.school]));
  const metBefore = (code: string) => new Set((cfg.known?.prelims[code] ?? []).filter((r) => r.round < openRound && r.opp).map((r) => r.opp!));

  const nextRound: NextRound | null = openRound > 0 ? {
    round: openRound,
    published: cfg.known?.pendingRound === openRound,
    matchups: [...nextTally.entries()].filter(([code]) => schoolOf.has(code)).map(([code, m]) => {
      const st = atOpen.get(code);
      const opponents = [...m.entries()]
        .map(([opp, n]) => ({ opp, pct: (n / cfg.runs) * 100 }))
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 8);
      // A pairing is sensitive to small differences in seeding, so when the runs
      // agree on only a few opponents, the teams either side of the likeliest one
      // are the next most likely. Those are listed after, as long shots.
      const anchor = opponents.length ? rung.get(opponents[0].opp) : undefined;
      if (anchor !== undefined && opponents.length < 5) {
        const met = metBefore(code);
        const listed = new Set(opponents.map((o) => o.opp));
        for (let step = 1; opponents.length < 5 && step < ladder.length; step++) {
          for (const at of [anchor + step, anchor - step]) {
            const other = ladder[at];
            if (!other || other === code || listed.has(other) || met.has(other)) continue;
            if (schoolOf.get(other) && schoolOf.get(other) === schoolOf.get(code)) continue;
            opponents.push({ opp: other, pct: 0 });
            listed.add(other);
            if (opponents.length >= 5) break;
          }
        }
      }
      return { code, wins: st?.wins ?? 0, losses: st?.losses ?? 0, opponents };
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
