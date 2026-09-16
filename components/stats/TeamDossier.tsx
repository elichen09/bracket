"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TeamStats } from "@/lib/tabroomApi";
import Strata from "@/components/Strata";
import { FormLine, PointsLines, SideBars, Ring, FieldScatter, PointsHistogram, ScheduleStrip, Ballots, PoolBars, RoundsTable, Career, Empty } from "./charts";

export interface PoolContext {
  total: number;
  rows: { label: string; count: number; truth: "yes" | "no" | null }[];  // per scored round: brackets that advance this team
  champCount: number;
  status: string;   // "still alive", "champion", "out in Octafinals", …
}

interface Props {
  tid: string;
  team: { seed: number; name: string };
  pool: PoolContext;
  onClose: () => void;
}

const memo = new Map<string, TeamStats>();

export default function TeamDossier({ tid, team, pool, onClose }: Props) {
  const key = `${tid}|${team.name}`;
  const [stats, setStats] = useState<TeamStats | null>(memo.get(key) || null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"viz" | "table">("viz");
  const [pulling, setPulling] = useState(false);
  const [pullMsg, setPullMsg] = useState("");
  const panel = useRef<HTMLDivElement>(null);

  const load = (fresh: boolean) =>
    fetch(`/api/stats/${encodeURIComponent(tid)}?code=${encodeURIComponent(team.name)}${fresh ? "&fresh=1" : ""}`, fresh ? { cache: "no-store" } : undefined)
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || "could not load"); return j as TeamStats; });

  useEffect(() => {
    let alive = true;
    if (!memo.get(key)) {
      setStats(null); setErr("");
      load(false)
        .then((s) => { if (!alive) return; memo.set(key, s); setStats(s); })
        .catch((e) => { if (alive) setErr(e.message); });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tid, team.name]);

  // Re-pull everything from Tabroom, ignoring every cache (browser, server, Supabase).
  async function repull() {
    if (pulling) return;
    setPulling(true); setPullMsg("");
    try {
      const fresh = await load(true);
      memo.set(key, fresh); setStats(fresh); setErr("");
      setPullMsg(`Re-pulled from Tabroom at ${new Date(fresh.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${fresh.careerNote ? ` — careers: ${fresh.careerNote}` : ""}`);
    } catch (e: any) { setPullMsg(`Re-pull failed: ${e.message}`); }
    finally { setPulling(false); }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const s = stats;
  const oppIds = new Set<number>((s?.rounds || []).filter((r) => r.type === "prelim" && r.opponent).map((r) => r.opponent!.id));
  const elimRounds = (s?.rounds || []).filter((r) => r.type === "elim");
  const fieldCodes = new Set<string>((s?.field.rows || []).map((r) => r.code.toLowerCase()));
  const record = s ? `${s.prelims.wins}–${s.prelims.losses}` : "";

  // Portal to <body>: the page section animates with a transform, which would
  // otherwise become the reference for this fixed overlay and push it off-screen.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="dossier-veil" onClick={onClose}>
      <aside className="dossier" role="dialog" aria-modal="true" aria-label={`${team.name} statistics`} ref={panel} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="d-strip" aria-hidden="true"><Strata palette="shore" still /></div>
        <button className="d-close" onClick={onClose} aria-label="Close">✕</button>

        <header className="d-head">
          <div className="d-seed"><span className="mono">seed</span><b>{team.seed || "—"}</b></div>
          <div className="d-title">
            <h2>{team.name}</h2>
            <p className="mono">{s?.name || " "}{s?.school ? ` · ${s.school}` : ""}</p>
            <p className="d-status">{pool.status}{s?.finalPlace ? ` · Tabroom: ${s.finalPlace.place}` : ""}</p>
          </div>
        </header>

        {err && <div className="d-err">{err}</div>}
        {!s && !err && <div className="d-loading"><span className="pulse" />Pulling the record from Tabroom…</div>}

        {s && (
          <>
            <div className="d-kpis">
              <Kpi k="Prelims" v={record} sub={s.prelims.byes ? `${s.prelims.byes} bye${s.prelims.byes > 1 ? "s" : ""}` : `${s.prelims.wins + s.prelims.losses} rounds`} />
              <Kpi k="Seed" v={s.seed ? `${s.seed.rank}` : "—"} sub={s.seed ? `of ${s.seed.of}` : "not published"} />
              <Kpi k="Prelim points" v={s.seed?.points !== null && s.seed?.points !== undefined ? s.seed.points.toFixed(1) : (s.prelims.pointsAvg !== null ? s.prelims.pointsAvg.toFixed(1) : "—")} sub={s.seed?.points !== null && s.seed?.points !== undefined && s.field.pointsAvg !== null ? `${s.seed.points - s.field.pointsAvg >= 0 ? "+" : ""}${(s.seed.points - s.field.pointsAvg).toFixed(1)} vs field average` : "per round"} />
              <Kpi k="Elims" v={elimRounds.length ? `${s.elims.wins}–${s.elims.losses}` : "—"} sub={elimRounds.length ? `${s.elims.ballotsFor}–${s.elims.ballotsAgainst} ballots` : "not yet"} />
              <Kpi k="Opp. seed avg" v={s.seed?.oppSeedAvg !== null && s.seed?.oppSeedAvg !== undefined ? s.seed.oppSeedAvg.toFixed(1) : "—"} sub={s.seed?.oppSeedAvg ? (s.seed.oppSeedAvg < s.field.size / 2 ? "tough draw" : "softer draw") : "prelims"} />
              <Kpi k="Pool" v={pool.total ? `${Math.round((pool.champCount / pool.total) * 100)}%` : "—"} sub={pool.total ? `${pool.champCount} of ${pool.total} picked them to win it all` : "no brackets yet"} />
            </div>

            <div className="d-tabs seg" role="group">
              <button aria-pressed={tab === "viz"} onClick={() => setTab("viz")}>Visualised</button>
              <button aria-pressed={tab === "table"} onClick={() => setTab("table")}>Every round</button>
            </div>

            {tab === "table" ? <RoundsTable s={s} /> : (
              <div className="d-grid">
                <Section title="Form" sub="running win–loss through prelims" wide>
                  <FormLine rounds={s.rounds} />
                </Section>

                <Section title="Speakers" sub="prelim points per round, one line each" wide>
                  <PointsLines rounds={s.rounds} speakers={s.speakers} />
                </Section>

                <Section title="Standing" sub="speaker rank in the field">
                  <div className="rings">
                    {s.speakers.map((sp, i) => (
                      <div className="ringcard" key={sp.studentId}>
                        <Ring pct={sp.percentile} tone={(i % 2 + 1) as 1 | 2} big={sp.rank ? `#${sp.rank}` : "—"} small={sp.rank ? `of ${sp.of}` : "unranked"} />
                        <b>{sp.name}</b>
                        <span className="mono">{sp.points !== null ? `${sp.points.toFixed(1)} pts` : ""}{sp.pointsDropped !== null ? ` · ${sp.pointsDropped.toFixed(1)} drop-hi-lo` : ""}</span>
                      </div>
                    ))}
                    {!s.speakers.length && <Empty>No speaker awards published.</Empty>}
                  </div>
                </Section>

                <Section title="Sides" sub="record on the Aff and on the Neg">
                  <SideBars aff={s.prelims.aff} neg={s.prelims.neg} />
                </Section>

                <Section title="Schedule" sub="who they drew in prelims, by seed">
                  <ScheduleStrip rounds={s.rounds} fieldSize={s.field.size} />
                </Section>

                <Section title="Elim run" sub="panel ballots each round">
                  {elimRounds.length ? (
                    <ol className="ladder">
                      {elimRounds.map((r) => (
                        <li key={r.name} className={r.result === "W" ? "won" : r.result === "L" ? "lost" : ""}>
                          <span className="rl">{r.label}</span>
                          <span className="ro">{r.opponent ? <>{r.opponent.seed ? <em>{r.opponent.seed}</em> : null} {r.opponent.code}</> : "—"}{r.side ? <small className={"sidechip " + r.side.toLowerCase()}>{r.side}</small> : null}</span>
                          <Ballots round={r} />
                          <span className="rr">{r.result === "W" ? "advanced" : r.result === "L" ? "out" : "pending"}</span>
                          {r.judges.length > 0 && <span className="rj mono">{r.judges.map((j) => j.name.replace(/ - ONLINE/i, "")).join(" · ")}</span>}
                        </li>
                      ))}
                    </ol>
                  ) : <Empty>No elimination rounds on record yet.</Empty>}
                </Section>

                <Section title="The field" sub="every team's prelim points against its seed" wide>
                  <FieldScatter field={s.field.rows} me={s.entryId} opponents={oppIds} />
                </Section>

                <Section title="Points curve" sub="where their prelim total lands in the field">
                  <PointsHistogram values={s.field.rows.map((r) => r.points).filter((x): x is number => x !== null)} mine={s.seed?.points ?? null} label="Team points" />
                </Section>

                <Section title="Pool" sub="brackets in this pool that carry them through each round">
                  <PoolBars rows={pool.rows} total={pool.total} />
                </Section>

                <Section title="Career" sub="each debater's whole record, season by season" wide>
                  {s.students.map((st) => {
                    const rec = (s.career || {})[String(st.id)];
                    const nm = `${st.first} ${st.last}`.trim();
                    if (rec && !rec.empty && rec.tournaments.length) {
                      return <Career key={st.id} name={nm} rec={rec} partnerNow={s.code} fieldCodes={fieldCodes} currentTournId={s.tournId} />;
                    }
                    return (
                      <div className="career" key={st.id}>
                        <h4>{nm}</h4>
                        <Empty>{rec
                          ? "Tabroom did not return this debater's record just now — its results page is unreliable. Re-pull from Tabroom, below, usually fixes it."
                          : (s.careerNote || "No record came back from Tabroom.")}</Empty>
                      </div>
                    );
                  })}
                </Section>

                <Section title="Judges" sub="who has seen them, and how it went" wide>
                  {s.judges.length ? (
                    <div className="judges">
                      {s.judges.map((j) => (
                        <a key={j.name} className="judge" href={j.paradigm ? `https://www.tabroom.com/index/paradigm.mhtml?judge_person_id=${j.paradigm}` : undefined} target="_blank" rel="noopener noreferrer">
                          <b>{j.name.replace(/ - ONLINE/i, "")}</b>
                          <span className="jrec">{Array.from({ length: j.wins }).map((_, i) => <i key={"w" + i} className="b win" />)}{Array.from({ length: j.losses }).map((_, i) => <i key={"l" + i} className="b loss" />)}</span>
                          <span className="mono">{j.rounds} ballot{j.rounds === 1 ? "" : "s"}</span>
                        </a>
                      ))}
                    </div>
                  ) : <Empty>No judges published.</Empty>}
                </Section>
              </div>
            )}
            <div className="d-foot">
              <span className="mono">Source: Tabroom · {s.event?.name} · fetched {new Date(s.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              <button className="repull" onClick={repull} disabled={pulling} title="Ignore every cache and read Tabroom again — stats, field and both debaters' careers">{pulling ? "Pulling from Tabroom…" : "↻ Re-pull from Tabroom"}</button>
              {pullMsg && <span className="pullmsg">{pullMsg}</span>}
            </div>
          </>
        )}
      </aside>
    </div>,
    document.body
  );
}

function Kpi({ k, v, sub }: { k: string; v: string; sub: string }) {
  return <div className="kpi"><span className="k mono">{k}</span><b className="v">{v}</b><span className="s">{sub}</span></div>;
}

function Section({ title, sub, wide, children }: { title: string; sub: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <section className={"d-sec" + (wide ? " wide" : "")}>
      <h3>{title} <span>{sub}</span></h3>
      {children}
    </section>
  );
}
