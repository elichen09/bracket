"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import Nav from "@/components/Nav";
import {
  useTournament, useEntries, getMine, setMine, getName, setName,
  apiCreateEntry, apiUpdateEntry,
} from "@/lib/useBreak";
import {
  model, build, progress, eliminated, score, prune, bonusFor, entriesClosed,
  type Model, type Match,
} from "@/lib/bracket";
import type { Tournament, Entry, Picks } from "@/lib/types";
import { fmtDate } from "@/lib/format";

export default function TournamentPage({ params }: { params: { id: string } }) {
  const t = useTournament(params.id);
  return (
    <>
      <Nav />
      <main>
        <section className="view enter">
          {t === undefined ? <div className="thead"><p className="crumb mono">Loading…</p></div>
            : t === null ? (
              <div className="thead">
                <p className="crumb mono"><Link href="/">← Tournaments</Link></p>
                <h1>Not found</h1>
                <p className="prose">No tournament with that id.</p>
              </div>
            ) : <Loaded t={t} />}
        </section>
      </main>
    </>
  );
}

function Loaded({ t }: { t: Tournament }) {
  const { entries, reload } = useEntries(t.id);
  const M = useMemo(() => model(t), [t]);

  const [view, setView] = useState<string>("mine");    // "mine" | "real" | bracket id
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [mine, setMineState] = useState<{ id: string; token: string } | null>(null);
  const [name, setNameState] = useState("");
  const [myPicks, setMyPicks] = useState<Picks>({});
  const [justKey, setJustKey] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWrite = useRef(0);

  // load identity once
  useEffect(() => {
    setMineState(getMine(t.id));
    setNameState(getName());
  }, [t.id]);

  // adopt my picks from the pool (locks, other devices) unless I just wrote
  const myEntry: Entry | undefined = mine ? entries[mine.id] : undefined;
  useEffect(() => {
    if (myEntry && Date.now() - lastWrite.current > 2500) setMyPicks(myEntry.picks || {});
    if (mine && Object.keys(entries).length && !entries[mine.id]) { setMine(t.id, null); setMineState(null); }
  }, [myEntry, entries, mine, t.id]);

  const myLocked = !!myEntry?.locked;
  const editable = view === "mine" && !!mine && !myLocked;

  const real = useMemo(() => build(M, "real"), [M]);
  const dead = useMemo(() => eliminated(real), [real]);
  const P = useMemo(() => progress(M), [M]);

  const viewedPicks: Picks = view === "mine" ? myPicks : (entries[view]?.picks || {});
  const viewedName = view === "mine" ? (name || "You") : (entries[view]?.name || "");
  const shown = useMemo(() => build(M, "picks", viewedPicks), [M, viewedPicks]);
  const s = useMemo(() => score(M, shown, real, dead), [M, shown, real, dead]);
  const tree = view === "real" ? real : shown;

  function persist(nextPicks: Picks, lock?: boolean, nextName?: string) {
    if (!mine) return;
    lastWrite.current = Date.now();
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const doSave = () => apiUpdateEntry(t.id, mine.id, mine.token, {
      picks: nextPicks, ...(lock ? { lock: true } : {}), ...(nextName ? { name: nextName } : {}),
    }).then(reload).catch(() => {});
    if (lock || nextName) doSave(); else saveTimer.current = setTimeout(doSave, 350);
  }

  function clickSlot(r: number, m: number, side: 0 | 1) {
    if (!editable) return;
    const mt = build(M, "picks", myPicks)[r][m];
    const team = side === 0 ? mt.a : mt.b;
    if (!team || !mt.a || !mt.b || mt.bye || r < M.locked) return;
    const key = `${r}:${m}`;
    const next = { ...myPicks };
    if (next[key] === team.seed) delete next[key]; else next[key] = team.seed;
    const pruned = prune(M, next);
    setMyPicks(pruned);
    setJustKey(`${r}:${m}:${side}`);
    persist(pruned);
  }

  async function start(nm: string) {
    const clean = nm.trim().slice(0, 24);
    if (!clean) return;
    setNameState(clean); setName(clean);
    try {
      const created = await apiCreateEntry(t.id, clean, myPicks);
      setMine(t.id, created); setMineState(created);
      setView("mine");
      reload();
    } catch (e: any) { alert(e.message); }
  }

  return (
    <>
      <div className="thead">
        <p className="crumb mono reveal"><Link href="/">← Tournaments</Link></p>
        <h1 className="reveal">{t.name}</h1>
        <Sub t={t} M={M} P={P} />
      </div>

      <Stats t={t} M={M} P={P} s={s} view={view} viewedName={viewedName} shown={shown} dead={dead} editable={editable} />
      <Ledger M={M} s={s} />

      <div className="split">
        <div>
          <h2 className="sec">Pool <span className="mono">{poolNote(entries, mine)}</span></h2>
          <Me
            M={M} mine={mine} name={name} myLocked={myLocked} myEntry={myEntry} myPicks={myPicks}
            onStart={start}
            onRename={(nm: string) => { setNameState(nm); setName(nm); persist(myPicks, false, nm); }}
            onLock={() => persist(myPicks, true)}
            onClear={() => { setMyPicks({}); persist({}); }}
            entries={entries}
            onOpen={(id: string) => setView(id === mine?.id ? "mine" : id)}
          />
          <Leaderboard
            M={M} real={real} dead={dead} entries={entries} mine={mine}
            myName={name} myPicks={myPicks} myLocked={myLocked} view={view}
            onView={(id: string) => setView(id)}
          />
        </div>
        <Results M={M} real={real} />
      </div>

      <div className="controls">
        <div className="seg" role="group">
          <button aria-pressed={view === "mine"} onClick={() => setView("mine")}>My bracket</button>
          <button aria-pressed={view === "real"} onClick={() => setView("real")}>Actual results</button>
        </div>
        <input type="search" placeholder="Highlight a school or code…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select onChange={(e) => { const c = boardRef.current?.querySelector(`#round-${e.target.value}`) as HTMLElement | null; if (c) boardRef.current!.scrollTo({ left: c.offsetLeft - 20, behavior: "smooth" }); }}>
          <option value="">Jump to round…</option>
          {M.names.map((n, i) => <option key={i} value={i}>{n} ({(M.first >> i) * 2})</option>)}
        </select>
        <div className="spacer" />
        <div className="zoomset">
          <button onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}>−</button>
          <button onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button onClick={() => setZoom((z) => Math.min(1.3, Math.round((z + 0.1) * 10) / 10))}>+</button>
        </div>
        {mine && !myLocked && view === "mine" && <button onClick={() => { setMyPicks({}); persist({}); }}>Clear picks</button>}
      </div>

      <Hint M={M} view={view} editable={editable} mine={mine} myLocked={myLocked} viewedName={viewedName} P={P} t={t} />

      <Board
        M={M} tree={tree} real={real} dead={dead} view={view} editable={editable}
        query={query.trim().toLowerCase()} justKey={justKey} zoom={zoom}
        boardRef={boardRef} onClick={clickSlot}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
function poolNote(entries: Record<string, Entry>, mine: { id: string } | null) {
  let n = Object.keys(entries).length;
  if (mine && !entries[mine.id]) n += 1;
  return n === 1 ? "1 bracket" : `${n} brackets`;
}

function Sub({ t, M, P }: { t: Tournament; M: Model; P: ReturnType<typeof progress> }) {
  const bits: React.ReactNode[] = [];
  if (t.event) bits.push(<span key="e">{t.event}</span>);
  bits.push(<span key="n">{M.size ? `${M.teamCount} teams${M.byes ? ` · ${M.byes} byes` : ""}` : "bracket pending"}</span>);
  if (M.size) bits.push(P.complete
    ? <span key="s">Final · won by {P.champ!.name}</span>
    : P.done === 0 ? <span key="s">Open for picks</span>
    : <span key="s" className="live">Live · {M.names[P.liveRound!]}</span>);
  if (t.tabroom_tourn_id) bits.push(<a key="tab" href={`https://www.tabroom.com/index/tourn/results/bracket.mhtml?tourn_id=${t.tabroom_tourn_id}&result_id=${t.tabroom_result_id}`} target="_blank" rel="noopener noreferrer">Tabroom ↗</a>);
  if (t.updated_at) bits.push(<span key="u">updated {fmtDate(t.updated_at)}</span>);
  return <div className="sub mono reveal">{bits}</div>;
}

function Stats({ t, M, P, s, view, viewedName, shown, dead, editable }: any) {
  const who = view === "mine" ? "Your" : `${viewedName}’s`;
  const champPick = M.rounds ? shown[M.rounds - 1][0].winner : null;
  const champSub = view === "real" ? (P.champ ? "tournament complete" : "not decided yet")
    : !champPick ? (editable ? "pick one to finish the bracket" : "bracket unfinished")
    : P.champ ? (P.champ.seed === champPick.seed ? "called it" : `won by ${P.champ.name}`)
    : dead[champPick.seed] ? "already eliminated" : "still alive";
  const standing = M.teamCount - Object.keys(dead).length;
  return (
    <div className="stats reveal">
      <div className="stat">
        <div className="k mono">{view === "real" ? "Reported" : `${who} score`}</div>
        <div className="v num">{view === "real" ? <>{P.done}<span style={{ color: "var(--muted)" }}>/{P.total}</span></> : <>{s.pts} <span style={{ fontSize: 16, color: "var(--muted)", letterSpacing: 0 }}>pts</span></>}</div>
        {view === "real" ? <div className="sub">matches decided</div> : <><div className="sub">{s.live} still in play</div><div className="bar"><i style={{ width: `${Math.min(100, s.pts / (M.baseTotal || 1) * 100)}%` }} /></div></>}
      </div>
      <div className="stat">
        <div className="k mono">{view === "real" ? "Still standing" : "Picks correct"}</div>
        <div className="v num">{view === "real" ? <>{standing}<span style={{ color: "var(--muted)" }}>/{M.teamCount}</span></> : <>{s.correct}<span style={{ color: "var(--muted)" }}>/{s.judged}</span></>}</div>
        <div className="sub">{view === "real" ? "teams not yet eliminated" : `${s.made} of ${M.totalPicks} picks made`}</div>
      </div>
      <div className="stat">
        <div className="k mono">Round in play</div>
        <div className="v small">{P.complete ? "Tournament over" : (M.names[P.liveRound!] || "—")}</div>
        <div className="sub">{P.complete ? "final results in" : (M.results[String(P.liveRound)] && Object.keys(M.results[String(P.liveRound)]).length) ? "partly reported" : (P.liveRound ?? 0) > 0 ? `${M.names[(P.liveRound as number) - 1]} results final` : "no results posted yet"}</div>
      </div>
      <div className="stat">
        <div className="k mono">{view === "real" ? "Champion" : `${who} champion`}</div>
        <div className="v small gold">{view === "real" ? (P.champ ? `${P.champ.seed}. ${P.champ.name}` : "—") : (champPick ? `${champPick.seed}. ${champPick.name}` : "—")}</div>
        <div className="sub">{champSub}</div>
      </div>
    </div>
  );
}

function Ledger({ M, s }: { M: Model; s: ReturnType<typeof score> }) {
  return (
    <div className="ledger reveal">
      {M.names.map((nm, i) => {
        if (i < M.locked) return <span key={i}>{nm} <b style={{ color: "var(--muted)" }}>not scored</b></span>;
        const row = s.rounds[i];
        return <span key={i} className={row.judged ? "scored" : ""}>{nm} <b>{row.judged ? `${row.correct}/${row.judged} · ${row.pts} pts` : `${M.pts[i]} pt${M.pts[i] > 1 ? "s" : ""} each`}</b></span>;
      })}
    </div>
  );
}

function Me({ M, mine, name, myLocked, myEntry, myPicks, onStart, onRename, onLock, onClear, entries, onOpen }: any) {
  const [draft, setDraft] = useState(name);
  const [renaming, setRenaming] = useState(false);
  const [armed, setArmed] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [openId, setOpenId] = useState("");
  useEffect(() => setDraft(name), [name]);

  if (!M.size) return <div className="me"><span className="mono" style={{ color: "var(--muted)" }}>Picks open once the bracket is in.</span></div>;

  if (!mine && entriesClosed(M)) {
    return <div className="me"><span className="mono" style={{ color: "var(--muted)" }}>Brackets are closed — first-round results are in.</span></div>;
  }

  if (!mine) {
    return (
      <div className="me">
        <input value={draft} maxLength={24} placeholder="Your name" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onStart(draft); }} />
        <button className="primary" onClick={() => onStart(draft)}>Start my bracket</button>
        <span className="grow" /><span className="mono" style={{ color: "var(--muted)" }}>joins the pool</span>
      </div>
    );
  }
  const left = M.totalPicks - Object.keys(myPicks).length;
  return (
    <>
      <div className="me">
        {renaming ? (
          <>
            <input value={draft} maxLength={24} autoFocus onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { onRename(draft.trim()); setRenaming(false); } }} />
            <button className="primary" onClick={() => { if (draft.trim()) { onRename(draft.trim()); setRenaming(false); } }}>Save name</button>
          </>
        ) : (
          <>
            <span className="who">{name || "You"}<small>{mine.id}</small></span>
            <span className="grow" />
            {myLocked
              ? <span className="locked">Locked {fmtDate(myEntry?.locked_at)}</span>
              : <>
                  <button onClick={() => { setDraft(name); setRenaming(true); }}>Rename</button>
                  <button className={"lock" + (armed ? " armed" : "")} onClick={() => { if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 5000); } else { setArmed(false); onLock(); } }}>
                    {armed ? (left ? `Lock with ${left} blank — no undo?` : "Lock it in — no undo?") : "Lock in my bracket"}
                  </button>
                </>}
            <button onClick={() => setShowShare((v) => !v)}>Share</button>
          </>
        )}
      </div>
      {showShare && (
        <div className="share">
          Send people this page. Your bracket is <code>{mine.id}</code> — anyone can open it from the leaderboard, or by ID:
          <form onSubmit={(e) => { e.preventDefault(); const id = openId.trim().toUpperCase(); if (entries[id]) onOpen(id); else alert(`No bracket ${id} in this pool`); }}>
            <input value={openId} maxLength={5} placeholder="ID" onChange={(e) => setOpenId(e.target.value)} />
            <button type="submit">Open</button>
          </form>
        </div>
      )}
    </>
  );
}

