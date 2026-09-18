import { isPublicForum, isVarsity } from "./ratings";

/**
 * Two circuits, kept apart.
 *
 * High school Public Forum and college policy are different events debated by
 * different people, and a rating means nothing across them: a 1900 college team
 * has never met a Public Forum entry and never will. So each keeps its own
 * leaderboard, its own priors and its own head-to-head record. They share the
 * rounds table and the prediction, which reads the same way for both — Tabroom
 * pairs a college policy prelim with the code that pairs a Public Forum one.
 *
 * A round's circuit is read from the event it was debated in, with the tournament
 * as the tiebreaker. Public Forum names itself. College policy divisions are
 * called "Open", "Shirley" or "Round Robin", which a high school policy division
 * could be called too, so a round only counts as college when its tournament is
 * one of the college tournaments named below. Anything else — high school policy,
 * Lincoln-Douglas, speech — belongs to neither and is not rated.
 */

export type Circuit = "pf" | "cx";

export interface CircuitMeta {
  id: Circuit;
  label: string;          // for headings
  short: string;          // for a toggle
  teamKind: string;       // `ratings.kind` for partnerships
  debaterKind: string;    // `ratings.kind` for individuals
  entrant: string;        // what one competitor is called
  /**
   * How a weekend on this circuit is usually shaped, which is what a prediction
   * assumes until it is told otherwise. Public Forum runs six prelims and breaks
   * everyone on four wins. College policy runs eight, assigns sides rather than
   * flipping for them, and breaks a fixed thirty-two to doubles however the
   * records fall — so the break is a cut at that many, not a record.
   */
  defaults: { prelims: number; breakWins: number; randomRounds: number; breakCap?: number; sideConstraints: boolean; firstPowerMixture: boolean; repeatPullUps: boolean };
  /**
   * How sharply a rating gap decides a round, fitted to the circuit's own rounds.
   *
   * Glicko's own curve is not the same on both circuits. Replaying every archived
   * round from the ratings held before that weekend, and counting only rounds
   * between two teams with at least eight rounds behind them, college policy
   * favourites win more often than the curve says at every gap: 82% where it says
   * 77%, 95% where it says 91%. Sharpening the log-odds by a quarter matches what
   * the rounds did, band for band, and is the best fit by likelihood over 6,463
   * rounds. Public Forum runs the other way — its favourites win less often than
   * the curve says — so it is left alone here.
   *
   * `cap` is the most the model will ever give anyone. Big gaps do not become
   * certainties: at 300 points and up the college favourite still lost 86 of 894
   * prelims, about one in ten.
   */
  winCurve: { sharpen: number; cap: number };
}

export const CIRCUITS: Record<Circuit, CircuitMeta> = {
  pf: {
    id: "pf", label: "Public Forum", short: "PF", teamKind: "team", debaterKind: "debater", entrant: "team",
    defaults: { prelims: 6, breakWins: 4, randomRounds: 2, sideConstraints: false, firstPowerMixture: true, repeatPullUps: false },
    winCurve: { sharpen: 1, cap: 0.97 },
  },
  cx: {
    id: "cx", label: "College policy", short: "College CX", teamKind: "cx-team", debaterKind: "cx-debater", entrant: "team",
    defaults: { prelims: 8, breakWins: 4, randomRounds: 1, breakCap: 32, sideConstraints: true, firstPowerMixture: true, repeatPullUps: true },
    winCurve: { sharpen: 1.25, cap: 0.97 },
  },
};

/**
 * The college policy tournaments the archive holds, by name so the list survives
 * a tournament's yearly change of id. This is also what marks a round as college
 * rather than high school policy, so a tournament missing from here is not rated.
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

export function isCollegeTournament(tournName: string): boolean {
  return COLLEGE_TOURNAMENTS.some((t) => t.re.test(tournName || "") && !(t.not && t.not.test(tournName || "")));
}

/**
 * Divisions that are not the top policy field, beyond the ones `isVarsity`
 * already knows. Kentucky calls its junior varsity "Wildcat" and Gonzaga calls
 * one "Junior"; observer and scout divisions are not debating at all; and CARD
 * is a separate format debated alongside policy at Gonzaga, not a policy
 * division, so its teams do not belong in a policy standing.
 */
const NOT_TOP_DIVISION = /wildcat|observ|scout|^x-|\bx-|pnw|\bjunior\b|\bcard\b/i;

/** Which circuit a stored round belongs to, or null when it is neither. */
export function circuitOf(tournName: string, eventName: string): Circuit | null {
  if (isPublicForum(eventName)) return "pf";
  if (isCollegeTournament(tournName)) return "cx";
  return null;
}

/** Does this round count towards its circuit's standing? Top division only, both circuits. */
export function counts(circuit: Circuit, eventName: string): boolean {
  if (!isVarsity(eventName)) return false;
  return circuit === "pf" ? isPublicForum(eventName) : !NOT_TOP_DIVISION.test(eventName || "");
}

/** Which circuit a tracked tournament is, for the prediction and its ratings. */
export function circuitOfTournament(tournName: string, eventLabel = ""): Circuit {
  if (isCollegeTournament(tournName)) return "cx";
  return isPublicForum(eventLabel) || isPublicForum(tournName) ? "pf" : "pf";
}

/**
 * Is this a division worth archiving, from what the results index says about it?
 * Tabroom gives each event a level and a type, which is firmer than its name.
 */
export function archivable(circuit: Circuit, event: { name?: string; abbr?: string; level?: string; type?: string }): boolean {
  const name = event.name || event.abbr || "";
  if (event.type && event.type !== "debate") return false;
  if (circuit === "pf") return isPublicForum(name) && isVarsity(name);
  return (event.level ?? "open") === "open" && counts("cx", name);
}
