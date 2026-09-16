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
 * This is one run out of hundreds. The odds tab is the distribution; this is a
 * single sample, and the panel says so rather than letting it read as a forecast.
 */

export interface SimRoundView { round: number; opp: string; won: boolean; recordBefore: string }
export interface SimPrelimView { code: string; wins: number; losses: number; seed: number; rounds: SimRoundView[] }
export interface SimMatchView { round: string; a: string | null; b: string | null; winner: string | null; bye: boolean }

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

interface ElimStep { round: string; opp: string | null; won: boolean; bye: boolean }

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

  // their elim path, walked out of the sample bracket
  const path: ElimStep[] = [];
  for (const round of elims) {
    const m = round.find((x) => x.a === code || x.b === code);
    if (!m) continue;
    const opp = m.a === code ? m.b : m.a;
    path.push({ round: m.round, opp, won: m.winner === code, bye: m.bye });
    if (m.winner !== code) break;
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
              <h3>Prelims <span>round by round, with the record they carried in</span></h3>
              <ol className="sim-rounds">
                {me.rounds.map((r) => (
                  <li className={"sim-r " + (r.won ? "w" : "l")} key={r.round}>
                    <span className="sim-rn mono">R{r.round}</span>
                    <span className="sim-rec mono">{r.recordBefore}</span>
                    <span className="sim-res">{r.won ? "beat" : "lost to"}</span>
                    <span className="sim-opp">{r.opp === "bye" ? "a bye" : r.opp}</span>
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
                      <span className="sim-opp">{s.bye || !s.opp ? "a bye" : s.opp}</span>
                    </li>
                  ))}
                </ol>
                {won && <p className="sim-note">Took the tournament in this run.</p>}
              </section>
            )}

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
