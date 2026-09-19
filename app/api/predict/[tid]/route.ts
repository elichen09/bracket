import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { currentUser } from "@/lib/auth";
import { fieldWithRatings } from "@/lib/field";
import { simulate } from "@/lib/simulate";
import { loadProgress, knownStateFrom, rewindPoints } from "@/lib/progress";
import { loadJudgeHabits } from "@/lib/judges";
import { circuitOfTournament, CIRCUITS } from "@/lib/circuit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The predicted tournament, private to the account that runs it.
 *
 * Prelims are paired the way they really are: the first rounds at random, the
 * rest power-paired inside win brackets. Everyone at or above the break record
 * debates elims, with byes to the top seeds when that is not a power of two.
 *
 * GET  /api/predict/:tid   -> the prediction this account last ran, or null
 * POST /api/predict/:tid   { prelims?, randomRounds?, breakWins?, runs?, seed? }
 */

const DEFAULTS = { prelims: 6, randomRounds: 2, breakWins: 4, runs: 600 };

export async function GET(_req: Request, { params }: { params: { tid: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const db = supabaseAdmin();
  const { data, error } = await db.from("predictions")
    .select("payload,runs,created_at").eq("user_id", user.id).eq("tournament_id", params.tid).maybeSingle();
  if (error) {
    const hint = /predictions/.test(error.message) ? " — run supabase/migrations/004_ratings.sql" : "";
    return NextResponse.json({ error: error.message + hint }, { status: 500 });
  }
  return NextResponse.json({ prediction: data?.payload ?? null, runs: data?.runs ?? 0, createdAt: data?.created_at ?? null });
}

export async function POST(req: Request, { params }: { params: { tid: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "sign in required" }, { status: 401 });

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults are fine */ }

  const db = supabaseAdmin();
  const { data: t } = await db.from("tournaments")
    .select("id,name,event,tabroom_tourn_id,tabroom_event_abbr").eq("id", params.tid).maybeSingle();
  if (!t) return NextResponse.json({ error: "no such tournament" }, { status: 404 });
  if (!t.tabroom_tourn_id || !t.tabroom_event_abbr) {
    return NextResponse.json({ error: "this tournament has no Tabroom event on file, so it cannot be simulated" }, { status: 404 });
  }

  const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
  };
  // Which circuit this tournament is decides how a weekend is shaped and which
  // ratings it is predicted from: a college policy field has never met a Public
  // Forum one, and it debates eight rounds with sides assigned rather than flipped.
  const circuit = circuitOfTournament(t.name, t.event);
  const shape = CIRCUITS[circuit].defaults;
  const cfg = {
    prelims: clamp(body.prelims, 2, 12, shape.prelims),
    randomRounds: clamp(body.randomRounds, 0, 6, shape.randomRounds),
    breakWins: clamp(body.breakWins, 1, 10, shape.breakWins),
    runs: clamp(body.runs, 100, 4000, DEFAULTS.runs),
    seed: body.seed === undefined ? undefined : clamp(body.seed, 1, 2 ** 31 - 1, 1),
    breakCap: shape.breakCap,
    sideConstraints: shape.sideConstraints,
    winCurve: CIRCUITS[circuit].winCurve,
    speaksFormWeight: CIRCUITS[circuit].speaksFormWeight,
    firstPowerMixture: shape.firstPowerMixture,
    repeatPullUps: shape.repeatPullUps,
    sopSigma: shape.sopSigma,
  };

  try {
    const { teams, h2h, entries } = await fieldWithRatings(db, t.tabroom_tourn_id, t.tabroom_event_abbr, circuit);
    if (teams.length < 4) return NextResponse.json({ error: "too few entries published to simulate" }, { status: 400 });

    // Whatever has already been debated. Rounds that have happened are applied
    // rather than guessed, so the prediction sharpens as the weekend goes on
    // instead of repeating what it thought on Friday morning. If Tabroom will not
    // answer, the prediction still runs; it just knows nothing yet.
    //
    // `asOfRound` and `asOfElim` rewind it. A finished tournament can be re-run
    // from any point it passed through — before it started, after round three,
    // after octas — by hiding everything later and predicting forward from there.
    let known;
    let judgeHabits: Record<string, number> | undefined;
    let progressNote: string | null = null;
    let rewind: { label: string; round?: number; elim?: number }[] = [];
    let asOf: string | null = null;
    try {
      const progress = await loadProgress(t.tabroom_tourn_id, t.tabroom_event_abbr);
      rewind = rewindPoints(progress);
      const asOfRound = body.asOfRound === undefined || body.asOfRound === null
        ? undefined : clamp(body.asOfRound, 0, 20, 0);
      const asOfElim = body.asOfElim === undefined || body.asOfElim === null
        ? undefined : clamp(body.asOfElim, 0, 12, 0);
      known = knownStateFrom(progress, asOfRound, asOfElim);
      // How this tournament's judges score elsewhere, for points not yet posted.
      // Its own ballots are left out, so a finished tournament replayed from the
      // archive is not estimated from the points it is standing in for.
      try {
        const paradigms = progress.entries.flatMap((e) => e.rounds.flatMap((r) => r.judges ?? []));
        judgeHabits = await loadJudgeHabits(db, paradigms, t.tabroom_tourn_id);
      } catch { /* points are estimated without them */ }
      asOf = rewind.find((r) => r.round === asOfRound && asOfRound !== undefined)?.label
        ?? rewind.find((r) => r.elim === asOfElim && asOfElim !== undefined)?.label
        ?? null;
      progressNote = asOf
        ? `rewound to ${asOf.toLowerCase()}`
        : progress.prelimsDone > 0
          ? `through round ${progress.prelimsDone}${progress.elimsStarted ? ", elims under way" : ""}`
          : "nothing debated yet";
    } catch {
      progressNote = "could not read results, so this is a cold prediction";
    }

    const result = simulate(teams, {
      ...cfg,
      randomRounds: Math.min(cfg.randomRounds, cfg.prelims),
      headToHead: h2h,
      known,
      judgeHabits,
    });
    const byCode = new Map(entries.map((e) => [e.code, e]));
    const payload = {
      ...result,
      tournament: { id: t.id, name: t.name, event: t.event, circuit, circuitLabel: CIRCUITS[circuit].label },
      field: teams.length,
      ratedField: teams.filter((x) => x.rated).length,
      ranAt: new Date().toISOString(),
      progressNote,
      rewind,
      asOf,
      // schools and names so the page can label rows without another request
      labels: Object.fromEntries(entries.map((e) => [e.code, { name: e.name, school: e.school, source: e.source }])),
      odds: result.odds.map((o) => ({ ...o, name: byCode.get(o.code)?.name ?? "", source: byCode.get(o.code)?.source ?? "none" })),
    };

    const { error } = await db.from("predictions").upsert({
      user_id: user.id, tournament_id: t.id, payload, runs: cfg.runs, created_at: new Date().toISOString(),
    }, { onConflict: "user_id,tournament_id" });
    if (error) {
      const hint = /predictions/.test(error.message) ? " — run supabase/migrations/004_ratings.sql" : "";
      return NextResponse.json({ error: error.message + hint }, { status: 500 });
    }
    return NextResponse.json({ prediction: payload, runs: cfg.runs });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "could not run the prediction" }, { status: 502 });
  }
}
