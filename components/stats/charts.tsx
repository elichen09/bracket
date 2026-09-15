"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import type { RoundStat, SpeakerStat, FieldRow, TeamStats } from "@/lib/tabroomApi";
import type { CareerRecord, CareerTournament } from "@/lib/career";

/*
 * Hand-drawn SVG charts for the team dossier. All of them follow the same
 * rules: thin marks, one axis, recessive hairline grid, direct labels only
 * where they earn it, a hover layer, and text in text colours (never the
 * series colour). Series colours come from CSS tokens --s1 / --s2 / --s3.
 */

// ---------------------------------------------------------------------------
// Tooltip plumbing
// ---------------------------------------------------------------------------

interface TipState { x: number; y: number; body: ReactNode }

export function useTip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const show = useCallback((e: { clientX: number; clientY: number }, body: ReactNode) => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, body });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  const Tip = tip ? (
    <div className="tip" style={{ left: tip.x, top: tip.y }} role="status">{tip.body}</div>
  ) : null;
  return { wrap, show, hide, Tip };
}

const fmt1 = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toFixed(1));
const nice = (lo: number, hi: number, steps = 4) => {
  const span = hi - lo || 1;
  const raw = span / steps;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
  return { start, end, ticks };
};

// ---------------------------------------------------------------------------
// 1. Form line — running win/loss differential through the prelims
// ---------------------------------------------------------------------------

export function FormLine({ rounds }: { rounds: RoundStat[] }) {
  const { wrap, show, hide, Tip } = useTip();
  const rs = rounds.filter((r) => r.type === "prelim" || r.type === "bye");
  if (!rs.length) return <Empty>No prelim rounds published yet.</Empty>;
  const W = 640, H = 200, padL = 34, padR = 44, padT = 22, padB = 40;
  let net = 0;
  const pts = rs.map((r, i) => {
    if (r.result === "W") net++; else if (r.result === "L") net--;
    return { r, i, net };
  });
  const maxAbs = Math.max(1, ...pts.map((p) => Math.abs(p.net)));
  const x = (i: number) => padL + (i / Math.max(1, rs.length - 1)) * (W - padL - padR);
  const y = (v: number) => padT + ((maxAbs - v) / (2 * maxAbs)) * (H - padT - padB);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.net).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const wins = rs.filter((r) => r.result === "W").length, losses = rs.filter((r) => r.result === "L").length;
  return (
    <div className="chart" ref={wrap}>
      <svg viewBox={`0 0 ${W} ${H}`} className="svg" role="img" aria-label={`Prelim form: ${wins} wins, ${losses} losses`} onPointerLeave={hide}>
        {[maxAbs, 0, -maxAbs].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className={v === 0 ? "axis" : "grid"} />
            <text x={padL - 8} y={y(v) + 4} className="tick" textAnchor="end">{v > 0 ? `+${v}` : v}</text>
          </g>
        ))}
        <path d={path} className="line s1" />
        {pts.map((p, i) => {
          const win = p.r.result === "W", bye = p.r.result === "B";
          return (
            <g key={i} onPointerMove={(e) => show(e, <RoundTip r={p.r} />)} onFocus={(e) => show({ clientX: (e.target as SVGElement).getBoundingClientRect().left, clientY: (e.target as SVGElement).getBoundingClientRect().top }, <RoundTip r={p.r} />)} onBlur={hide} tabIndex={0} className="hit">
              <circle cx={x(i)} cy={y(p.net)} r={12} className="hitarea" />
              <circle cx={x(i)} cy={y(p.net)} r={6} className={bye ? "dot muted" : win ? "dot s1" : "dot hollow s1"} />
              <text x={x(i)} y={H - padB + 18} className="tick" textAnchor="middle">{p.r.label.replace(/^round\s*/i, "R")}</text>
              <text x={x(i)} y={H - padB + 31} className={"side " + (p.r.side === "Aff" ? "aff" : p.r.side === "Neg" ? "neg" : "")} textAnchor="middle">{p.r.side ? p.r.side.toUpperCase() : bye ? "BYE" : ""}</text>
            </g>
          );
        })}
        <text x={x(pts.length - 1) + 12} y={y(last.net) + 4} className="label">{wins}–{losses}</text>
      </svg>
      {Tip}
    </div>
  );
}

