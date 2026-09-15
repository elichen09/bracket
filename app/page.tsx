"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import AdminUpdate from "@/components/AdminUpdate";
import Strata from "@/components/Strata";
import { useTournaments, useUser } from "@/lib/useBreak";
import { model, progress, build, type Model, type Match } from "@/lib/bracket";
import type { Tournament } from "@/lib/types";

export default function Home() {
  const tournaments = useTournaments();
  const user = useUser();
  const router = useRouter();
  const list = tournaments || [];
  const live = list.filter((t) => t.slots.length && (() => { const P = progress(model(t)); return !P.complete && P.done > 0; })());
  const ticker = useMemo(() => tickerItems(list), [list]);
  useReveal();

  return (
    <>
      <Nav />
      <main className="landing">
        <section className="hero2">
          <div className="hero-copy">
          <div className="hero-top mono">
            <span>Bracket pools for debate elims</span>
            <span className="dotline" />
            <span>{live.length ? `${live.length} live now` : `${list.length} tournament${list.length === 1 ? "" : "s"}`}</span>
          </div>
          <h1 className="giant" aria-label="The Break">
            <span className="w"><span>THE</span></span>
            <span className="w"><span><em>Break</em></span></span>
          </h1>
          <div className="hero-foot">
            <p className="lede2">
              Fill in a Tabroom elim bracket before it breaks. Lock it. Watch it score itself as the
              ballots post — with a full statistical dossier on every team, one click away.
            </p>
            <div className="cta-row">
              {user ? (
                <a className="btn-big" href="#board">Open the board <i>→</i></a>
              ) : (
                <>
                  <Link className="btn-big" href="/login?mode=up">Create account <i>→</i></Link>
                  <Link className="btn-ghost" href="/login">Sign in</Link>
                </>
              )}
            </div>
          </div>
          <div className="scrollcue mono" aria-hidden="true"><span /> scroll</div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <Strata palette="dusk" />
            <div className="grain" />
            <span className="art-tag mono">Fig. 01 — the break</span>
          </div>
        </section>

        {ticker.length > 0 && (
          <div className="ticker" aria-label="Latest results">
            <div className="track">
              {[...ticker, ...ticker].map((s, i) => <span key={i}>{s}<i>◆</i></span>)}
            </div>
          </div>
        )}

        <section className="board2" id="board">
          <div className="panel cream" data-reveal>
            <p className="mono">The board</p>
            <div className="bignum">{String(list.length).padStart(2, "0")}</div>
            <p className="sub2">tournament{list.length === 1 ? "" : "s"} tracked · {live.length ? `${live.length} in elims right now` : "results pull in hourly"}</p>
            <p className="fine2">Every round is worth the same total, late calls pay like early ones, and calling an upset pays extra.</p>
          </div>
          <div className="panel mint" data-reveal>
            <p className="mono">Pick a pool</p>
            {tournaments === null ? <div className="empty">Loading…</div>
              : list.length === 0 ? <div className="empty">No tournaments yet. <Link href="/new">Add one</Link>.</div>
              : list.map((t, i) => <Row key={t.id} t={t} i={i} onOpen={() => router.push(`/t/${t.id}`)} />)}
          </div>
        </section>

        <section className="feature" data-reveal>
          <div className="feat-copy">
            <p className="mono">The dossier</p>
            <h2>Every team, <em>x-rayed.</em></h2>
            <p>Click any name in a bracket and the record opens: prelim form, speaker points round by round, who they drew, which judges have seen them and how it went, ballots in every elim, where they sit in the whole field — and what this pool thinks of them.</p>
          </div>
          <div className="feat-art" aria-hidden="true">
            <DemoChart />
          </div>
        </section>

        <section className="steps">
          {[
            ["01", "Pick", "Click the team that wins each match and they carry forward. Everything upstream of a change clears, so a bracket is always internally consistent."],
            ["02", "Lock", "Lock when you're done, or don't: every match locks itself the instant its real result lands. There is no picking after the fact."],
            ["03", "Score", "Points double every round so each round is worth the same total. Call a lower seed and take a bonus on top, capped at double."],
          ].map(([n, h, p]) => (
            <div className="step" key={n} data-reveal>
              <span className="n">{n}</span>
              <h3>{h}</h3>
              <p>{p}</p>
            </div>
          ))}
        </section>

        <footer className="foot mono">
          <span>The Break · results via Tabroom</span>
          <span><Link href="/about">Scoring</Link> · <Link href="/new">Add a tournament</Link></span>
        </footer>
        <AdminUpdate />
      </main>
    </>
  );
}

