"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * One team's weekend, as the simulation ran it.
 *
 * The bracket underneath shows who advanced; this says how they got there. Every
 * prelim is listed with the record they carried into it and who they drew, and
 * the losses are called out on their own, because "who does the model think beats
 * them" is the question a seed line cannot answer.
 *
 * Each round also says why it leaned the way it did. A probability alone is not
 * an explanation, so the line names the term that actually decided it: the rating
 * gap, speaker-point form, or a result these two have already produced.
 *
 * This is one run out of hundreds. The odds tab is the distribution; this is a
 * single sample, and the panel says so rather than letting it read as a forecast.
 */

export interface SimRoundView {
  round: number; opp: string; won: boolean; recordBefore: string;
  chance?: number; base?: number; form?: number; h2h?: number;
  h2hW?: number; h2hL?: number; rating?: number; oppRating?: number;
  actual?: boolean;        // debated for real, so there is nothing to predict
}
export interface SimPrelimView { code: string; wins: number; losses: number; seed: number; rounds: SimRoundView[] }
export interface SimMatchView {
  round: string; a: string | null; b: string | null; winner: string | null; bye: boolean;
  chance?: number | null; form?: number; h2hW?: number; h2hL?: number; aRating?: number; bRating?: number;
}

interface Props {
  code: string;
  prelims: SimPrelimView[];
  elims: SimMatchView[][];
  champion: string | null;
  breakWins: number;
  totalPrelims: number;
  fieldSize: number;
  onClose: () => void;
  onCareer: (code: string) => void;
}

interface Reasoned {
  chance?: number; form?: number; h2hW?: number; h2hL?: number; rating?: number; oppRating?: number; won: boolean;
}

interface ElimStep extends Reasoned { round: string; opp: string | null; bye: boolean }

/**
 * Why the model leaned this way, in one line.
 *
 * The rating gap is always shown, since it is the base of every estimate. A
 * second clause appears only when another term did real work, so the usual round
 * reads as what it is: two ratings and nothing else.
 */
function why(r: Reasoned): { text: string; upset: boolean } | null {
  if (r.chance === undefined || r.chance === null) return null;
  const pct = Math.round(r.chance * 100);
  // Only a real surprise counts. Scoring every round the nominal favourite lost
  // tags two rounds in five, because most pairings sit near a coin flip.
  const upset = r.won ? r.chance <= 0.35 : r.chance >= 0.65;

  const parts: string[] = [];
  const gap = r.rating !== undefined && r.oppRating !== undefined && r.oppRating > 0 ? r.rating - r.oppRating : null;
  if (gap !== null) {
    parts.push(Math.abs(gap) < 25 ? `level on rating, ${r.rating} to ${r.oppRating}` : `rated ${r.rating} to ${r.oppRating}`);
  }
  const met = (r.h2hW ?? 0) + (r.h2hL ?? 0);
  if (met > 0) {
    parts.push(`${r.h2hW}–${r.h2hL} against them already`);
  } else if (r.form !== undefined && Math.abs(r.form) >= 0.03 && (gap === null || Math.abs(gap) < 60)) {
    // Only when form did real work. A strong-speaking team carries the same edge
    // into every round, so naming it beside a wide rating gap explains nothing and
    // repeats on every line.
    parts.push(r.form > 0 ? "ahead on speaks" : "behind on speaks");
  }
  return { text: `${pct}% · ${parts.join(" · ")}`, upset };
}

function Why({ r }: { r: Reasoned }) {
  const w = why(r);
  if (!w) return null;
  return (
    <small className="sim-why">
      {w.text}
      {w.upset && <> · <span className="upset">upset</span></>}
    </small>
  );
}

