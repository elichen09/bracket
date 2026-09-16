/**
 * Glicko-2, per Mark Glickman's paper (glicko.net/glicko/glicko2.pdf).
 *
 * A rating carries three numbers: the rating itself, a deviation (how unsure we
 * are of it) and a volatility (how erratic the competitor is). Ratings move in
 * "rating periods"; here one tournament is one period, so a team that debates
 * six prelims and three elims at Yale is updated once, from all nine results,
 * which is what the algorithm expects. Deviation grows between tournaments, so a
 * team that has not competed since last season is rated less confidently.
 *
 * Pure functions: no database, no network.
 */

export interface Rating {
  rating: number;   // Glicko-2 rating on the familiar 1500 scale
  rd: number;       // rating deviation on the same scale
  vol: number;      // volatility
}

export interface Game {
  opponent: Rating;
  score: number;    // 1 win, 0 loss, 0.5 for an undecided round
  /**
   * How much this round counts, 1 by default. Older seasons are worth less than
   * the current one, so they are fed in at a reduced weight rather than being
   * dropped: a weight of 0.4 makes a round count as four tenths of a result,
   * moving the rating less and leaving more uncertainty behind.
   */
  weight?: number;
}

/** A competitor nobody has seen yet. */
export const UNRATED: Rating = { rating: 1500, rd: 350, vol: 0.06 };

const SCALE = 173.7178;
/** System constant: how much volatility may move per period. Smaller is steadier. */
const TAU = 0.5;
const EPSILON = 0.000001;

const toGlicko2 = (r: Rating) => ({ mu: (r.rating - 1500) / SCALE, phi: r.rd / SCALE, vol: r.vol });
const fromGlicko2 = (mu: number, phi: number, vol: number): Rating => ({
  rating: mu * SCALE + 1500,
  rd: phi * SCALE,
  vol,
});

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const e = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * The chance `a` beats `b`, as the rating system sees it. Both deviations widen
 * the result toward a coin flip, which is the point: an unproven team is not
 * confidently anything.
 */
export function expectedScore(a: Rating, b: Rating): number {
  const A = toGlicko2(a), B = toGlicko2(b);
  const phi = Math.sqrt(A.phi * A.phi + B.phi * B.phi);
  return 1 / (1 + Math.exp(-g(phi) * (A.mu - B.mu)));
}

/** Deviation growth for a competitor who sat out a period. */
export function decay(r: Rating, periods = 1): Rating {
  const { mu, phi, vol } = toGlicko2(r);
  let p = phi;
  for (let i = 0; i < periods; i++) p = Math.min(Math.sqrt(p * p + vol * vol), 350 / SCALE);
  return fromGlicko2(mu, p, vol);
}

/** One rating period: every game the competitor played at that tournament. */
export function update(r: Rating, games: Game[]): Rating {
  const { mu, phi, vol } = toGlicko2(r);
  if (!games.length) return decay(r, 1);

  let vInv = 0;
  let delta = 0;
  let totalWeight = 0;
  for (const game of games) {
    const o = toGlicko2(game.opponent);
    const gp = g(o.phi);
    const ex = e(mu, o.mu, o.phi);
    const w = game.weight === undefined ? 1 : Math.max(0, game.weight);
    if (w === 0) continue;
    totalWeight += w;
    // weighting a result scales its contribution to both the information it
    // carries (the variance term) and the direction it pulls (the delta term)
    vInv += w * gp * gp * ex * (1 - ex);
    delta += w * gp * (game.score - ex);
  }
  if (totalWeight === 0) return decay(r, 1);
  const v = 1 / vInv;
  const dev = v * delta;

  // Illinois algorithm for the new volatility
  const a = Math.log(vol * vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    const num = ex * (dev * dev - phi * phi - v - ex);
    const den = 2 * Math.pow(phi * phi + v + ex, 2);
    return num / den - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B: number;
  if (dev * dev > phi * phi + v) {
    B = Math.log(dev * dev - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0 && k < 100) k++;
    B = a - k * TAU;
  }
  let fA = f(A), fB = f(B);
  let guard = 0;
  while (Math.abs(B - A) > EPSILON && guard++ < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA = fA / 2; }
    B = C; fB = fC;
  }
  const newVol = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + newVol * newVol);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + vInv);
  const newMu = mu + newPhi * newPhi * delta;

  return fromGlicko2(newMu, Math.min(newPhi, 350 / SCALE), newVol);
}

/**
 * A single number for ranking tables: the rating a competitor can defend, being
 * the conservative end of its interval. An unproven 1700 ranks below a proven
 * 1600, which is what people expect from a leaderboard.
 */
export function conservative(r: Rating): number {
  return r.rating - 2 * r.rd;
}