function RoundTip({ r }: { r: RoundStat }) {
  return (
    <>
      <b>{r.result === "W" ? "Won" : r.result === "L" ? "Lost" : r.result === "B" ? "Bye" : "Pending"}{r.type === "elim" ? ` ${r.ballots.for}–${r.ballots.against}` : ""}</b>
      <span>{r.label}{r.side ? ` · ${r.side}` : ""}{r.opponent ? ` · vs ${r.opponent.seed ? `${r.opponent.seed}. ` : ""}${r.opponent.code}` : ""}</span>
      {r.points !== null && <span>{fmt1(r.points)} team points</span>}
      {r.judges.length > 0 && <span>{r.judges.map((j) => j.name.replace(/ - ONLINE/i, "")).join(" · ")}</span>}
    </>
  );
}

// ---------------------------------------------------------------------------
// 2. Speaker points per round, one line per debater
// ---------------------------------------------------------------------------

export function PointsLines({ rounds, speakers }: { rounds: RoundStat[]; speakers: SpeakerStat[] }) {
  const { wrap, show, hide, Tip } = useTip();
  const idx = rounds.map((r, i) => ({ r, i })).filter(({ r }) => r.type === "prelim" && Object.values(r.studentPoints).some((v) => v !== null));
  const series = speakers.map((s, k) => ({ s, k, vals: idx.map(({ i }) => s.perRound[i]) }));
  const all = series.flatMap((s) => s.vals).filter((v): v is number => v !== null);
  if (!idx.length || !all.length) return <Empty>Speaker points aren&rsquo;t published for this event.</Empty>;
  const W = 640, H = 220, padL = 44, padR = 118, padT = 16, padB = 32;
  const { start, end, ticks } = nice(Math.min(...all) - 0.3, Math.max(...all) + 0.3, 4);
  const x = (j: number) => padL + (j / Math.max(1, idx.length - 1)) * (W - padL - padR);
  const y = (v: number) => padT + ((end - v) / (end - start || 1)) * (H - padT - padB);
  // end labels: keep them at least 15px apart, with a leader line back to the line end
  const ends = series.map((s) => { const v = s.vals[s.vals.length - 1]; return v === null ? null : y(v); });
  const labelY = ends.slice();
  for (let pass = 0; pass < 4; pass++) {
    const order = labelY.map((v, i) => [v, i] as [number | null, number]).filter((p): p is [number, number] => p[0] !== null).sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < order.length; k++) {
      const gap = order[k][0] - order[k - 1][0];
      if (gap < 15) { const push = (15 - gap) / 2; labelY[order[k - 1][1]] = order[k - 1][0] - push; labelY[order[k][1]] = order[k][0] + push; order[k - 1][0] -= push; order[k][0] += push; }
    }
  }
  const teamAvg = all.reduce((a, b) => a + b, 0) / all.length;
  const [hover, setHover] = useState<number | null>(null);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0, bd = Infinity;
    idx.forEach((_, j) => { const d = Math.abs(x(j) - px); if (d < bd) { bd = d; best = j; } });
    setHover(best);
    show(e, (
      <>
        <b>{idx[best].r.label}</b>
        {series.map((s) => <span key={s.k}><i className={`key s${s.k + 1}`} />{fmt1(s.vals[best])} · {s.s.name}</span>)}
        <span>{idx[best].r.result === "W" ? "Won" : idx[best].r.result === "L" ? "Lost" : ""}{idx[best].r.opponent ? ` vs ${idx[best].r.opponent!.code}` : ""}</span>
      </>
    ));
  };
  return (
    <div className="chart" ref={wrap}>
      <div className="legend">{series.map((s) => <span key={s.k}><i className={`key s${s.k + 1}`} />{s.s.name}</span>)}<span><i className="key avg" />team average {fmt1(teamAvg)}</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} className="svg" role="img" aria-label="Speaker points by round" onPointerMove={onMove} onPointerLeave={() => { hide(); setHover(null); }}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="grid" />
            <text x={padL - 8} y={y(v) + 4} className="tick" textAnchor="end">{v.toFixed(1)}</text>
          </g>
        ))}
        <line x1={padL} x2={W - padR} y1={y(teamAvg)} y2={y(teamAvg)} className="avgline" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} className="crosshair" />}
        {idx.map(({ r }, j) => <text key={j} x={x(j)} y={H - padB + 18} className="tick" textAnchor="middle">{r.label.replace(/^round\s*/i, "R")}</text>)}
        {series.map((s) => {
          const segs: string[] = [];
          let open = false;
          s.vals.forEach((v, j) => { if (v === null) { open = false; return; } segs.push(`${open ? "L" : "M"}${x(j).toFixed(1)},${y(v).toFixed(1)}`); open = true; });
          const lastJ = s.vals.length - 1;
          const lastV = s.vals[lastJ];
          return (
            <g key={s.k}>
              <path d={segs.join(" ")} className={`line s${s.k + 1}`} />
              {s.vals.map((v, j) => v === null ? null : <circle key={j} cx={x(j)} cy={y(v)} r={hover === j ? 6 : 4.5} className={`dot s${s.k + 1}`} />)}
              {lastV !== null && labelY[s.k] !== null && (
                <g>
                  <line x1={x(lastJ) + 6} y1={y(lastV)} x2={x(lastJ) + 14} y2={labelY[s.k] as number} className="leader" />
                  <text x={x(lastJ) + 17} y={(labelY[s.k] as number) + 4} className="label">{fmt1(lastV)} {s.s.name.split(" ")[0]}</text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
      {Tip}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Side balance — record on the Aff and on the Neg
// ---------------------------------------------------------------------------

export function SideBars({ aff, neg }: { aff: { w: number; l: number }; neg: { w: number; l: number } }) {
  const rows = [{ k: "Aff", ...aff }, { k: "Neg", ...neg }];
  const max = Math.max(1, ...rows.map((r) => r.w + r.l));
  const W = 420, H = 96, padL = 44, padR = 66, bh = 18, gap = 2;
  const x = (v: number) => padL + (v / max) * (W - padL - padR);
  return (
    <div className="chart">
      <div className="legend"><span><i className="key rect s1" />wins</span><span><i className="key rect muted" />losses</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} className="svg" role="img" aria-label={`Aff ${aff.w}–${aff.l}, Neg ${neg.w}–${neg.l}`}>
        {rows.map((r, i) => {
          const cy = 18 + i * 40;
          const n = r.w + r.l;
          return (
            <g key={r.k}>
              <text x={padL - 12} y={cy + bh / 2 + 4} className="tick" textAnchor="end">{r.k.toUpperCase()}</text>
              {r.w > 0 && <rect x={x(0)} y={cy} width={Math.max(0, x(r.w) - x(0) - (r.l ? gap : 0))} height={bh} rx={r.l ? 0 : 4} className="vbar s1" />}
              {r.l > 0 && <rect x={x(r.w) + (r.w ? gap : 0)} y={cy} width={Math.max(0, x(n) - x(r.w) - (r.w ? gap : 0))} height={bh} rx={4} className="vbar muted" />}
              <text x={x(n) + 10} y={cy + bh / 2 + 4} className="label">{r.w}–{r.l}{n ? ` · ${Math.round((r.w / n) * 100)}%` : ""}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Percentile ring — a meter for a speaker's standing in the field
// ---------------------------------------------------------------------------

export function Ring({ pct, big, small, tone = 1 }: { pct: number | null; big: string; small: string; tone?: 1 | 2 }) {
  const r = 44, c = 2 * Math.PI * r;
  const p = pct === null ? 0 : Math.max(0, Math.min(100, pct)) / 100;
  return (
    <svg viewBox="0 0 120 120" className={`ring s${tone}`} role="img" aria-label={`${big}, ${small}`}>
      <circle cx="60" cy="60" r={r} className="track" />
      <circle cx="60" cy="60" r={r} className="arc" strokeDasharray={`${c * p} ${c * (1 - p)}`} transform="rotate(-90 60 60)" />
      <text x="60" y="58" textAnchor="middle" className="big">{big}</text>
      <text x="60" y="76" textAnchor="middle" className="small">{small}</text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 5. Field scatter — every team by seed and prelim points, this one lit up
// ---------------------------------------------------------------------------

export function FieldScatter({ field, me, opponents }: { field: FieldRow[]; me: number; opponents: Set<number> }) {
  const { wrap, show, hide, Tip } = useTip();
  const rows = field.filter((r) => r.points !== null);
  if (rows.length < 4) return <Empty>Prelim seeds aren&rsquo;t published yet.</Empty>;
  const W = 640, H = 240, padL = 48, padR = 20, padT = 14, padB = 34;
  const seeds = rows.map((r) => r.seed), ptsAll = rows.map((r) => r.points as number);
  const { start, end, ticks } = nice(Math.min(...ptsAll), Math.max(...ptsAll), 4);
  const maxSeed = Math.max(...seeds);
  const x = (s: number) => padL + ((s - 1) / Math.max(1, maxSeed - 1)) * (W - padL - padR);
  const y = (v: number) => padT + ((end - v) / (end - start || 1)) * (H - padT - padB);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W, py = ((e.clientY - rect.top) / rect.height) * H;
    let best: FieldRow | null = null, bd = Infinity;
    for (const r of rows) { const d = Math.hypot(x(r.seed) - px, y(r.points as number) - py); if (d < bd) { bd = d; best = r; } }
    if (best && bd < 40) show(e, <><b>{best.seed}. {best.code}</b><span>{best.wins !== null ? `${best.wins} prelim wins · ` : ""}{fmt1(best.points)} pts{best.place ? ` · ${best.place}` : ""}</span></>);
    else hide();
  };
  const xTicks = [1, ...[0.25, 0.5, 0.75].map((f) => Math.round(maxSeed * f)), maxSeed].filter((v, i, a) => a.indexOf(v) === i);
  const mine = rows.find((r) => r.entryId === me);
  return (
    <div className="chart" ref={wrap}>
      <div className="legend"><span><i className="key dot muted" />field</span><span><i className="key dot s2" />opponents faced</span><span><i className="key dot s1" />this team</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} className="svg" role="img" aria-label="Field: prelim points by seed" onPointerMove={onMove} onPointerLeave={hide}>
        {ticks.map((v) => <g key={v}><line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="grid" /><text x={padL - 8} y={y(v) + 4} className="tick" textAnchor="end">{v}</text></g>)}
        {xTicks.map((v) => <text key={v} x={x(v)} y={H - padB + 18} className="tick" textAnchor="middle">{v === 1 ? "seed 1" : v}</text>)}
        {rows.filter((r) => r.entryId !== me && !opponents.has(r.entryId)).map((r) => <circle key={r.entryId} cx={x(r.seed)} cy={y(r.points as number)} r={3.5} className="dot muted soft" />)}
        {rows.filter((r) => opponents.has(r.entryId)).map((r) => <circle key={r.entryId} cx={x(r.seed)} cy={y(r.points as number)} r={5} className="dot s2 ringed" />)}
        {mine && <circle cx={x(mine.seed)} cy={y(mine.points as number)} r={7} className="dot s1 ringed" />}
        {mine && <text x={x(mine.seed) + (mine.seed > maxSeed * 0.7 ? -12 : 12)} y={y(mine.points as number) - 10} className="label" textAnchor={mine.seed > maxSeed * 0.7 ? "end" : "start"}>{mine.seed}. {mine.code}</text>}
      </svg>
      {Tip}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. Histogram — where this team's prelim points sit in the field
// ---------------------------------------------------------------------------

export function PointsHistogram({ values, mine, label }: { values: number[]; mine: number | null; label: string }) {
  const { wrap, show, hide, Tip } = useTip();
  if (values.length < 4) return <Empty>Not enough of the field published yet.</Empty>;
  const lo = Math.min(...values), hi = Math.max(...values);
  const bins = 14, step = (hi - lo) / bins || 1;
  const counts = Array.from({ length: bins }, () => 0);
  for (const v of values) counts[Math.min(bins - 1, Math.floor((v - lo) / step))]++;
  const W = 420, H = 170, padL = 24, padR = 12, padT = 22, padB = 30;
  const maxC = Math.max(...counts);
  const bw = (W - padL - padR) / bins;
  const x = (i: number) => padL + i * bw;
  const y = (c: number) => padT + (1 - c / maxC) * (H - padT - padB);
  const myBin = mine === null ? -1 : Math.min(bins - 1, Math.floor((mine - lo) / step));
  const below = mine === null ? null : values.filter((v) => v < mine).length;
  return (
    <div className="chart" ref={wrap}>
      <svg viewBox={`0 0 ${W} ${H}`} className="svg" role="img" aria-label={`${label} distribution across the field`} onPointerLeave={hide}>
        <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} className="axis" />
        {counts.map((c, i) => (
          <rect key={i} x={x(i) + 1} y={y(c)} width={Math.max(1, bw - 2)} height={y(0) - y(c)} rx={3} className={i === myBin ? "vbar s1" : "vbar muted"}
            onPointerMove={(e) => show(e, <><b>{c} team{c === 1 ? "" : "s"}</b><span>{(lo + i * step).toFixed(1)} – {(lo + (i + 1) * step).toFixed(1)} pts</span></>)} />
        ))}
        {mine !== null && (
          <g>
            <line x1={padL + ((mine - lo) / (hi - lo || 1)) * (W - padL - padR)} x2={padL + ((mine - lo) / (hi - lo || 1)) * (W - padL - padR)} y1={padT - 6} y2={y(0)} className="marker" />
            <text x={Math.min(W - padR - 4, padL + ((mine - lo) / (hi - lo || 1)) * (W - padL - padR) + 8)} y={padT + 2} className="label" textAnchor={((mine - lo) / (hi - lo || 1)) > 0.7 ? "end" : "start"}>{mine.toFixed(1)} · ahead of {Math.round(((below as number) / values.length) * 100)}% of the field</text>
          </g>
        )}
        <text x={padL} y={H - 8} className="tick">{lo.toFixed(1)}</text>
        <text x={W - padR} y={H - 8} className="tick" textAnchor="end">{hi.toFixed(1)}</text>
      </svg>
      {Tip}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7. Schedule strip — opponents' seeds on a number line
// ---------------------------------------------------------------------------

export function ScheduleStrip({ rounds, fieldSize }: { rounds: RoundStat[]; fieldSize: number }) {
  const { wrap, show, hide, Tip } = useTip();
  const opps = rounds.filter((r) => r.type === "prelim" && r.opponent?.seed);
  if (!opps.length) return <Empty>Opponent seeds aren&rsquo;t published yet.</Empty>;
  const W = 420, H = 90, padL = 20, padR = 20;
  const N = Math.max(fieldSize, ...opps.map((r) => r.opponent!.seed as number));
  const x = (s: number) => padL + ((s - 1) / Math.max(1, N - 1)) * (W - padL - padR);
  const avg = opps.reduce((a, r) => a + (r.opponent!.seed as number), 0) / opps.length;
  // stack dots that land on the same seed
  const seen = new Map<number, number>();
  return (
    <div className="chart" ref={wrap}>
      <svg viewBox={`0 0 ${W} ${H}`} className="svg" role="img" aria-label={`Average opponent seed ${avg.toFixed(1)}`} onPointerLeave={hide}>
        <line x1={padL} x2={W - padR} y1={52} y2={52} className="axis" />
        <text x={padL} y={76} className="tick">seed 1 · strongest</text>
        <text x={W - padR} y={76} className="tick" textAnchor="end">{N} · weakest</text>
        <line x1={x(avg)} x2={x(avg)} y1={26} y2={60} className="marker" />
        <text x={x(avg)} y={18} className="label" textAnchor={avg > N * 0.75 ? "end" : avg < N * 0.25 ? "start" : "middle"}>avg {avg.toFixed(1)}</text>
        {opps.map((r, i) => {
          const s = r.opponent!.seed as number;
          const k = (seen.get(s) || 0); seen.set(s, k + 1);
          return <circle key={i} cx={x(s)} cy={52 - k * 11} r={5} className={r.result === "W" ? "dot s1 ringed" : "dot hollow s1 ringed"} onPointerMove={(e) => show(e, <><b>{r.result === "W" ? "Beat" : r.result === "L" ? "Lost to" : "vs"} {s}. {r.opponent!.code}</b><span>{r.label}{r.side ? ` · ${r.side}` : ""}{r.opponent!.prelimWins !== null ? ` · they went ${r.opponent!.prelimWins} up in prelims` : ""}</span></>)} />;
        })}
      </svg>
      <div className="legend"><span><i className="key dot s1" />beat them</span><span><i className="key dot hollow" />lost to them</span></div>
      {Tip}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 8. Ballot dots for an elim panel
// ---------------------------------------------------------------------------

export function Ballots({ round }: { round: RoundStat }) {
  const n = Math.max(round.judges.length, round.ballots.for + round.ballots.against);
  if (!n) return <span className="ballots none">no decision</span>;
  const votes = round.judges.length ? round.judges.map((j) => j.vote) : [...Array(round.ballots.for).fill("W"), ...Array(round.ballots.against).fill("L")];
  return (
    <span className="ballots" aria-label={`${round.ballots.for} to ${round.ballots.against}`}>
      {votes.map((v, i) => <i key={i} className={v === "W" ? "b win" : v === "L" ? "b loss" : "b none"} title={round.judges[i]?.name} />)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 9. Pool sentiment — how many brackets in this pool carried them each round
// ---------------------------------------------------------------------------

export function PoolBars({ rows, total }: { rows: { label: string; count: number; truth: "yes" | "no" | null }[]; total: number }) {
  if (!total) return <Empty>Nobody in the pool has made picks yet.</Empty>;
  return (
    <div className="poolbars">
      {rows.map((r) => {
        const pct = Math.round((r.count / total) * 100);
        return (
          <div className="pb" key={r.label}>
            <span className="pl">{r.label}</span>
            <span className="pt"><i className={"pf" + (r.truth === "no" ? " dead" : r.truth === "yes" ? " done" : "")} style={{ width: `${pct}%` }} /></span>
            <span className="pv">{pct}%<small>{r.count} of {total}</small></span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 10. Table view — the WCAG twin for every chart above
// ---------------------------------------------------------------------------

export function RoundsTable({ s }: { s: TeamStats }) {
  return (
    <div className="tablewrap">
      <table className="lb plain rounds">
        <thead><tr><th className="mono">Round</th><th className="mono">Side</th><th className="mono">Opponent</th><th className="mono">Result</th>{s.students.map((st) => <th key={st.id} className="mono">{st.last}</th>)}<th className="mono">Judges</th></tr></thead>
        <tbody>
          {s.rounds.map((r) => (
            <tr key={r.name}>
              <td>{r.label}</td>
              <td className="cr">{r.side || "—"}</td>
              <td>{r.opponent ? `${r.opponent.seed ? r.opponent.seed + ". " : ""}${r.opponent.code}` : r.type === "bye" ? "bye" : "—"}</td>
              <td className="cr">{r.result === "W" ? "W" : r.result === "L" ? "L" : r.result === "B" ? "bye" : "—"}{r.type === "elim" && r.result ? ` ${r.ballots.for}–${r.ballots.against}` : ""}</td>
              {s.students.map((st) => <td key={st.id} className="cr">{fmt1(r.studentPoints[String(st.id)])}</td>)}
              <td className="ch">{r.judges.map((j) => j.name.replace(/ - ONLINE/i, "")).join(", ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="chart empty">{children}</div>;
}


// ---------------------------------------------------------------------------
// 11. Career — a debater's whole Tabroom record, season by season
// ---------------------------------------------------------------------------

const when = (ymd: string) => { const d = new Date(ymd + "T12:00:00"); return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" }); };
const pctOf = (w: number, l: number) => (w + l ? Math.round((w / (w + l)) * 100) : null);
const roundName = (label: string | null) => (label === null ? "" : /^\d+$/.test(label) ? `round ${label}` : label);

/** Depth chart: one mark per tournament, higher = deeper into elims. */
function DepthChart({ tournaments }: { tournaments: CareerTournament[] }) {
  const { wrap, show, hide, Tip } = useTip();
  const chron = tournaments.slice().reverse();
  if (chron.length < 2) return null;
  const W = 640, H = 150, padL = 30, padR = 16, padT = 16, padB = 30;
  const depth = (t: CareerTournament) => (t.won ? t.elimW + 1 : t.elimW + (t.broke ? 0.35 : 0));
  const maxD = Math.max(1, ...chron.map(depth));
  const x = (i: number) => padL + (i / Math.max(1, chron.length - 1)) * (W - padL - padR);
  const y = (d: number) => padT + (1 - d / maxD) * (H - padT - padB);
  const seasonsAt: { label: string; i: number }[] = [];
  chron.forEach((t, i) => { const m = Number(t.start.slice(5, 7)), yy = Number(t.start.slice(0, 4)); const lab = `${m >= 8 ? yy : yy - 1}–${String((m >= 8 ? yy : yy - 1) + 1).slice(2)}`; if (!seasonsAt.length || seasonsAt[seasonsAt.length - 1].label !== lab) seasonsAt.push({ label: lab, i }); });
  return (
    <div className="chart" ref={wrap}>
      <div className="legend"><span>height = elim wins that weekend</span><span><i className="key dot s1" />broke</span><span><i className="key dot hollow" />missed elims</span><span><i className="key dot s3" />won the tournament</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} className="svg" role="img" aria-label="How deep each tournament went" onPointerLeave={hide}>
        <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} className="axis" />
        {[1, 2, 3, 4, 5].filter((d) => d <= maxD).map((d) => <g key={d}><line x1={padL} x2={W - padR} y1={y(d)} y2={y(d)} className="grid" /><text x={padL - 6} y={y(d) + 3} className="tick" textAnchor="end">{d}</text></g>)}
        <text x={padL - 6} y={y(0) + 3} className="tick" textAnchor="end">0</text>
        {seasonsAt.map((sn) => <g key={sn.label}><line x1={x(sn.i) - 6} x2={x(sn.i) - 6} y1={padT} y2={H - padB + 4} className="grid" /><text x={x(sn.i) > W - 90 ? x(sn.i) - 10 : x(sn.i) - 2} y={H - padB + 16} className="tick" textAnchor={x(sn.i) > W - 90 ? "end" : "start"}>{sn.label}</text></g>)}
        {chron.map((t, i) => (
          <g key={t.tournId} onPointerMove={(e) => show(e, <><b>{t.name}</b><span>{when(t.start)} · {t.event}{t.level ? ` · ${t.level}` : ""}</span><span>{t.prelimW}–{t.prelimL} prelims{t.broke ? ` · ${t.elimW}–${t.elimL} in elims · out in ${roundName(t.deepest)}` : " · no break"}{t.won ? " · champion" : ""}</span>{t.partner && <span>with {t.partner}</span>}</>)}>
            <circle cx={x(i)} cy={y(depth(t))} r={12} className="hitarea" />
            <line x1={x(i)} x2={x(i)} y1={y(0)} y2={y(depth(t))} className="grid" />
            <circle cx={x(i)} cy={y(depth(t))} r={5} className={t.won ? "dot s3 ringed" : t.broke ? "dot s1 ringed" : "dot hollow s1 ringed"} />
          </g>
        ))}
      </svg>
      {Tip}
    </div>
  );
}

export function Career({ name, rec, partnerNow, fieldCodes, currentTournId }: { name: string; rec: CareerRecord; partnerNow: string; fieldCodes: Set<string>; currentTournId: number }) {
  const [all, setAll] = useState(false);
  const T = rec.totals;
  const seasons = rec.seasons.slice().reverse();
  const maxSeasonPct = 100;
  // past meetings against teams that are in this bracket
  // earlier tournaments only — this weekend's rounds are already in the dossier above
  const meetings = rec.tournaments.filter((t) => t.tournId !== currentTournId).flatMap((t) => t.rounds.filter((r) => fieldCodes.has(r.opponent.toLowerCase()) && r.opponent.toLowerCase() !== partnerNow.toLowerCase()).map((r) => ({ t, r })));
  const shown = all ? rec.tournaments : rec.tournaments.slice(0, 8);
  return (
    <div className="career">
      <h4>{name} <span>{T.tournaments} tournament{T.tournaments === 1 ? "" : "s"} over {rec.seasons.length} season{rec.seasons.length === 1 ? "" : "s"}</span></h4>
      <div className="career-kpis">
        <span><b>{T.prelimW}–{T.prelimL}</b> prelims{pctOf(T.prelimW, T.prelimL) !== null ? ` · ${pctOf(T.prelimW, T.prelimL)}%` : ""}</span>
        <span><b>{T.elimW}–{T.elimL}</b> elim rounds</span>
        <span><b>{T.breaks}</b> of {T.tournaments} broke</span>
        <span><b>{T.titles}</b> title{T.titles === 1 ? "" : "s"}</span>
        <span><b>{T.ballotsWon}–{T.ballotsLost}</b> ballots</span>
        <span><b>{T.affW}–{T.affL}</b> Aff · <b>{T.negW}–{T.negL}</b> Neg</span>
        <span><b>{T.judges}</b> judges · <b>{T.opponents}</b> opponents</span>
      </div>

      <div className="seasons">
        {seasons.map((sn) => {
          const p = pctOf(sn.prelimW, sn.prelimL) ?? 0;
          return (
            <div className="pb" key={sn.label}>
              <span className="pl">{sn.label}</span>
              <span className="pt" title={`${sn.prelimW}–${sn.prelimL} in prelims`}><i className="pf" style={{ width: `${(p / maxSeasonPct) * 100}%` }} /></span>
              <span className="pv">{sn.prelimW}–{sn.prelimL}<small>{sn.tournaments} tourn · {sn.breaks} break{sn.breaks === 1 ? "" : "s"}{sn.titles ? ` · ${sn.titles} title${sn.titles === 1 ? "" : "s"}` : ""}{sn.avgPoints !== null ? ` · ${sn.avgPoints.toFixed(1)} spk` : ""}</small></span>
            </div>
          );
        })}
      </div>

      <DepthChart tournaments={rec.tournaments} />

      {meetings.length > 0 && (
        <div className="meetings">
          <h5>Past meetings with teams in this bracket</h5>
          <ul>
            {meetings.slice(0, 12).map(({ t, r }, i) => (
              <li key={i}><b className={r.result === "W" ? "w" : "l"}>{r.result === "W" ? "Beat" : r.result === "L" ? "Lost to" : "Met"}</b> {r.opponent}{r.ballotsWon + r.ballotsLost > 1 ? ` ${r.ballotsWon}–${r.ballotsLost}` : ""} <span>· {r.elim ? roundName(r.round) : `Round ${r.round}`}{r.side ? ` on the ${r.side}` : ""} · {t.name}, {when(t.start)}</span></li>
            ))}
          </ul>
        </div>
      )}

      <div className="tablewrap">
        <table className="lb plain rounds">
          <thead><tr><th className="mono">When</th><th className="mono">Tournament</th><th className="mono">Partner</th><th className="mono">Prelims</th><th className="mono">Elims</th><th className="mono">Finish</th><th className="mono">Spk avg</th></tr></thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.tournId}>
                <td className="cr">{when(t.start)}</td>
                <td>{t.name}<small style={{ display: "block", color: "var(--muted)" }}>{t.event}{t.level ? ` · ${t.level}` : ""}</small></td>
                <td className="ch">{t.partner || "—"}</td>
                <td className="cr">{t.prelimW}–{t.prelimL}</td>
                <td className="cr">{t.broke ? `${t.elimW}–${t.elimL}` : "—"}</td>
                <td>{t.won ? <b>Champion</b> : t.broke ? `out in ${roundName(t.deepest)}` : "no break"}</td>
                <td className="cr">{t.avgPoints !== null ? t.avgPoints.toFixed(1) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rec.tournaments.length > 8 && <button className="linkish more" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${rec.tournaments.length} tournaments`}</button>}
      </div>
    </div>
  );
}
