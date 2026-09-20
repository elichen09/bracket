import { PRELIM_TYPES, ELIM_TYPES, getJson, pool } from "./ratings";
import type { KnownState, KnownPrelim, KnownElimStage } from "./simulate";

/**
 * A tournament as it stands right now.
 *
 * The predictor was built for a tournament that has not started, where every
 * round is guesswork. Once debating begins that is the wrong model: rounds one
 * through three are facts, not estimates, and a prediction that ignores them is
 * worse than useless. This reads what has actually happened so the simulation can
 * start from it.
 *
 * Three states matter, and Tabroom distinguishes them only by what a round is
 * missing:
 *
 *   decided    a win or a loss is posted
 *   paired     an opponent is listed with no result yet, so the matchup is known
 *              but the outcome is not
 *   bye        flagged as a bye, which carries speaker points and no win/loss
 *
 * A bye is a win. Tabroom does not say so, and the rating ingest drops bye rounds
 * because they are not games worth rating, but a team sitting on a bye is a team
 * with another win in the standings, and leaving it out puts them in the wrong
 * bracket for every round after.
 */

const API_PAGE_LIMIT = 6;

export interface KnownRound {
  round: number;            // prelim number; for elims, position in the elim sequence
  label: string;            // "Round 4", "Doubles"
  elim: boolean;
  opp: string | null;       // opponent code, null when nothing is paired yet
  won: boolean | null;      // null when paired but not yet decided
  bye: boolean;
  points: number | null;    // team speaker points for the round
  side: string | null;
  judges?: number[];        // Tabroom paradigm ids of whoever judged it
}

export interface EntryProgress {
  entryId: number;
  code: string;
  school: string | null;
  rounds: KnownRound[];
}

export interface ElimStage {
  label: string;
  order: number;            // 0 is the first elim round debated
  codes: string[];          // everyone who appeared in it
  decided: number;          // matches with a result
  matches: { a: string; b: string | null; winner: string | null }[];
}

export interface TournamentProgress {
  entries: EntryProgress[];
  /** Highest prelim round with results posted for most of the field. */
  prelimsDone: number;
  /** Highest prelim round Tabroom has published anything for, decided or not. */
  prelimsSeen: number;
  /** A round that is paired but not yet decided, when there is one. */
  pendingRound: number | null;
  pendingPairings: { round: number; a: string; b: string }[];
  elimsStarted: boolean;
  elims: ElimStage[];
  /** Everyone who ever debated an elim, which is the real break field. */
  brokeCodes: string[];
  fetchedAt: string;
}

interface RoundDoc {
  id: number; type: string; label?: string; name?: number; sideLabel?: string; bye?: number | boolean;
  Results?: Record<string, { winloss?: string; point?: number }>;
  Judges?: Record<string, { paradigm?: number }>;
  Opponent?: { id: number; code: string };
}
interface RecordsDoc {
  id: number; code: string; name: string;
  Event?: { id: number; name: string; abbr: string };
  Rounds?: Record<string, RoundDoc>;
}
interface FieldEntry { id: number; code: string; name: string; School?: { name: string } }

/**
 * Read every entry's rounds as they stand. One request per entry, same as the
 * rating ingest, so this is a job a page triggers rather than one it waits on
 * for a large field.
 */
