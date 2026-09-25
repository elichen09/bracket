import { isPublicForum, isLincolnDouglas, isPolicy, isVarsity } from "./ratings";

/**
 * Four circuits, kept apart.
 *
 * High school Public Forum, Lincoln-Douglas, high school policy and college policy
 * are different events debated by different people, and a rating means nothing
 * across them: a 1900 college team has never met a Public Forum entry and never
 * will. So each keeps its own leaderboard, its own priors and its own head-to-head
 * record. They share the rounds table and the prediction, which reads the same way
 * for all of them — Tabroom pairs a Lincoln-Douglas prelim with the code that
 * pairs a Public Forum one.
 *
 * A round's circuit is read from the event it was debated in, with the tournament
 * as the tiebreaker. Public Forum and Lincoln-Douglas name themselves. Policy is
 * split by where it was debated: college policy divisions are called "Open",
 * "Shirley" or "Round Robin", which a high school division could be called too, so
 * a round counts as college only at one of the college tournaments named below.
 * Anything else — speech, congress, world schools — belongs to none of them and is
 * not rated.
 */

export type Circuit = "pf" | "ld" | "policy" | "cx";

export interface CircuitMeta {
  id: Circuit;
  label: string;          // for headings
  short: string;          // for a toggle
  teamKind: string;       // `ratings.kind` for partnerships, or for the entry in a one-person event
  debaterKind: string;    // `ratings.kind` for individuals
  entrant: string;        // what one competitor is called
  /** A team's points for a round when none are posted: two speakers, or one. */
  pointsMean: number;
  /**
   * How a weekend on this circuit is usually shaped, which is what a prediction
   * assumes until it is told otherwise. Public Forum runs six prelims and breaks
   * everyone on four wins. College policy runs eight and breaks a fixed thirty-two
   * to doubles however the records fall — so the break is a cut at that many, not
   * a record. Every circuit but Public Forum assigns sides rather than flipping
   * for them, which side-locks the even rounds; measured on the rounds themselves,
   * a Lincoln-Douglas or policy team met a team due the other side in 100% of
   * round twos, fours and sixes.
   */
  defaults: { prelims: number; breakWins: number; randomRounds: number; breakCap?: number; sideConstraints: boolean; firstPowerMixture: boolean; repeatPullUps: boolean; sopSigma: number };
  /**
   * How sharply a rating gap decides a round, fitted to the circuit's own rounds.
   *
   * Glicko's own curve is not the same everywhere. Replaying every archived round
   * from the ratings held before that weekend, and counting only rounds between
   * two teams with at least eight rounds behind them, college policy favourites
   * win more often than the curve says at every gap: 82% where it says 77%, 95%
   * where it says 91%. Sharpening the log-odds by a quarter matches what the
   * rounds did, band for band, and is the best fit by likelihood over 6,463
   * rounds. Public Forum runs the other way — its favourites win less often than
   * the curve says — so it is left alone. The two newer circuits have no archive
   * to fit yet and start level, which is the honest place to start.
   *
   * `cap` is the most the model will ever give anyone. Big gaps do not become
   * certainties: at 300 points and up the college favourite still lost 86 of 894
   * prelims, about one in ten.
   */
  winCurve: { sharpen: number; cap: number };
  /**
   * What a point of judge-adjusted speaker form this weekend is worth, in
   * log-odds, fitted on archived rounds the fit never saw. College policy weighs
   * it heavier because its points are bunched more tightly, so a point of
   * difference says more. Lincoln-Douglas scores one speaker rather than two, so
   * its points move on half the scale and a point there is worth about twice one
   * of Public Forum's — that much is arithmetic, and it is fitted properly once
   * the circuit has an archive behind it.
   */
  speaksFormWeight: number;
}

export const CIRCUITS: Record<Circuit, CircuitMeta> = {
  pf: {
    id: "pf", label: "Public Forum", short: "PF", teamKind: "team", debaterKind: "debater", entrant: "team",
    pointsMean: 57.5,
    defaults: { prelims: 6, breakWins: 4, randomRounds: 2, sideConstraints: false, firstPowerMixture: true, repeatPullUps: false, sopSigma: 1 },
    winCurve: { sharpen: 1, cap: 0.97 },
    speaksFormWeight: 0.5,
  },
  ld: {
    id: "ld", label: "Lincoln-Douglas", short: "LD", teamKind: "ld-team", debaterKind: "ld-debater", entrant: "debater",
    pointsMean: 28.5,
    defaults: { prelims: 6, breakWins: 4, randomRounds: 2, sideConstraints: true, firstPowerMixture: true, repeatPullUps: false, sopSigma: 1 },
    winCurve: { sharpen: 1, cap: 0.97 },
    speaksFormWeight: 1,
  },
  policy: {
    id: "policy", label: "Policy", short: "Policy", teamKind: "policy-team", debaterKind: "policy-debater", entrant: "team",
    pointsMean: 57.5,
    defaults: { prelims: 6, breakWins: 4, randomRounds: 2, sideConstraints: true, firstPowerMixture: true, repeatPullUps: false, sopSigma: 2 },
    winCurve: { sharpen: 1, cap: 0.97 },
    speaksFormWeight: 0.5,
  },
  cx: {
    id: "cx", label: "College policy", short: "College", teamKind: "cx-team", debaterKind: "cx-debater", entrant: "team",
    pointsMean: 57.5,
    defaults: { prelims: 8, breakWins: 4, randomRounds: 1, breakCap: 32, sideConstraints: true, firstPowerMixture: true, repeatPullUps: true, sopSigma: 2 },
    winCurve: { sharpen: 1.25, cap: 0.97 },
    speaksFormWeight: 1.2,
  },
};

