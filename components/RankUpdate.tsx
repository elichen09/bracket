"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CIRCUITS, CIRCUIT_IDS, type Circuit } from "@/lib/circuit";
import "./rankupdate.css";

/**
 * A tournament into a ranking, from its Tabroom link.
 *
 * Paste the link and the page looks the tournament up straight away — its
 * name, its dates, which of its divisions count for the ranking chosen, and
 * whether its rounds are in already — and picks the ranking it looks like.
 * One button then reads the rounds and rebuilds that ranking, and the page
 * shows where every team that debated there now stands.
 */

interface Seen {
  tourn: { id: number; name: string; start: string | null };
  events: { abbr: string; name: string }[];
  say: boolean | null;
  circuits: Circuit[];
  already: number;
}
interface Done {
  tourn: { id: number; name: string };
  circuit: Circuit;
  rounds: number; entries: number; rated: number; games: number;
  remembered: boolean | null;
  moved: { team: string; rank: number; was: number | null; rating: number; change: number | null }[];
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" }) : "");

export default function RankUpdate() {
  const [link, setLink] = useState("");
  const [circuit, setCircuit] = useState<Circuit>("pf");
  const chose = useRef(false);                  // the ranking was picked by hand
  const [seen, setSeen] = useState<Seen | null>(null);
  const [looking, setLooking] = useState(false);
  const [err, setErr] = useState("");
  const [running, setRunning] = useState(false);
  const [secs, setSecs] = useState(0);
  const [done, setDone] = useState<Done | null>(null);
  const asked = useRef(0);

  async function call(op: "preview" | "run", c: Circuit) {
    const r = await fetch("/api/rankings/update", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, ref: link, circuit: c }),
    });
    const text = await r.text();
    let j: any;
    try { j = JSON.parse(text); } catch { throw new Error("the server had a problem (" + r.status + ")"); }
    if (!r.ok) throw new Error(j.error || "the server said " + r.status);
    return j;
  }

  // look it up as soon as there is something to look up
  useEffect(() => {
    setDone(null);
    if (!/tourn_id=\d+|^\s*\d{3,7}\s*$/.test(link)) { setSeen(null); setErr(link.trim() ? "Paste a Tabroom link with a tourn_id in it, or the tournament’s id." : ""); return; }
    const n = ++asked.current;
    setLooking(true); setErr("");
    const t = setTimeout(async () => {
      try {
        const j: Seen = await call("preview", circuit);
        if (n !== asked.current) return;
        // the ranking it looks like, unless one was picked
        if (!chose.current && j.circuits.length && !j.circuits.includes(circuit)) { setCircuit(j.circuits[0]); return; }
        setSeen(j);
      } catch (e: any) { if (n === asked.current) { setSeen(null); setErr(e.message); } }
      finally { if (n === asked.current) setLooking(false); }
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, circuit]);

  useEffect(() => {
    if (!running) return;
    setSecs(0);
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  async function run() {
    if (!seen || !seen.events.length || running) return;
    setRunning(true); setErr(""); setDone(null);
    try { setDone(await call("run", circuit)); }
    catch (e: any) { setErr(e.message); }
    finally { setRunning(false); }
  }

  const label = CIRCUITS[circuit].label;

  return (
    <div className="ru">
      <label className="ru-link">
        <span className="mono">Tabroom link or id</span>
        <input value={link} onChange={(e) => setLink(e.target.value)} autoFocus spellCheck={false} autoComplete="off"
          placeholder="https://www.tabroom.com/index/tourn/index.mhtml?tourn_id=…" />
      </label>

      <div className="ru-circ" role="group" aria-label="Which ranking">
        <span className="mono">Counts towards</span>
        <div>
          {CIRCUIT_IDS.map((c) => (
            <button key={c} type="button" aria-pressed={c === circuit} className={c === circuit ? "on" : ""}
              onClick={() => { chose.current = true; setCircuit(c); }}>
              {CIRCUITS[c].label}
              {seen && seen.circuits.includes(c) && c !== circuit && <i title="This tournament has a division for it">•</i>}
            </button>
          ))}
        </div>
      </div>

      {(looking || seen || err) && (
        <div className={"ru-card" + (looking ? " looking" : "")} aria-live="polite">
          {looking && !seen && <div className="ru-wait"><i /><i /><i /></div>}
          {seen && (
            <>
              <p className="mono ru-kicker">{when(seen.tourn.start)} · Tabroom {seen.tourn.id}</p>
              <h2 className="ru-name">{seen.tourn.name}</h2>
              {seen.events.length ? (
                <p className="ru-events">
                  <span className="mono">Counts for {label}</span>
                  {seen.events.map((e) => <b key={e.abbr} className="mono">{e.name || e.abbr}</b>)}
                </p>
              ) : (
                <p className="ru-none">No {label} division here with published results{seen.circuits.length ? ` — it has ${seen.circuits.map((c) => CIRCUITS[c].label).join(", ")}` : ""}.</p>
              )}
              {seen.say === true && <p className="ru-note">Not on the college list — it will be counted, and remembered, as a college tournament.</p>}
              {seen.say === false && <p className="ru-note">On the college list — it will be counted, and remembered, as high school instead.</p>}
              {seen.already > 0 && <p className="ru-note quiet">{seen.already.toLocaleString()} of its rounds are in already. Reading it again adds only what is new.</p>}
            </>
          )}
          {err && <p className="ru-err">{err}</p>}
        </div>
      )}

      <div className="ru-go">
        <button type="button" className="primary" onClick={run} disabled={!seen || !seen.events.length || running || looking}>
          {running ? `Updating… ${secs}s` : `Update the ${label} rankings`}
        </button>
        {running && <span className="ru-steps mono"><i className="on">Reading rounds from Tabroom</i><i>Rebuilding {label}</i></span>}
      </div>
      {running && <div className="ru-bar" aria-hidden="true"><i /></div>}

      {done && (
        <div className="ru-done">
          <div className="ru-nums">
            <div><b>{done.rounds.toLocaleString()}</b><span className="mono">rounds read</span></div>
            <div><b>{done.moved.length.toLocaleString()}</b><span className="mono">teams from it</span></div>
            <div><b>{done.rated.toLocaleString()}</b><span className="mono">teams rated</span></div>
          </div>
          {done.remembered !== null && <p className="ru-note quiet">Remembered: {done.tourn.name} is {done.remembered ? "a college" : "not a college"} tournament.</p>}
          {done.moved.length > 0 && (
            <table className="ru-table">
              <thead><tr><th>Now</th><th>Team</th><th>Was</th><th>Rating</th><th /></tr></thead>
              <tbody>
                {done.moved.slice(0, 60).map((m) => {
                  const up = m.was === null ? null : m.was - m.rank;
                  return (
                    <tr key={m.team}>
                      <td className="mono">#{m.rank}</td>
                      <td>{m.team}</td>
                      <td className="mono dim">{m.was === null ? "new" : "#" + m.was}</td>
                      <td className="mono">{m.rating}</td>
                      <td className={"mono " + (up === null ? "dim" : up > 0 ? "up" : up < 0 ? "down" : "dim")}>
                        {up === null ? "—" : up > 0 ? "▲ " + up : up < 0 ? "▼ " + -up : "="}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <Link className="ru-see mono" href={`/rankings?circuit=${done.circuit}`}>See the {CIRCUITS[done.circuit].label} rankings →</Link>
        </div>
      )}
    </div>
  );
}
