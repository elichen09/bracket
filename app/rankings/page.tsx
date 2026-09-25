"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Nav from "@/components/Nav";
import { CIRCUITS, CIRCUIT_IDS, type Circuit } from "@/lib/circuit";

/**
 * The Glicko-2 table. Partnerships lead, because that is how results are
 * reported; the debater view follows a person across partners and seasons.
 *
 * Rating is the estimate, floor is what a competitor can defend — the
 * conservative end of the interval, so an unproven 1800 sits below a proven
 * 1700. Sorting on rating keeps the table readable; the floor column is there
 * to show how much of it is confidence.
 */

interface Row {
  rank: number;
  key: string;
  display: string;
  school: string | null;
  rating: number;
  rd: number;
  floor: number;
  games: number;
  wins: number;
  losses: number;
  tournaments: number;
  pointsAvg: number | null;
  lastPlayed: string | null;
  history: { tourn: string; start: string | null; rating: number; rd: number; w: number; l: number }[];
}

/** How long ago the table was last rebuilt, in words. */
function fmtWhen(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export default function RankingsPage() {
  const [kind, setKind] = useState<"team" | "debater">("team");
  // Public Forum and college policy are separate tables: the two never debate each
  // other, so a rating from one says nothing about the other.
  const [circuit, setCircuit] = useState<Circuit>("pf");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");

  // the way to change the rankings is for whoever holds the admin key, so only they see it
  const [admin, setAdmin] = useState(false);
  useEffect(() => { fetch("/api/admin").then((r) => r.json()).then((j) => setAdmin(!!j.admin)).catch(() => {}); }, []);

  // /rankings?circuit=cx opens on that table — where "See the rankings" after an update lands
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("circuit") as Circuit | null;
    if (c && CIRCUIT_IDS.includes(c)) setCircuit(c);
  }, []);

  useEffect(() => {
    let alive = true;
    setRows(null); setErr("");
    fetch(`/api/rankings?kind=${kind}&circuit=${circuit}`)
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || "could not load"); return j; })
      .then((j) => { if (alive) { setRows(j.rankings as Row[]); setUpdatedAt(j.updatedAt ?? null); } })
      .catch((e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [kind, circuit]);

  const q = query.trim().toLowerCase();
  const shown = (rows || []).filter((r) => !q || r.display.toLowerCase().includes(q) || (r.school || "").toLowerCase().includes(q));

  return (
    <>
      <Nav />
      <main>
        <section className="view enter">
          <div className="thead">
            <p className="crumb mono reveal">Glicko-2 · {CIRCUITS[circuit].label}</p>
            <h1 className="reveal">Rankings</h1>
            <p className="prose reveal">
              Every round counts, prelims included, because prelims are where most of the debating happens.
              One tournament is one rating period, so a team is rated on its whole weekend at once, and a
              team that has not competed lately is rated less confidently rather than assumed to be where it was.
            </p>
            {admin && <p className="reveal"><Link className="mono" href="/rankings/update" style={{ fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--muted)", textDecoration: "none", borderBottom: "1px solid var(--line)" }}>Update from a tournament →</Link></p>}
          </div>

          <div className="controls">
            <div className="seg" role="group">
              {CIRCUIT_IDS.map((id) => (
                <button key={id} aria-pressed={circuit === id} onClick={() => setCircuit(id)}>{CIRCUITS[id].short}</button>
              ))}
            </div>
            <div className="seg" role="group">
              <button aria-pressed={kind === "team"} onClick={() => setKind("team")}>Partnerships</button>
              <button aria-pressed={kind === "debater"} onClick={() => setKind("debater")}>Debaters</button>
            </div>
            <input type="search" placeholder="Find a team or school…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="spacer" />
            <span className="mono" style={{ color: "var(--muted)" }}>
              {rows ? `${shown.length} rated` : ""}{updatedAt ? ` · updated ${fmtWhen(updatedAt)}` : ""}
            </span>
          </div>

          {err && <div className="d-err" style={{ marginTop: 20 }}>{err}</div>}
          {!rows && !err && <div className="lbempty">Loading the table…</div>}

          {rows && !rows.length && <div className="lbempty">Nothing rated yet in {CIRCUITS[circuit].label}. Results are indexed as tournaments finish.</div>}

          {rows && rows.length > 0 && (
            <div className="tablewrap">
              <table className="lb rank">
                <thead>
                  <tr>
                    <th className="rk mono">#</th>
                    <th className="mono">{kind === "team" ? (CIRCUITS[circuit].entrant === "debater" ? "Entry" : "Partnership") : "Debater"}</th>
                    <th className="mono">Rating</th>
                    <th className="mono">Floor</th>
                    <th className="mono">±</th>
                    <th className="mono">Record</th>
                    <th className="mono">Tourns</th>
                    <th className="mono">Speaks</th>
                    <th className="mono">Form</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const first = r.history[0]?.rating;
                    const move = first === undefined ? 0 : r.rating - first;
                    return (
                      <tr key={r.key}>
                        <td className="rk">{r.rank}</td>
                        <td className="who">
                          {kind === "team" ? r.display : `Debater ${r.key}`}
                          {r.school && <small style={{ display: "block", color: "var(--muted)" }}>{kind === "debater" ? `last seen as ${r.display} · ` : ""}{r.school}</small>}
                        </td>
                        <td className="pts num">{r.rating}</td>
                        <td className="cr num">{r.floor}</td>
                        <td className="cr num">{r.rd}</td>
                        <td className="cr">{r.wins}–{r.losses}</td>
                        <td className="cr num">{r.tournaments}</td>
                        <td className="cr num">{r.pointsAvg ?? "—"}</td>
                        <td className={"cr num " + (move > 0 ? "up" : move < 0 ? "down" : "")}>
                          {r.history.length < 2 ? "new" : `${move > 0 ? "+" : ""}${move}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="hint" style={{ marginTop: 20 }}>
            <b>Rating</b> is the estimate and <b>floor</b> is the conservative end of it, so a team with few
            rounds sits lower than its raw rating suggests until it proves the number. <b>±</b> is how unsure
            the system still is. <b>Form</b> compares the current rating with the first one on record.
          </p>
        </section>
      </main>
    </>
  );
}