function Leaderboard({ M, real, dead, entries, mine, myName, myPicks, myLocked, view, onView }: any) {
  const all: Record<string, { name: string; picks: Picks; locked: boolean }> = {};
  Object.values(entries).forEach((e: any) => { all[e.id] = { name: e.name, picks: e.picks, locked: e.locked }; });
  if (mine && !all[mine.id]) all[mine.id] = { name: myName || "You", picks: myPicks, locked: myLocked };
  const ids = Object.keys(all);
  if (!ids.length) return <div className="lbempty">{!M.size ? "Waiting for the bracket." : entriesClosed(M) ? "No brackets were entered before results came in." : "No brackets yet — start yours above."}</div>;
  const rows = ids.map((id) => {
    const e = all[id];
    const tree = build(M, "picks", e.picks || {});
    const sc = score(M, tree, real, dead);
    const ch = M.rounds ? tree[M.rounds - 1][0].winner : null;
    return { id, name: e.name || "Unnamed", s: sc, champ: ch, dead: ch ? !!dead[ch.seed] : false, locked: !!e.locked };
  }).sort((a, b) => b.s.pts - a.s.pts || b.s.correct - a.s.correct || a.name.localeCompare(b.name));
  return (
    <table className="lb">
      <thead><tr><th className="rk mono">#</th><th className="mono">Bracket</th><th className="mono">Pts</th><th className="mono">Correct</th><th className="mono">Champion</th></tr></thead>
      <tbody>
        {rows.map((row, i) => {
          const viewing = view === row.id || (view === "mine" && row.id === mine?.id);
          const champ = row.champ ? `${row.champ.seed}. ${row.champ.name}` : "—";
          return (
            <tr key={row.id} className={viewing ? "viewing" : ""} onClick={() => onView(row.id === mine?.id ? "mine" : row.id)}>
              <td className="rk">{i + 1}</td>
              <td className="who">{row.name}{row.id === mine?.id && <span className="tag you">you</span>}{row.locked && <span className="tag lk">locked</span>}</td>
              <td className="pts num">{row.s.pts}</td>
              <td className="cr">{row.s.correct}/{row.s.judged}</td>
              <td className="ch">{row.champ && row.dead ? <s>{champ}</s> : champ}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Results({ M, real }: { M: Model; real: Match[][] }) {
  let r = -1;
  for (let i = M.rounds - 1; i >= 0; i--) if (real[i].some((mt) => mt.official)) { r = i; break; }
  if (r < 0) return <div id="t-side"><h2 className="sec">Results <span className="mono">none yet</span></h2><div className="lbempty">Nothing has been reported yet. Picks stay open in every round until a result lands.</div></div>;
  const decided = real[r].filter((mt) => mt.official).length;
  return (
    <div id="t-side">
      <h2 className="sec">{M.names[r]} <span className="mono">{decided} of {real[r].length} reported</span></h2>
      <table className="lb plain"><tbody>
        {real[r].map((mt, i) => {
          if (!mt.official) return <tr key={i}><td className="cr">{i + 1}</td><td className="ch" colSpan={3}>{mt.a && mt.b ? <>{mt.a.seed} {mt.a.name} <span style={{ color: "var(--dim)" }}>vs</span> {mt.b.seed} {mt.b.name} — pending</> : "waiting on the round before"}</td></tr>;
          const w = mt.winner!, l = mt.loser!, up = w.seed > l.seed;
          return <tr key={i}><td className="cr">{i + 1}</td><td className="who" style={{ fontWeight: 500 }}>{w.seed} {w.name}{up && <span className="tag lk">upset</span>}</td><td className="ch">over {l.seed} {l.name}</td><td className="cr">{mt.official.margin}</td></tr>;
        })}
      </tbody></table>
    </div>
  );
}

function Hint({ M, view, editable, mine, myLocked, viewedName, P, t }: any) {
  let content: React.ReactNode;
  if (view === "real") {
    const notes = Object.values(t.notes || {}) as string[];
    content = <><b>Actual results as reported on Tabroom</b>, ballot count beside each winner. {P.total ? `${P.done} of ${P.total} matches decided.` : ""} {notes.join(" ")}</>;
  } else if (editable) {
    content = <><span className="key"><i className="chip p" /> your pick</span><span className="key"><i className="chip c" /> correct</span><span className="key"><i className="chip x" /> missed</span><span className="key"><i className="chip d" /> already knocked out</span><br /><b>Click the team that wins</b> to advance them; click again to undo. Matches lock as real results land. Lock the whole bracket when you&rsquo;re done.</>;
  } else if (view === "mine" && mine && myLocked) {
    content = <><b>Your bracket is locked.</b> It scores itself as results come in — click any name in the pool to see what they went with.</>;
  } else if (view === "mine" && entriesClosed(M)) {
    content = <><b>Brackets are closed</b> — first-round results are in. Switch to Actual results, or click a name in the pool to see their picks.</>;
  } else if (view === "mine") {
    content = <><b>Enter a name above to start your bracket.</b> Anyone who opens this page gets one of their own; everyone scores on the same leaderboard.</>;
  } else {
    content = <><b>Viewing {viewedName}&rsquo;s bracket</b> — read-only. Switch back to My bracket to change yours.</>;
  }
  return <p className="hint">{content}</p>;
}

function Board({ M, tree, real, dead, view, editable, query, justKey, zoom, boardRef, onClick }: any) {
  if (!M.rounds) return <div className="board"><div className="canvas"><div className="lbempty" style={{ padding: "28px 0" }}>The bracket hasn’t been pulled from Tabroom yet. It appears here on the next automatic update.</div></div></div>;
  return (
    <div className="board" ref={boardRef}>
      <div className="canvas" style={{ zoom, ["--bh" as any]: `calc(${M.first} * var(--match-h))` }}>
        {tree.map((matches: Match[], r: number) => (
          <div className="round" id={`round-${r}`} key={r}>
            <div className="rhead">
              <div className="rn">{M.names[r]}</div>
              <div className="rc">{(M.first >> r) * 2} teams · {r < M.locked ? "before the pool · not scored" : `${M.pts[r]} pt${M.pts[r] > 1 ? "s" : ""} each`}</div>
            </div>
            <div className="matches">
              {matches.map((mt, m) => (
                <div className="match" key={m}>
                  <div className="teams">
                    {[0, 1].map((side) => (
                      <Slot key={side} M={M} r={r} m={m} side={side as 0 | 1} mt={mt} truth={real[r][m]} view={view} editable={editable} dead={dead} query={query} just={justKey === `${r}:${m}:${side}`} onClick={onClick} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Slot({ M, r, m, side, mt, truth, view, editable, dead, query, just, onClick }: any) {
  const team = side === 0 ? mt.a : mt.b;
  let cls = "slot", margin = "", tip = "", disabled = true;
  if (!team) {
    return <button className="slot blank" disabled><span className="seed" /><span className="nm">{mt.bye ? "bye" : "—"}</span><span className="mg" /></button>;
  }
  const locked = !!truth.winner;
  tip = `${team.seed}. ${team.name}`;
  if (mt.bye) { cls += " win auto"; tip += " — bye"; }
  else if (view === "real" || r < M.locked) {
    if (mt.official) {
      if (mt.winner === team) { cls += " win"; margin = mt.official.margin; tip += mt.official.side === "ADV" ? " — advanced; no decision posted" : ` — won ${mt.official.margin} on the ${mt.official.side === "AFF" ? "aff" : "neg"}`; }
      else cls += " out";
    } else { cls += " await"; tip += mt.a && mt.b ? " — not yet reported" : " — waiting on the round before"; }
  } else {
    const isPick = mt.winner === team;
    if (!locked) {
      if (mt.a && mt.b && editable) { disabled = false; cls += " live"; }
      else if (!mt.a || !mt.b) cls += " await";
      if (isPick) { cls += dead[team.seed] ? " doomed" : " pick"; tip += dead[team.seed] ? " — picked, already eliminated" : " — picked to advance"; }
    } else if (isPick) {
      const hit = truth.winner && truth.winner.seed === team.seed;
      cls += hit ? " correct" : " miss";
      if (hit) { const b = bonusFor(M, r, truth.winner, truth.loser); margin = `+${M.pts[r] + b}`; tip += ` — called it, ${M.pts[r] + b} pts${b ? ` (incl. +${b} upset)` : ""}`; }
      else { margin = "0"; tip += ` — missed; ${truth.winner ? truth.winner.name + " won" : "eliminated"}`; }
    } else { cls += " out"; if (truth.winner && truth.winner.seed === team.seed) tip += " — actually won this one"; }
  }
  if (query && team.name.toLowerCase().includes(query)) cls += " hit";
  if (just) cls += " just";
  return (
    <button className={cls} disabled={disabled} title={tip} onClick={() => onClick(r, m, side)}>
      <span className="seed">{team.seed}</span><span className="nm">{team.name}</span><span className="mg">{margin}</span>
    </button>
  );
}