function Row({ t, i, onOpen }: { t: Tournament; i: number; onOpen: () => void }) {
  const M = model(t);
  const P = progress(M);
  let status: string, pill: React.ReactNode;
  if (!M.size) { status = "waiting for bracket"; pill = <span className="pill">Pending</span>; }
  else if (P.complete) { status = `won by ${P.champ!.name}`; pill = <span className="pill done">Final</span>; }
  else if (P.done === 0) { status = "open for picks"; pill = <span className="pill">Open</span>; }
  else { status = `${M.names[P.liveRound!]} in play`; pill = <span className="pill live">Live</span>; }
  const sub = (t.event || "") + (M.size ? ` · ${M.teamCount} teams` : "");
  return (
    <div className={"row2" + (M.size ? "" : " pending")} onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}>
      <div className="n">{String(i + 1).padStart(2, "0")}</div>
      <div className="t">{t.name}{pill}<small>{sub}</small></div>
      <div className="s mono">{status}</div>
      <div className="a">→</div>
    </div>
  );
}

/** Latest reported results across every tournament, newest round first. */
function tickerItems(list: Tournament[]): string[] {
  const out: string[] = [];
  for (const t of list) {
    if (!t.slots.length) continue;
    const M: Model = model(t);
    const real: Match[][] = build(M, "real");
    for (let r = M.rounds - 1; r >= 0 && out.length < 24; r--) {
      const done = real[r].filter((mt) => mt.official && mt.winner && mt.loser);
      if (!done.length) continue;
      for (const mt of done.slice(0, 8)) {
        const up = mt.winner!.seed > mt.loser!.seed ? " · UPSET" : "";
        out.push(`${t.name} · ${M.names[r]} · ${mt.winner!.seed} ${mt.winner!.name} def. ${mt.loser!.seed} ${mt.loser!.name} ${mt.official!.margin}${up}`);
      }
      break;
    }
  }
  return out;
}

function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (!("IntersectionObserver" in window)) { els.forEach((el) => el.classList.add("in")); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.18 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/** Decorative: a speaker-points line drawing itself, for the feature panel. */
function DemoChart() {
  const ref = useRef<SVGPathElement>(null);
  const a = [28.6, 29.1, 28.9, 29.4, 29.6, 29.3, 29.8, 29.9];
  const b = [28.2, 28.7, 29.0, 28.8, 29.3, 29.5, 29.4, 29.7];
  const W = 520, H = 220, pl = 30, pr = 30, pt = 24, pb = 28;
  const lo = 27.9, hi = 30.1;
  const x = (i: number) => pl + (i / 7) * (W - pl - pr);
  const y = (v: number) => pt + ((hi - v) / (hi - lo)) * (H - pt - pb);
  const d = (s: number[]) => s.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="demo">
      {[28, 28.5, 29, 29.5, 30].map((v) => <line key={v} x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} className="grid" />)}
      <path d={d(b)} className="l2" ref={ref} />
      <path d={d(a)} className="l1" />
      {a.map((v, i) => <circle key={"a" + i} cx={x(i)} cy={y(v)} r={4.5} className="d1" style={{ animationDelay: `${0.9 + i * 0.12}s` }} />)}
      {b.map((v, i) => <circle key={"b" + i} cx={x(i)} cy={y(v)} r={4.5} className="d2" style={{ animationDelay: `${1.1 + i * 0.12}s` }} />)}
      <text x={x(7) + 8} y={y(a[7]) + 4} className="lbl">29.9</text>
      <text x={x(7) + 8} y={y(b[7]) + 4} className="lbl">29.7</text>
      {["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"].map((r, i) => <text key={r} x={x(i)} y={H - 8} className="lbl" textAnchor="middle">{r}</text>)}
    </svg>
  );
}
