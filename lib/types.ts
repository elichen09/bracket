export type Result = [seed: number, ballots: string, side: "AFF" | "NEG" | "ADV"];
export type Results = Record<string, Record<string, Result>>; // round -> match -> result
export type Picks = Record<string, number>;                   // "round:match" -> winning seed

export type TournamentStatus = "pending" | "open" | "live" | "complete";

export interface Tournament {
  id: string;
  name: string;
  event: string;
  host: string;
  year: string;
  tabroom_tourn_id: number | null;
  tabroom_result_id: number | null;
  round_ids: Record<string, number>;
  slots: string[];
  results: Results;
  notes: Record<string, string>;
  locked_rounds: number;
  status: TournamentStatus;
  sort_order: number;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Entry {
  id: string;
  tournament_id: string;
  user_id: string | null;   // null on brackets made before accounts existed
  name: string;
  picks: Picks;
  locked: boolean;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The signed-in person's own bracket in a tournament. */
export interface MyEntry {
  id: string;
}
