"use client";

import { useCallback, useEffect, useState } from "react";
import EntryDossier from "./EntryDossier";
import SimRecord from "./SimRecord";

/**
 * What a tournament page shows before there is a bracket: who is entered, what
 * the ratings know about them, and a tournament you can run in your head.
 *
 * The prediction is private to the account that runs it, and it is a prediction,
 * not a result — the page says so, because the rest of the site shows real
 * outcomes and the two must never be mistaken for each other.
 */

interface FieldStudent { id: number; name: string; rating: number | null; rd: number | null }
interface FieldTeam {
  entryId: number; code: string; name: string; school: string | null; seed: number;
  rating: number | null; rd: number | null; source: "team" | "debaters" | "none";
  games: number; wins: number; losses: number; tournaments: number;
  pointsAvg: number | null; lastPlayed: string | null; students: FieldStudent[];
}
interface Odds {
  code: string; name?: string; school: string | null; rating: number; rated: boolean; source?: string;
  breakPct: number; champPct: number; finalPct: number; semiPct: number; meanWins: number;
  recordSpread: Record<string, number>;
}
interface SimMatch { round: string; a: string | null; b: string | null; winner: string | null; bye: boolean; chance?: number | null; form?: number; h2hW?: number; h2hL?: number; aRating?: number; bRating?: number }
interface Prediction {
  odds: Odds[];
  sample: {
    prelims: { code: string; wins: number; losses: number; seed: number; rounds: { round: number; opp: string; won: boolean; recordBefore: string; actual?: boolean; chance?: number; base?: number; form?: number; h2h?: number; h2hW?: number; h2hL?: number; rating?: number; oppRating?: number }[] }[];
    breakField: { code: string; wins: number; losses: number; seed: number }[];
    elims: SimMatch[][];
    champion: string | null;
  };
  runs: number; breakSizeAvg: number;
  config: { prelims: number; breakWins: number; randomRounds: number };
  field: number; ratedField: number; ranAt: string;
  nextRound: {
    round: number;
    published: boolean;
    matchups: { code: string; wins: number; losses: number; opponents: { opp: string; pct: number }[] }[];
  } | null;
  known: { prelimsDone: number; entriesWithResults: number } | null;
  progressNote?: string | null;
  rewind?: { label: string; round?: number; elim?: number }[];
  asOf?: string | null;
}

/** A point in a tournament, encoded for the rewind menu. */
type Point = { round?: number; elim?: number } | null;
const pointKey = (p: Point) => (p == null ? "" : p.round !== undefined ? `r${p.round}` : `e${p.elim}`);
const parsePoint = (v: string): Point =>
  !v ? null : v[0] === "r" ? { round: Number(v.slice(1)) } : { elim: Number(v.slice(1)) };

/** Where a team's run ended: the elim round they lost, or that they won it. */
function exitOf(pred: Prediction, code: string): string {
  if (pred.sample.champion === code) return "won it";
  for (const round of pred.sample.elims) {
    const m = round.find((x) => x.a === code || x.b === code);
    if (m && m.winner !== code) return m.round.toLowerCase();
  }
  return "—";
}

/** One team in the simulated bracket, drawn the same way the live brackets draw one. */
function SimSlot({ code, winner, seeds, onOpen }: { code: string | null; winner: string | null; seeds: Map<string, number>; onOpen: (code: string) => void }) {
  if (!code) {
    return <div className="slot blank"><span className="seed" /><span className="nm">bye</span><span className="mg" /></div>;
  }
  const won = winner === code;
  return (
    <button className={"slot infoable " + (won ? "win" : "out")} title={`${code} — click for their weekend in this run`} onClick={() => onOpen(code)}>
      <span className="seed">{seeds.get(code) ?? ""}</span>
      <span className="nm">{code}</span>
      <span className="mg" />
    </button>
  );
}

