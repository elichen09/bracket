"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CareerRecord } from "@/lib/career";
import { Career, Empty } from "./stats/charts";

/**
 * One entry in a tournament that has not debated yet.
 *
 * The bracket dossier reports a team's weekend from published results. There are
 * none here, so this reports the people instead: what the rating makes of the
 * pairing, and each debater's own record across seasons, which is what the
 * prediction is actually reasoning from.
 */

interface StudentBlock {
  id: number;
  name: string;
  career: CareerRecord | null;
  note: string | null;
  careerRating: { rating: number; rd: number; games: number; wins: number; losses: number } | null;
  seasonRating: { rating: number; rd: number; games: number; wins: number; losses: number } | null;
}

interface Payload {
  tournament: { id: string; name: string; event: string };
  entry: { code: string; name: string; school: string | null };
  rating: { value: number | null; rd: number | null; source: "team" | "debaters" | "none"; matched: string | null };
  season: { rating: number; rd: number; wins: number; losses: number; games: number; tournaments: number; pointsAvg: number | null; history: { tourn: string; start: string | null; rating: number; rd: number; w: number; l: number }[] } | null;
  students: StudentBlock[];
  h2h: Record<string, { w: number; l: number }>;
  fieldCodes: string[];
}

const cache = new Map<string, Payload>();

const SOURCE_TEXT: Record<string, string> = {
  team: "rated on this pairing's own results",
  debaters: "rated from its debaters, since this pairing has no results of its own",
  none: "no results on record, so it debates as an average team",
};

export default function EntryDossier({ tid, code, onClose }: { tid: string; code: string; onClose: () => void }) {
  const key = `${tid}|${code}`;
  const [data, setData] = useState<Payload | null>(cache.get(key) || null);
  const [err, setErr] = useState("");
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    if (!cache.get(key)) {
      setData(null); setErr("");
      fetch(`/api/entry/${encodeURIComponent(tid)}?code=${encodeURIComponent(code)}`)
        .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || "could not load"); return j as Payload; })
        .then((j) => { if (!alive) return; cache.set(key, j); setData(j); })
        .catch((e) => { if (alive) setErr(e.message); });
    }
    return () => { alive = false; };
  }, [key, tid, code]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const fieldCodes = new Set((data?.fieldCodes || []).map((c) => c.replace(/\s+/g, " ").trim().toLowerCase()));
  const meetings = Object.entries(data?.h2h || {}).filter(([opp]) => opp !== code.toLowerCase());

  return createPortal(
    <div className="dossier-veil" onClick={onClose}>
      <aside className="dossier" role="dialog" aria-modal="true" aria-label={`${code} record`} ref={panel} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="d-strip" aria-hidden="true" />
        <button className="d-close" onClick={onClose} aria-label="Close">✕</button>

        <header className="d-head">
          <div className="d-seed"><span className="mono">rating</span><b>{data?.rating.value ?? "—"}</b></div>
          <div className="d-title">
            <h2>{code}</h2>
            <p className="mono">{data?.entry.name || " "}{data?.entry.school ? ` · ${data.entry.school}` : ""}</p>
            <p className="d-status">
              {data ? SOURCE_TEXT[data.rating.source] : "Reading the record…"}
              {data?.rating.matched && data.rating.matched.toLowerCase() !== code.toLowerCase() ? ` · matched to ${data.rating.matched}` : ""}
            </p>
          </div>
        </header>

        {err && <div className="d-err">{err}</div>}
        {!data && !err && <div className="d-loading"><span className="pulse" />Reading their record from Tabroom…</div>}

        {data && (
          <>
            <div className="d-kpis">
              <Kpi k="Rating" v={data.rating.value === null ? "—" : String(data.rating.value)} sub={data.rating.rd === null ? "unrated" : `± ${data.rating.rd}`} />
              <Kpi k="This season" v={data.season ? `${data.season.wins}–${data.season.losses}` : "—"} sub={data.season ? `${data.season.tournaments} tournament${data.season.tournaments === 1 ? "" : "s"}` : "no rounds yet"} />
              <Kpi k="Speaks" v={data.season?.pointsAvg ? data.season.pointsAvg.toFixed(1) : "—"} sub="average, this season" />
              <Kpi k="Met in this field" v={String(meetings.length)} sub={meetings.length ? "teams they have debated" : "no prior meetings"} />
            </div>

            {meetings.length > 0 && (
              <div className="meetings" style={{ marginTop: 18 }}>
                <h5>Already met, among the teams entered here</h5>
                <ul>
                  {meetings.slice(0, 12).map(([opp, rec]) => (
                    <li key={opp}>
                      <b className={rec.w > rec.l ? "w" : rec.l > rec.w ? "l" : ""}>{rec.w}–{rec.l}</b> against {opp}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <section className="d-sec wide" style={{ marginTop: 18 }}>
              <h3>Career <span>each debater&rsquo;s whole record, season by season</span></h3>
              {data.students.map((s) => (
                s.career
                  ? <Career key={s.id} name={s.name} rec={s.career} partnerNow={data.entry.code} fieldCodes={fieldCodes} currentTournId={0} />
                  : <div className="career" key={s.id}>
                      <h4>{s.name}</h4>
                      <Empty>{s.note || "No record came back from Tabroom."}</Empty>
                    </div>
              ))}
              {!data.students.length && <Empty>Tabroom lists no debaters for this entry yet.</Empty>}
            </section>

            <p className="d-foot mono">
              Source: Tabroom · {data.tournament.event} · the partner appears here once the tournament posts rounds
            </p>
          </>
        )}
      </aside>
    </div>,
    document.body,
  );
}

function Kpi({ k, v, sub }: { k: string; v: string; sub: string }) {
  return <div className="kpi"><span className="k mono">{k}</span><b className="v">{v}</b><span className="s">{sub}</span></div>;
}