export default function SimRecord({
  code, prelims, elims, champion, breakWins, totalPrelims, fieldSize, onClose, onCareer,
}: Props) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const me = prelims.find((p) => p.code === code) || null;
  const losses = (me?.rounds || []).filter((r) => !r.won);
  const broke = !!me && me.wins >= breakWins;

  // their elim path, walked out of the sample bracket and turned to face them
  const path: ElimStep[] = [];
  for (const round of elims) {
    const m = round.find((x) => x.a === code || x.b === code);
    if (!m) continue;
    const isA = m.a === code;
    const won = m.winner === code;
    path.push({
      round: m.round,
      opp: isA ? m.b : m.a,
      bye: m.bye,
      won,
      chance: m.chance === null || m.chance === undefined ? undefined : (isA ? m.chance : 1 - m.chance),
      form: m.form === undefined ? undefined : (isA ? m.form : -m.form),
      h2hW: isA ? m.h2hW : m.h2hL,
      h2hL: isA ? m.h2hL : m.h2hW,
      rating: isA ? m.aRating : m.bRating,
      oppRating: isA ? m.bRating : m.aRating,
    });
    if (!won) break;
  }
  const knockedOut = path.find((s) => !s.won) || null;
  const won = champion === code;

  return createPortal(
    <div className="dossier-veil" onClick={onClose}>
      <aside
        className="dossier sim-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${code} simulated record`}
        ref={panel}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="d-strip" aria-hidden="true" />
        <button className="d-close" onClick={onClose} aria-label="Close">✕</button>

        <header className="d-head">
          <div className="d-seed"><span className="mono">seed</span><b>{me ? me.seed : "—"}</b></div>
          <div className="d-title">
            <h2>{code}</h2>
            <p className="mono">one simulated tournament · not a result</p>
            <p className="d-status">
              {!me ? "This entry did not appear in the sample run." :
                won ? `Won the tournament, ${me.wins}–${me.losses} in prelims.` :
                knockedOut ? `Out in ${knockedOut.round.toLowerCase()} to ${knockedOut.opp}, after going ${me.wins}–${me.losses} in prelims.` :
                broke ? `Broke on ${me.wins}–${me.losses}.` :
                `Missed the break on ${me.wins}–${me.losses}.`}
            </p>
          </div>
        </header>

        {me && (
          <>
            <div className="d-kpis">
              <Kpi k="Prelims" v={`${me.wins}–${me.losses}`} sub={`${totalPrelims} rounds`} />
              <Kpi k="Prelim finish" v={`${me.seed}`} sub={`of ${fieldSize} entries`} />
              <Kpi k="Broke" v={broke ? "Yes" : "No"} sub={`${breakWins} wins needed`} />
              <Kpi k="Lost to" v={String(losses.length)} sub={losses.length ? "teams, in prelims" : "nobody, in prelims"} />
            </div>

            {losses.length > 0 && (
              <div className="meetings" style={{ marginTop: 18 }}>
                <h5>Who the model has beating them</h5>
                <ul>
                  {losses.map((r) => (
                    <li key={r.round}>
                      <b className="l">Round {r.round}</b> lost to {r.opp} <span>· came in {r.recordBefore}</span>
                    </li>
                  ))}
                  {knockedOut && knockedOut.opp && (
                    <li key="elim">
                      <b className="l">{knockedOut.round}</b> lost to {knockedOut.opp} <span>· knocked out</span>
                    </li>
                  )}
                </ul>
              </div>
            )}

            <section className="d-sec wide" style={{ marginTop: 18 }}>
              <h3>Prelims <span>round by round, and what the model made of each one</span></h3>
              <ol className="sim-rounds">
                {me.rounds.map((r) => (
                  <li className={"sim-r " + (r.won ? "w" : "l")} key={r.round}>
                    <span className="sim-rn mono">R{r.round}</span>
                    <span className="sim-rec mono">{r.recordBefore}</span>
                    <span className="sim-res">{r.won ? "beat" : "lost to"}</span>
                    <span className="sim-opp">
                      <b className="sim-name">{r.opp === "bye" ? "a bye" : r.opp}</b>
                      {r.opp !== "bye" && (r.actual
                        ? <small className="sim-why played">this round was debated</small>
                        : <Why r={r} />)}
                    </span>
                  </li>
                ))}
              </ol>
              {!me.rounds.length && <p className="sim-note">No rounds were kept for this entry.</p>}
            </section>

            {path.length > 0 && (
              <section className="d-sec wide" style={{ marginTop: 14 }}>
                <h3>Elims <span>how far this run took them</span></h3>
                <ol className="sim-rounds">
                  {path.map((s, i) => (
                    <li className={"sim-r elim " + (s.won ? "w" : "l")} key={i}>
                      <span className="sim-rn mono">{s.round}</span>
                      <span className="sim-res">{s.bye ? "had" : s.won ? "beat" : "lost to"}</span>
                      <span className="sim-opp">
                        <b className="sim-name">{s.bye || !s.opp ? "a bye" : s.opp}</b>
                        {!s.bye && s.opp && <Why r={s} />}
                      </span>
                    </li>
                  ))}
                </ol>
                {won && <p className="sim-note">Took the tournament in this run.</p>}
              </section>
            )}

            <p className="sim-note">
              The percentage is what the model gave them going into that round: the two
              ratings first, then speaker-point form, then anything these two have already
              done to each other. A round is marked an upset only when a clear underdog took
              it, which at these odds happens often enough to expect.
            </p>

            <div className="sim-actions">
              <button className="teamlink" onClick={() => onCareer(code)}>
                See their real record instead →
              </button>
            </div>
          </>
        )}

        <p className="d-foot mono">
          One run of the simulation · the odds tab is what happens across all of them
        </p>
      </aside>
    </div>,
    document.body,
  );
}

function Kpi({ k, v, sub }: { k: string; v: string; sub: string }) {
  return <div className="kpi"><span className="k mono">{k}</span><b className="v">{v}</b><span className="s">{sub}</span></div>;
}