export default function PreBracket({ tid, name }: { tid: string; name: string }) {
  const [field, setField] = useState<FieldTeam[] | null>(null);
  const [fieldErr, setFieldErr] = useState("");
  const [pred, setPred] = useState<Prediction | null>(null);
  const [predErr, setPredErr] = useState("");
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<"field" | "odds" | "bracket" | "next">("field");
  const [openCode, setOpenCode] = useState<string | null>(null);
  // a seed in the sample bracket opens that run, not the team's real history
  const [openSim, setOpenSim] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [prelims, setPrelims] = useState(6);
  const [breakWins, setBreakWins] = useState(4);
  const [runs, setRuns] = useState(600);
  const [asOf, setAsOf] = useState<Point>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/field/${encodeURIComponent(tid)}`)
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || "could not load the field"); return j; })
      .then((j) => { if (alive) setField(j.entries as FieldTeam[]); })
      .catch((e) => { if (alive) setFieldErr(e.message); });
    fetch(`/api/predict/${encodeURIComponent(tid)}`)
      .then((r) => r.json())
      .then((j) => { if (alive && j.prediction) { setPred(j.prediction as Prediction); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [tid]);

  const run = useCallback(async (point?: Point) => {
    const at = point === undefined ? asOf : point;
    setRunning(true); setPredErr("");
    try {
      const res = await fetch(`/api/predict/${encodeURIComponent(tid)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prelims, breakWins, runs, randomRounds: 2,
          asOfRound: at?.round, asOfElim: at?.elim,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "could not run the prediction");
      setPred(j.prediction as Prediction);
      setTab("odds");
    } catch (e: any) { setPredErr(e.message); }
    finally { setRunning(false); }
  }, [tid, prelims, breakWins, runs, asOf]);

  const q = query.trim().toLowerCase();
  const shownField = (field || []).filter((e) => !q || e.code.toLowerCase().includes(q) || (e.school || "").toLowerCase().includes(q) || e.name.toLowerCase().includes(q));
  const ratedCount = (field || []).filter((e) => e.rating !== null).length;
  // break seeds, so the simulated bracket is labelled the way a real one is
  const seeds = new Map<string, number>((pred?.sample.breakField || []).map((b) => [b.code, b.seed] as [string, number]));

  return (
    <div className="prebracket">
      <div className="stats reveal">
        <div className="stat">
          <div className="k mono">Entries</div>
          <div className="v num">{field ? field.length : "—"}</div>
          <div className="sub">no bracket yet</div>
        </div>
        <div className="stat">
          <div className="k mono">Rated</div>
          <div className="v num">{field ? ratedCount : "—"}<span style={{ color: "var(--muted)" }}>{field ? `/${field.length}` : ""}</span></div>
          <div className="sub">seen at a tracked tournament</div>
        </div>
        <div className="stat">
          <div className="k mono">Format</div>
          <div className="v small">{prelims} prelims</div>
          <div className="sub">all {breakWins}–{prelims - breakWins}s break</div>
        </div>
        <div className="stat">
          <div className="k mono">Prediction</div>
          <div className="v small">{pred ? `${pred.runs} runs` : "not run yet"}</div>
          <div className="sub">{pred ? `avg break ${pred.breakSizeAvg.toFixed(0)} teams` : "private to you"}</div>
        </div>
      </div>

      <div className="controls">
        <div className="seg" role="group">
          <button aria-pressed={tab === "field"} onClick={() => setTab("field")}>The field</button>
          <button aria-pressed={tab === "odds"} onClick={() => setTab("odds")} disabled={!pred}>Odds</button>
          <button aria-pressed={tab === "next"} onClick={() => setTab("next")} disabled={!pred?.nextRound}>Next round</button>
          <button aria-pressed={tab === "bracket"} onClick={() => setTab("bracket")} disabled={!pred}>Sample tournament</button>
        </div>
        <input type="search" placeholder="Find a team or school…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="spacer" />
        <label className="simfield mono">prelims<input type="number" min={2} max={10} value={prelims} onChange={(e) => setPrelims(Number(e.target.value))} /></label>
        <label className="simfield mono">break at<input type="number" min={1} max={10} value={breakWins} onChange={(e) => setBreakWins(Number(e.target.value))} /></label>
        <label className="simfield mono">runs<input type="number" min={100} max={4000} step={100} value={runs} onChange={(e) => setRuns(Number(e.target.value))} /></label>
        {!!pred?.rewind?.length && (
          <label className="simfield mono">as of
            <select
              className="rewind"
              value={pointKey(asOf)}
              disabled={running}
              onChange={(e) => { const p = parsePoint(e.target.value); setAsOf(p); run(p); }}
            >
              <option value="">everything known</option>
              {pred.rewind.map((r) => <option key={pointKey(r)} value={pointKey(r)}>{r.label}</option>)}
            </select>
          </label>
        )}
        <button className="primary" onClick={() => run()} disabled={running || !field}>{running ? "Simulating…" : pred ? "Run again" : "Run predicted tournament"}</button>
      </div>

      {pred?.asOf && (
        <p className="hint rewound">
          <b>Rewound to {pred.asOf.toLowerCase()}.</b> Everything up to that point is counted as it
          really happened; everything after it is simulated, so this is what the model would have
          expected knowing only what was known then.
        </p>
      )}

      <p className="hint">
        <b>This is a prediction, not a result.</b> Prelims pair at random for two rounds and power-pair after
        that, so {breakWins}–{prelims - breakWins}s meet each other; everyone on {breakWins} wins or better breaks.
        Each round is decided by the two entries&rsquo; Glicko-2 ratings, nudged by speaker-point form and by any
        previous meeting between those two teams. Entries nobody has seen debate as an average team.
      </p>

      {fieldErr && <div className="d-err">{fieldErr}</div>}
      {predErr && <div className="d-err">{predErr}</div>}

      {openCode && <EntryDossier tid={tid} code={openCode} onClose={() => setOpenCode(null)} />}
      {openSim && pred && (
        <SimRecord
          code={openSim}
          prelims={pred.sample.prelims}
          elims={pred.sample.elims}
          champion={pred.sample.champion}
          breakWins={pred.config.breakWins}
          totalPrelims={pred.config.prelims}
          fieldSize={pred.field}
          onClose={() => setOpenSim(null)}
          onCareer={(c) => { setOpenSim(null); setOpenCode(c); }}
        />
      )}

      {tab === "field" && (
        !field ? <div className="lbempty">Loading the entry list…</div> : (
          <div className="tablewrap">
            <table className="lb rank">
              <thead><tr>
                <th className="mono">Entry</th><th className="mono">School</th><th className="mono">Rating</th>
                <th className="mono">From</th><th className="mono">Record</th><th className="mono">Tourns</th><th className="mono">Speaks</th>
              </tr></thead>
              <tbody>
                {shownField.map((e) => (
                  <tr key={e.entryId}>
                    <td className="who">
                      <button className="teamlink" onClick={() => setOpenCode(e.code)}>{e.code}</button>
                      {e.name && <small style={{ display: "block", color: "var(--muted)" }}>{e.name}</small>}
                    </td>
                    <td className="ch">{e.school || "—"}</td>
                    <td className="pts num">{e.rating ?? "—"}</td>
                    <td className="cr">{e.source === "team" ? "this pairing" : e.source === "debaters" ? "its debaters" : "unrated"}</td>
                    <td className="cr">{e.games ? `${e.wins}–${e.losses}` : "—"}</td>
                    <td className="cr num">{e.tournaments || "—"}</td>
                    <td className="cr num">{e.pointsAvg ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === "odds" && pred && (
        <div className="tablewrap">
          <table className="lb rank">
            <thead><tr>
              <th className="rk mono">#</th><th className="mono">Entry</th><th className="mono">Breaks</th>
              <th className="mono">Semis</th><th className="mono">Final</th><th className="mono">Wins it</th><th className="mono">Mean wins</th>
            </tr></thead>
            <tbody>
              {pred.odds.filter((o) => !q || o.code.toLowerCase().includes(q) || (o.school || "").toLowerCase().includes(q)).slice(0, 80).map((o, i) => (
                <tr key={o.code}>
                  <td className="rk">{i + 1}</td>
                  <td className="who">
                    <button className="teamlink" onClick={() => setOpenCode(o.code)}>{o.code}</button>
                    {o.school && <small style={{ display: "block", color: "var(--muted)" }}>{o.school}{o.rated ? "" : " · unrated"}</small>}
                  </td>
                  <td className="pts num">{o.breakPct.toFixed(1)}%</td>
                  <td className="cr num">{o.semiPct.toFixed(1)}%</td>
                  <td className="cr num">{o.finalPct.toFixed(1)}%</td>
                  <td className="cr num">{o.champPct.toFixed(1)}%</td>
                  <td className="cr num">{o.meanWins.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "next" && pred?.nextRound && (
        <div className="sample">
          <h3 className="sec">
            {pred.nextRound.published
              ? `Round ${pred.nextRound.round} is already paired`
              : `Who you would draw in round ${pred.nextRound.round}`}{" "}
            <span className="mono">{pred.progressNote || ""}</span>
          </h3>
          <p className="hint">
            {pred.nextRound.published
              ? "Tabroom has posted this pairing, so these are the real matchups rather than a guess."
              : "Rounds already debated are counted as they stand, so this pairs from the real standings. A tabroom seeds each bracket on speaker points, pairs the top against the bottom, keeps schools apart, and pulls up the weakest schedule when a bracket is odd. A high percentage means the model sees no other way to pair you, not that the pairing is settled: it is working from an estimate of the seed order, and a small difference there changes who you draw."}
          </p>
          <div className="tablewrap">
            <table className="lb rank">
              <thead><tr>
                <th className="mono">Entry</th><th className="mono">Record</th><th className="mono">Most likely opponents</th>
              </tr></thead>
              <tbody>
                {pred.nextRound.matchups
                  .filter((m) => !q || m.code.toLowerCase().includes(q) || m.opponents.some((o) => o.opp.toLowerCase().includes(q)))
                  .slice(0, 120)
                  .map((m) => (
                    <tr key={m.code}>
                      <td className="who"><button className="teamlink" onClick={() => setOpenSim(m.code)}>{m.code}</button></td>
                      <td className="cr">{m.wins}&ndash;{m.losses}</td>
                      <td>
                        <div className="nextopps">
                          {m.opponents.slice(0, 5).map((o) => (
                            <span className="nextopp" key={o.opp}>
                              <b>{o.opp === "bye" ? "a bye" : o.opp}</b>
                              <i>{o.pct >= 99.5 ? "99%+" : `${o.pct.toFixed(0)}%`}</i>
                            </span>
                          ))}
                          {!m.opponents.length && <span className="nextopp"><b>nobody yet</b></span>}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "bracket" && pred && (
        <div className="sample">
          <h3 className="sec">One way it could go <span className="mono">{pred.sample.breakField.length} broke · champion {pred.sample.champion || "—"}</span></h3>
          <p className="hint">Click any seed to see how this run went for them, round by round, and who the model has beating them.</p>
          <div className="tablewrap">
            <table className="lb plain">
              <thead><tr><th className="mono">Seed</th><th className="mono">Entry</th><th className="mono">Prelims</th><th className="mono">Out</th></tr></thead>
              <tbody>
                {pred.sample.breakField.slice(0, 32).map((b) => (
                  <tr key={b.code}>
                    <td className="cr num">{b.seed}</td>
                    <td className="who"><button className="teamlink" onClick={() => setOpenSim(b.code)}>{b.code}</button></td>
                    <td className="cr">{b.wins}–{b.losses}</td>
                    <td className="cr">{exitOf(pred, b.code)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="board">
            <div className="canvas" style={{ ["--bh" as any]: `calc(${pred.sample.elims[0]?.length || 1} * var(--match-h))` }}>
              {pred.sample.elims.map((round, i) => (
                <div className="round" key={i}>
                  <div className="rhead">
                    <div className="rn">{round[0]?.round}</div>
                    <div className="rc">{round.length * 2} teams</div>
                  </div>
                  <div className="matches">
                    {round.map((m, j) => (
                      <div className="match" key={j}>
                        <div className="teams">
                          <SimSlot code={m.a} winner={m.winner} seeds={seeds} onOpen={setOpenSim} />
                          <SimSlot code={m.b} winner={m.winner} seeds={seeds} onOpen={setOpenSim} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