export async function loadProgress(tournId: number, eventAbbr: string): Promise<TournamentProgress> {
  const field = await getJson<{ Entries?: FieldEntry[] }>(`/rest/tourns/${tournId}/events/${encodeURIComponent(eventAbbr)}/field`);
  const entries = (field?.Entries || []).filter((e) => e.code && !/^tba\b/i.test(e.code.trim()));
  if (!entries.length) throw new Error(`no entries published for ${eventAbbr} at tournament ${tournId}`);

  const docs = await pool(entries, API_PAGE_LIMIT, (e) => getJson<RecordsDoc>(`/rest/tourns/${tournId}/entries/${e.id}/records`));

  // Elim rounds are named, not numbered, so their order comes from the round ids
  // Tabroom issues in the order rounds are created.
  const elimFirstId = new Map<string, number>();
  for (const doc of docs) {
    for (const r of Object.values(doc?.Rounds || {})) {
      if (!ELIM_TYPES.has(r.type)) continue;
      const label = r.label || String(r.id);
      const prev = elimFirstId.get(label);
      if (prev === undefined || r.id < prev) elimFirstId.set(label, r.id);
    }
  }
  const elimOrder = [...elimFirstId.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label);

  const out: EntryProgress[] = [];
  docs.forEach((doc, i) => {
    const e = entries[i];
    if (!doc) { out.push({ entryId: e.id, code: e.code, school: e.School?.name ?? null, rounds: [] }); return; }
    const rounds: KnownRound[] = [];
    for (const r of Object.values(doc.Rounds || {})) {
      const isPrelim = PRELIM_TYPES.has(r.type);
      const isElim = ELIM_TYPES.has(r.type);
      if (!isPrelim && !isElim) continue;

      const ballots = Object.values(r.Results || {});
      const won = ballots.filter((b) => b.winloss === "W").length;
      const lost = ballots.filter((b) => b.winloss === "L").length;
      const pointBallot = ballots.find((b) => typeof b.point === "number");
      const bye = !!r.bye;

      rounds.push({
        round: isElim ? elimOrder.indexOf(r.label || String(r.id)) : (typeof r.name === "number" ? r.name : 0),
        label: r.label || "",
        elim: isElim,
        opp: r.Opponent?.code ?? null,
        // A bye is a win with nothing posted. Otherwise no ballots means the
        // round is paired but has not happened yet.
        won: bye ? true : won > lost ? true : lost > won ? false : null,
        bye,
        points: typeof pointBallot?.point === "number" ? pointBallot.point : null,
        side: r.sideLabel || null,
        judges: Object.values(r.Judges || {}).map((j) => j.paradigm ?? 0).filter((x) => x > 0),
      });
    }
    rounds.sort((a, b) => Number(a.elim) - Number(b.elim) || a.round - b.round);
    out.push({ entryId: e.id, code: e.code, school: e.School?.name ?? null, rounds });
  });

  // How far the tournament has got. A round counts as done once most of the field
  // has a result for it, which tolerates the handful of rounds that sit undecided
  // for hours while one panel argues.
  const active = out.filter((p) => p.rounds.length).length || 1;
  const decidedBy = new Map<number, number>();
  const seenBy = new Map<number, number>();
  for (const p of out) {
    for (const r of p.rounds) {
      if (r.elim) continue;
      seenBy.set(r.round, (seenBy.get(r.round) || 0) + 1);
      if (r.won !== null) decidedBy.set(r.round, (decidedBy.get(r.round) || 0) + 1);
    }
  }
  let prelimsDone = 0;
  let prelimsSeen = 0;
  for (const [round, seen] of seenBy) {
    if (seen > 0) prelimsSeen = Math.max(prelimsSeen, round);
    if ((decidedBy.get(round) || 0) >= active * 0.5) prelimsDone = Math.max(prelimsDone, round);
  }

  // A round that is paired but not yet debated: both sides listed, no result.
  const pendingRound = prelimsSeen > prelimsDone ? prelimsSeen : null;
  const pendingPairings: { round: number; a: string; b: string }[] = [];
  if (pendingRound !== null) {
    const seenPair = new Set<string>();
    for (const p of out) {
      for (const r of p.rounds) {
        if (r.elim || r.round !== pendingRound || r.won !== null || !r.opp) continue;
        const key = [p.code, r.opp].sort().join("|");
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        pendingPairings.push({ round: r.round, a: p.code, b: r.opp });
      }
    }
  }

  const elims: ElimStage[] = elimOrder.map((label, order) => {
    const codes = out.filter((p) => p.rounds.some((r) => r.elim && r.label === label)).map((p) => p.code);
    const decided = out.reduce((n, p) => n + p.rounds.filter((r) => r.elim && r.label === label && r.won !== null).length, 0) / 2;

    // The matchups as drawn. Each side reports the round from its own view, so a
    // match is seen twice and is kept once; a team with no opponent had a bye.
    const matches: { a: string; b: string | null; winner: string | null }[] = [];
    const taken = new Set<string>();
    for (const p of out) {
      const r = p.rounds.find((x) => x.elim && x.label === label);
      if (!r) continue;
      const key = r.opp ? [p.code, r.opp].sort().join("|") : p.code;
      if (taken.has(key)) continue;
      taken.add(key);
      const mine = r.won;
      const winner = mine === null ? null : mine ? p.code : (r.opp ?? null);
      // A bye that names an opponent is a walkover, not an empty slot. Nulling the
      // opponent here loses them entirely when this row wins the dedupe race, and a
      // team missing from the bracket is a team the rewind has to invent a round for.
      matches.push({ a: p.code, b: r.opp, winner });
    }
    return { label, order, codes, decided: Math.round(decided), matches };
  });
  // The break field is the main elim chain, not every elim-shaped round. A
  // tournament may run a side bracket after the final — the Season Opener runs an
  // international breakout — and its entries are not teams that broke. The main
  // chain is the run of stages that keeps getting smaller; the first stage that
  // does not shrink is something else, and so is everything after it.
  const mainChain: ElimStage[] = [];
  for (const stage of elims) {
    const prev = mainChain[mainChain.length - 1];
    if (prev && stage.codes.length >= prev.codes.length) break;
    mainChain.push(stage);
  }
  // An elim that is paired but not yet judged is in none of the above: Tabroom's
  // entry records only carry a round once a ballot exists for it. The pairing is
  // posted, though, so it is read and added — which is what lets the bracket be
  // drawn the moment doubles go up rather than after the first result.
  const posted = await postedElims(tournId, eventAbbr, new Set(mainChain.map((s) => s.label)), mainChain.length, out.map((p) => p.code));
  for (const stage of posted) mainChain.push(stage);

  const brokeSet = new Set<string>();
  for (const stage of mainChain) for (const c of stage.codes) brokeSet.add(c);
  const brokeCodes = [...brokeSet];

  return {
    entries: out,
    prelimsDone,
    prelimsSeen,
    pendingRound,
    pendingPairings,
    elimsStarted: mainChain.length > 0,
    elims: mainChain,
    brokeCodes,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Elim rounds that are paired but not yet judged, read off Tabroom's public
 * postings page.
 *
 * An entry's records carry a round only once a ballot exists for it, so a bracket
 * posted an hour ago is invisible there: the field has its doubles pairing on a
 * screen in the hallway while this site still shows the prediction's own guess.
 * The postings page needs no login, and is the same page the room assignments are
 * printed from.
 *
 * What comes back is the pairing, not the draw: the page lists rooms in section
 * order, so the first room is not the top of the bracket. That is enough — in a
 * bracket of thirty-two every pairing is a seed against its mirror, so the pairs
 * plus this site's own standing recover which is which.
 */
async function postedElims(
  tournId: number, eventAbbr: string, have: Set<string>, order: number, fieldCodes: string[],
): Promise<ElimStage[]> {
  // The page prints a code as HTML, which collapses the double spaces Tabroom
  // leaves in some of them: "Strake Jesuit  MZ" comes back "Strake Jesuit MZ", and
  // a code that does not match the field is a team missing from the bracket.
  const flat = (code: string) => code.replace(/\s+/g, " ").trim().toLowerCase();
  const asEntered = new Map(fieldCodes.map((c) => [flat(c), c]));
  const resolve = (code: string) => asEntered.get(flat(code)) ?? code;
  const rounds = await getJson<{ id: number; type: string; label?: string; name?: number; published?: number; Event?: { abbr?: string } }[]>(
    `/rest/tourns/${tournId}/rounds`,
  );
  if (!Array.isArray(rounds)) return [];

  const wanted = rounds
    .filter((r) => r.Event?.abbr === eventAbbr && ELIM_TYPES.has(r.type) && r.published && !have.has(r.label || String(r.id)))
    .sort((a, b) => a.id - b.id);

  const out: ElimStage[] = [];
  for (const round of wanted) {
    const raw = await postedPairing(tournId, round.id);
    if (!raw.length) continue;
    const pairs = raw.map((p) => ({ a: resolve(p.a), b: p.b === null ? null : resolve(p.b) }));
    const codes = pairs.flatMap((p) => (p.b ? [p.a, p.b] : [p.a]));
    out.push({
      label: round.label || `Elim ${round.name ?? round.id}`,
      order: order + out.length,
      codes,
      decided: 0,
      matches: pairs.map((p) => ({ a: p.a, b: p.b, winner: null })),
    });
  }
  return out;
}

/** One posted round's rooms, as pairs of entry codes. */
async function postedPairing(tournId: number, roundId: number): Promise<{ a: string; b: string | null }[]> {
  let html = "";
  try {
    const res = await fetch(
      `https://www.tabroom.com/index/tourn/postings/round.mhtml?tourn_id=${tournId}&round_id=${roundId}`,
      { headers: { "user-agent": "TheBreak bracket-pool (personal, low volume)" }, signal: AbortSignal.timeout(20_000), cache: "no-store" },
    );
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];                                   // the pairing simply is not readable yet
  }

  const table = new RegExp(`<table id="${roundId}">([\\s\\S]*?)</table>`).exec(html);
  const body = table ? table[1] : html;
  const out: { a: string; b: string | null }[] = [];
  for (const row of body.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const codes = [...row.matchAll(/entry_record\.mhtml\?tourn_id=\d+&entry_id=\d+"\s*>([\s\S]*?)<\/a>/g)]
      .map((m) => m[1].replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (!codes.length) continue;
    const bye = /<td[^>]*>\s*bye\s*<\/td>/i.test(row);
    out.push({ a: codes[0], b: bye || codes.length < 2 ? null : codes[1] });
  }
  return out;
}

/** Records and speaker totals as they stand, for seeding and for display. */
export function standingsFrom(progress: TournamentProgress): Map<string, { wins: number; losses: number; speaks: number; rounds: number; met: string[] }> {
  const out = new Map<string, { wins: number; losses: number; speaks: number; rounds: number; met: string[] }>();
  for (const p of progress.entries) {
    let wins = 0, losses = 0, speaks = 0, rounds = 0;
    const met: string[] = [];
    for (const r of p.rounds) {
      if (r.elim || r.won === null) continue;
      if (r.won) wins++; else losses++;
      if (r.points !== null) speaks += r.points;
      rounds++;
      if (r.opp) met.push(r.opp);
    }
    out.set(p.code, { wins, losses, speaks, rounds, met });
  }
  return out;
}

/**
 * The simulator's view of what has happened.
 *
 * `throughRound` truncates to the state after that prelim, which is what a
 * backtest needs: run the tournament forward from round three and see whether it
 * predicts round four. Truncating also hides the break field, since a tournament
 * mid-prelims has not broken yet.
 */
export function knownStateFrom(progress: TournamentProgress, throughRound?: number, throughElim?: number): KnownState {
  const cut = throughRound === undefined ? Number.POSITIVE_INFINITY : throughRound;
  const prelims: Record<string, KnownPrelim[]> = {};
  for (const e of progress.entries) {
    const rs: KnownPrelim[] = e.rounds
      .filter((r) => !r.elim && r.round <= cut)
      .map((r) => ({ round: r.round, opp: r.opp, won: r.won, points: r.points, bye: r.bye, judges: r.judges, side: r.side }));
    if (rs.length) prelims[e.code] = rs;
  }
  // The break field is real only once every prelim is in; rewind to the middle of
  // prelims and nobody has broken yet, so the bracket has to be projected.
  const prelimsAllIn = cut >= progress.prelimsSeen && progress.prelimsSeen > 0;
  const stagesWanted = throughElim === undefined ? progress.elims.length : Math.max(0, throughElim);
  const elimStages: KnownElimStage[] = prelimsAllIn
    ? progress.elims.slice(0, stagesWanted).map((st) => ({ label: st.label, matches: st.matches }))
    : [];

  // Entries that withdrew are missing from the field, so the last round each one
  // debated is read off their opponents. Replaying a finished tournament, that says
  // whether a team that later withdrew was still in the round being predicted;
  // live, the answer is always no.
  const listed = new Set(progress.entries.map((e) => e.code));
  const withdrawn: Record<string, number> = {};
  for (const e of progress.entries) {
    for (const r of e.rounds) {
      if (r.elim || !r.opp || listed.has(r.opp)) continue;
      withdrawn[r.opp] = Math.max(withdrawn[r.opp] ?? 0, r.round);
    }
  }

  return {
    prelims,
    withdrawn,
    prelimsDone: Math.min(progress.prelimsDone, cut),
    pendingRound: progress.pendingRound !== null && progress.pendingRound <= cut ? progress.pendingRound : null,
    brokeCodes: prelimsAllIn && progress.brokeCodes.length ? progress.brokeCodes : null,
    elimStages,
  };
}

/** The points in a finished tournament worth rewinding to, oldest first. */
export function rewindPoints(progress: TournamentProgress): { label: string; round?: number; elim?: number }[] {
  const out: { label: string; round?: number; elim?: number }[] = [{ label: "Before it started", round: 0 }];
  for (let r = 1; r <= progress.prelimsSeen; r++) out.push({ label: `After round ${r}`, round: r });
  progress.elims.forEach((st, i) => out.push({ label: `After ${st.label.toLowerCase()}`, elim: i + 1 }));
  return out;
}