export const CIRCUIT_IDS: Circuit[] = ["pf", "ld", "policy", "cx"];

/**
 * The college policy tournaments the archive holds, by name so the list survives
 * a tournament's yearly change of id. This is also what tells college policy from
 * high school policy, so a tournament missing from here is read as high school.
 */
export const COLLEGE_TOURNAMENTS: { name: string; re: RegExp; not?: RegExp }[] = [
  { name: "Owen L Coon Memorial (Northwestern)", re: /owen l\.? coon/i },
  { name: "National Debate Tournament", re: /national debate tournament/i, not: /new horizons|world schools/i },
  { name: "ADA Nationals", re: /ada nationals/i },
  { name: "Texas Open", re: /texas open/i, not: /coolidge/i },
  { name: "Herbert L James Debates (Dartmouth)", re: /herbert l\.? james/i },
  { name: "Georgetown College Tournament", re: /georgetown college tournament/i },
  { name: "FR Shirley (Wake Forest)", re: /shirley/i, not: /chisholm/i },
  { name: "Gonzaga Jesuit Debates", re: /jesuit debates/i },
  { name: "JW Patterson Debates (Kentucky)", re: /patterson debates/i },
  { name: "Run for the Roses (Kentucky)", re: /run for the roses/i },
];

/**
 * Tournaments someone has said are college (or are not), by name, from the
 * ranking-update page: a college tournament missing from the list above is
 * counted as one without a code change. Loaded from storage by the server
 * (lib/circuitStore.ts) before rounds are read or ratings are rebuilt.
 */
const SAID_COLLEGE = new Map<string, boolean>();
const key = (name: string) => (name || "").replace(/\s+/g, " ").trim().toLowerCase();
export function setCollegeOverrides(list: Record<string, boolean>) {
  SAID_COLLEGE.clear();
  for (const [name, college] of Object.entries(list || {})) SAID_COLLEGE.set(key(name), !!college);
}
export function withCollegeOverride<T>(name: string, college: boolean, run: () => T): T {
  const k = key(name), had = SAID_COLLEGE.has(k), was = SAID_COLLEGE.get(k);
  SAID_COLLEGE.set(k, college);
  const done = () => { if (had) SAID_COLLEGE.set(k, was!); else SAID_COLLEGE.delete(k); };
  try {
    const out = run();
    if (out instanceof Promise) return out.finally(done) as T;
    done();
    return out;
  } catch (e) { done(); throw e; }
}

export function isCollegeTournament(tournName: string): boolean {
  const said = SAID_COLLEGE.get(key(tournName));
  if (said !== undefined) return said;
  return COLLEGE_TOURNAMENTS.some((t) => t.re.test(tournName || "") && !(t.not && t.not.test(tournName || "")));
}

/**
 * Divisions that are not the top field, beyond the ones `isVarsity` already
 * knows. Kentucky calls its junior varsity "Wildcat" and Gonzaga calls one
 * "Junior"; observer and scout divisions are not debating at all; and CARD is a
 * separate format debated alongside policy at Gonzaga, not a policy division.
 */
const NOT_TOP_DIVISION = /wildcat|observ|scout|^x-|\bx-|pnw|\bjunior\b|\bcard\b/i;

/** A round robin is a sixteen-entry invitational, not the tournament's own field. */
const ROUND_ROBIN = /round robin|\brr\b/i;

/** Which circuit a stored round belongs to, or null when it is neither. */
export function circuitOf(tournName: string, eventName: string): Circuit | null {
  // College divisions are called "Open" or "Shirley", so where a round was debated
  // decides before what it was called does.
  if (isCollegeTournament(tournName)) return "cx";
  if (isPublicForum(eventName)) return "pf";
  if (isLincolnDouglas(eventName)) return "ld";
  if (isPolicy(eventName)) return "policy";
  return null;
}

/** Does this round count towards its circuit's standing? Top division only. */
export function counts(circuit: Circuit, eventName: string): boolean {
  if (!isVarsity(eventName)) return false;
  if (circuit === "pf") return isPublicForum(eventName);
  if (circuit === "cx") return !NOT_TOP_DIVISION.test(eventName || "");
  // The high school circuits keep to the tournament's own open field: a round
  // robin is a separate sixteen-entry invitational and is left out.
  return !NOT_TOP_DIVISION.test(eventName || "") && !ROUND_ROBIN.test(eventName || "");
}

/** Which circuit a tracked tournament is, for the prediction and its ratings. */
export function circuitOfTournament(tournName: string, eventLabel = ""): Circuit {
  return circuitOf(tournName, eventLabel) ?? "pf";
}

/**
 * Is this a division worth archiving, from what the results index says about it?
 * Tabroom gives each event a level and a type, which is firmer than its name.
 */
export function archivable(circuit: Circuit, event: { name?: string; abbr?: string; level?: string; type?: string }): boolean {
  const name = event.name || event.abbr || "";
  if (event.type && event.type !== "debate") return false;
  if (circuit === "pf") return isPublicForum(name) && isVarsity(name);
  if (circuit === "cx") return (event.level ?? "open") === "open" && counts("cx", name);
  return ["open", "varsity", "championship"].includes(event.level ?? "open") && counts(circuit, name);
}
