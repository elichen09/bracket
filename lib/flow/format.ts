/**
 * Public Forum, as it is actually run.
 *
 * Eleven speeches, four of them crossfire, and the flip decides who goes
 * first — so the order here is built from that choice rather than hard-coded
 * to Pro. Eight of the eleven are written down, which is why the flow has
 * eight columns; crossfire is timed and answered but never flowed, so those
 * three carry no column.
 *
 * NSDA times: constructives 4:00, rebuttals 4:00, summaries 3:00, final
 * focus 2:00, every crossfire 3:00, and 3:00 of prep per team. Some circuits
 * run 4:00 of prep, so prep is a number the tool can be told rather than a
 * constant.
 */

export type Side = "pro" | "con";

export interface Column {
  /** Short label in the flow's header. */
  key: string;
  /** What it is called when there is room to say it. */
  long: string;
  side: Side;
}

export interface Speech {
  name: string;
  long: string;
  secs: number;
  /** Which column it is written in, or -1 for crossfire. */
  col: number;
  side: Side | null;
}

export const PREP_DEFAULT = 180;
export const PREP_CHOICES = [120, 180, 240, 300];

const SHORT = (side: Side) => (side === "pro" ? "PRO" : "CON");
const OTHER = (side: Side): Side => (side === "pro" ? "con" : "pro");

/** The four rounds of speeches, each spoken by both teams in turn. */
const LEGS = [
  { key: "CASE", long: "Constructive", secs: 240 },
  { key: "REB", long: "Rebuttal", secs: 240 },
  { key: "SUM", long: "Summary", secs: 180 },
  { key: "FF", long: "Final Focus", secs: 120 },
] as const;

/** The eight columns a flow is written in, in the order they are spoken. */
export function columns(first: Side): Column[] {
  const out: Column[] = [];
  for (const leg of LEGS) {
    for (const side of [first, OTHER(first)] as Side[]) {
      out.push({ key: `${SHORT(side)} ${leg.key}`, long: `${side === "pro" ? "Pro" : "Con"} ${leg.long}`, side });
    }
  }
  return out;
}

/**
 * The seven columns of one sheet, in the order the argument is answered.
 *
 * A sheet is one side's case, so the other side's constructive never belongs
 * on it — that is the other sheet. What does is the chain of answers: their
 * rebuttal to this case, this side's rebuttal back, and so on down to the
 * final focuses. The chain runs the same way whichever team speaks first, so
 * flipping the speaking order moves nothing on the flow.
 */
export function sheetColumns(side: Side): Column[] {
  const other = OTHER(side);
  const col = (s: Side, leg: (typeof LEGS)[number]): Column => ({ key: `${SHORT(s)} ${leg.key}`, long: `${s === "pro" ? "Pro" : "Con"} ${leg.long}`, side: s });
  return [col(side, LEGS[0]), ...LEGS.slice(1).flatMap((leg) => [col(other, leg), col(side, leg)])];
}

/** Where a speech is written on a sheet: its column there, or -1 if it has none. */
export function columnOn(side: Side, first: Side, speechCol: number): number {
  if (speechCol < 0) return -1;
  const key = columns(first)[speechCol]?.key;
  return sheetColumns(side).findIndex((c) => c.key === key);
}

/**
 * Every speech in order, crossfire included.
 *
 * Crossfire follows the two constructives and the two rebuttals; grand
 * crossfire follows the two summaries. Nothing follows the final focus.
 */
export function speeches(first: Side): Speech[] {
  const cols = columns(first);
  const out: Speech[] = [];
  LEGS.forEach((leg, legIndex) => {
    [first, OTHER(first)].forEach((side, i) => {
      const col = legIndex * 2 + i;
      out.push({
        name: `${SHORT(side as Side)} ${leg.key}`,
        long: cols[col].long,
        secs: leg.secs,
        col,
        side: side as Side,
      });
    });
    if (leg.key === "CASE" || leg.key === "REB") {
      out.push({ name: "CROSSFIRE", long: "Crossfire", secs: 180, col: -1, side: null });
    }
    if (leg.key === "SUM") {
      out.push({ name: "GRAND CX", long: "Grand Crossfire", secs: 180, col: -1, side: null });
    }
  });
  return out;
}

/** mm:ss, the only way a debate clock is ever written. */
export const clock = (s: number) =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
