"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Nav from "@/components/Nav";
import TeamDossier, { type PoolContext } from "@/components/stats/TeamDossier";
import PreBracket from "@/components/PreBracket";
import {
  useTournament, useEntries, useUser, useMyEntry, apiCreateEntry, apiUpdateEntry,
} from "@/lib/useBreak";
import {
  model, build, progress, eliminated, score, prune, bonusFor, entriesClosed,
  type Model, type Match, type Team,
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
  const user = useUser();
  const { entries, reload } = useEntries(t.id);
  const { mine: my, reloadMine, setMineId } = useMyEntry(t.id, user);
  const M = useMemo(() => model(t), [t]);

  const [view, setView] = useState<string>("mine");    // "mine" | "real" | bracket id
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [myPicks, setMyPicks] = useState<Picks>({});
  const [justKey, setJustKey] = useState<string | null>(null);
  const [dossier, setDossier] = useState<Team | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWrite = useRef(0);

  const mine = my?.id ? { id: my.id } : null;
  const name = my?.name || "";

  // adopt my picks from the pool (locks, other devices) unless I just wrote
  const myEntry: Entry | undefined = mine ? entries[mine.id] : undefined;
  useEffect(() => {
    if (myEntry && Date.now() - lastWrite.current > 2500) setMyPicks(myEntry.picks || {});
  }, [myEntry]);

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
    const doSave = () => apiUpdateEntry(t.id, mine.id, {
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
    try {
      const created = await apiCreateEntry(t.id, clean, myPicks);
      setMineId(created.id);
      setView("mine");
      reload(); reloadMine();
    } catch (e: any) { alert(e.message); }
  }

  const openDossier = useCallback((team: Team) => setDossier(team), []);
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get("team");
    if (!want || !M.entries.length) return;
    const hit = M.entries.find((e) => e && e.name.toLowerCase() === want.toLowerCase());
    if (hit) setDossier(hit);
  }, [M]);
  const pool = useMemo<PoolContext | null>(() => dossier ? poolContext(M, real, dead, P, entries, dossier) : null, [M, real, dead, P, entries, dossier]);

  // Before a bracket exists there is nothing to pick, so the page shows who is
  // entered, what the ratings know about them, and a tournament you can run.
  if (!M.size && t.tabroom_event_abbr) {
    return (
      <>
        <div className="thead">
          <p className="crumb mono reveal"><Link href="/">← Tournaments</Link></p>
          <h1 className="reveal">{t.name}</h1>
          <Sub t={t} M={M} P={P} />
        </div>
        <PreBracket tid={t.id} name={t.name} />
      </>
    );
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
            M={M} mine={mine} ready={my !== undefined} lookupError={my?.error} name={name} myLocked={myLocked} myEntry={myEntry} myPicks={myPicks}
            onStart={start}
            onRename={(nm: string) => persist(myPicks, false, nm)}
            onLock={() => persist(myPicks, true)}
            entries={entries}
            onOpen={(id: string) => setView(id === mine?.id ? "mine" : id)}
          />
          <Leaderboard
            M={M} real={real} dead={dead} entries={entries} mine={mine}
            myName={name} myPicks={myPicks} myLocked={myLocked} view={view}
            onView={(id: string) => setView(id)}
          />
        </div>
        <Results M={M} real={real} onTeam={openDossier} />
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

      <Hint M={M} view={view} editable={editable} mine={mine} myLocked={myLocked} viewedName={viewedName} P={P} t={t} signedIn={!!user} />

      <Board
        M={M} tree={tree} real={real} dead={dead} view={view} editable={editable}
        query={query.trim().toLowerCase()} justKey={justKey} zoom={zoom}
        boardRef={boardRef} onClick={clickSlot} onInfo={openDossier}
      />

      {dossier && pool && <TeamDossier tid={t.id} team={dossier} pool={pool} onClose={() => setDossier(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
/** What this pool thinks of a team: how many brackets carry them through each round, and where they really stand. */
function poolContext(M: Model, real: Match[][], dead: Record<number, true>, P: ReturnType<typeof progress>, entries: Record<string, Entry>, team: Team): PoolContext {
  const list = Object.values(entries);
  const trees = list.map((e) => build(M, "picks", e.picks || {}));
  const rows: PoolContext["rows"] = [];
  let outRound = -1;
  for (let r = 0; r < M.rounds; r++) {
    const lost = real[r].some((mt) => mt.loser?.seed === team.seed);
    if (lost && outRound < 0) outRound = r;
  }
  for (let r = M.locked; r < M.rounds; r++) {
    const count = trees.filter((tr) => tr[r].some((mt) => mt.winner?.seed === team.seed && !mt.bye)).length;
    const won = real[r].some((mt) => mt.winner?.seed === team.seed && !mt.bye);
    const truth: "yes" | "no" | null = won ? "yes" : (outRound >= 0 && outRound <= r) ? "no" : null;
    rows.push({ label: M.names[r], count, truth });
  }
  const champCount = M.rounds ? trees.filter((tr) => tr[M.rounds - 1][0].winner?.seed === team.seed).length : 0;
  let status: string;
  if (P.champ && P.champ.seed === team.seed) status = "Tournament champion";
  else if (dead[team.seed]) status = `Out in ${M.names[outRound] || "elims"}`;
  else if (P.complete) status = "Did not win";
  else status = "Still alive in this bracket";
  return { total: list.length, rows, champCount, status };
}

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

function Me({ M, mine, ready, lookupError, name, myLocked, myEntry, myPicks, onStart, onRename, onLock, entries, onOpen }: any) {
  const [draft, setDraft] = useState(name);
  const [renaming, setRenaming] = useState(false);
  const [armed, setArmed] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [openId, setOpenId] = useState("");
  useEffect(() => setDraft(name), [name]);

  if (!M.size) return <div className="me"><span className="mono" style={{ color: "var(--muted)" }}>Picks open once the bracket is in.</span></div>;
  if (!ready) return <div className="me"><span className="mono" style={{ color: "var(--muted)" }}>Finding your bracket…</span></div>;
  if (lookupError) return <div className="me"><span style={{ color: "var(--bad)", fontSize: 13 }}>Couldn&rsquo;t look up your bracket: {lookupError}</span></div>;

  if (!mine && entriesClosed(M)) {
    return <div className="me"><span className="mono" style={{ color: "var(--muted)" }}>Brackets are closed — first-round results are in.</span></div>;
  }

  if (!mine) {
    return (
      <div className="me">
        <input value={draft} maxLength={24} placeholder="Name on the leaderboard" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onStart(draft); }} />
        <button className="primary" onClick={() => onStart(draft)}>Start my bracket</button>
        <span className="grow" /><span className="mono" style={{ color: "var(--muted)" }}>one per person</span>
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
            <span className="who">{myEntry?.name || name || "You"}<small>{mine.id}</small></span>
            <span className="grow" />
            {myLocked
              ? <span className="locked">Locked {fmtDate(myEntry?.locked_at)}</span>
              : <>
                  <button onClick={() => { setDraft(myEntry?.name || name); setRenaming(true); }}>Rename</button>
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

function Results({ M, real, onTeam }: { M: Model; real: Match[][]; onTeam: (t: Team) => void }) {
  let r = -1;
  for (let i = M.rounds - 1; i >= 0; i--) if (real[i].some((mt) => mt.official)) { r = i; break; }
  if (r < 0) return <div id="t-side"><h2 className="sec">Results <span className="mono">none yet</span></h2><div className="lbempty">Nothing has been reported yet. Picks stay open in every round until a result lands.</div></div>;
  const decided = real[r].filter((mt) => mt.official).length;
  const T = ({ t }: { t: Team }) => <button className="teamlink" onClick={() => onTeam(t)}>{t.seed} {t.name}</button>;
  return (
    <div id="t-side">
      <h2 className="sec">{M.names[r]} <span className="mono">{decided} of {real[r].length} reported</span></h2>
      <table className="lb plain"><tbody>
        {real[r].map((mt, i) => {
          if (!mt.official) return <tr key={i}><td className="cr">{i + 1}</td><td className="ch" colSpan={3}>{mt.a && mt.b ? <><T t={mt.a} /> <span style={{ color: "var(--dim)" }}>vs</span> <T t={mt.b} /> — pending</> : "waiting on the round before"}</td></tr>;
          const w = mt.winner!, l = mt.loser!, up = w.seed > l.seed;
          return <tr key={i}><td className="cr">{i + 1}</td><td className="who" style={{ fontWeight: 500 }}><T t={w} />{up && <span className="tag lk">upset</span>}</td><td className="ch">over <T t={l} /></td><td className="cr">{mt.official.margin}</td></tr>;
        })}
      </tbody></table>
    </div>
  );
}

function Hint({ M, view, editable, mine, myLocked, viewedName, P, t, signedIn }: any) {
  let content: React.ReactNode;
  const stats = <> Hover any team and hit <b>◔</b> for its full Tabroom dossier.</>;
  if (view === "real") {
    const notes = Object.values(t.notes || {}) as string[];
    content = <><b>Actual results as reported on Tabroom</b>, ballot count beside each winner. {P.total ? `${P.done} of ${P.total} matches decided.` : ""} {notes.join(" ")} Click any team for its dossier.</>;
  } else if (editable) {
    content = <><span className="key"><i className="chip p" /> your pick</span><span className="key"><i className="chip c" /> correct</span><span className="key"><i className="chip x" /> missed</span><span className="key"><i className="chip d" /> already knocked out</span><br /><b>Click the team that wins</b> to advance them; click again to undo. Matches lock as real results land. Lock the whole bracket when you&rsquo;re done.{stats}</>;
  } else if (view === "mine" && mine && myLocked) {
    content = <><b>Your bracket is locked.</b> It scores itself as results come in — click any name in the pool to see what they went with. Click any team for its dossier.</>;
  } else if (view === "mine" && entriesClosed(M)) {
    content = <><b>Brackets are closed</b> — first-round results are in. Switch to Actual results, or click a name in the pool to see their picks. Click any team for its dossier.</>;
  } else if (view === "mine") {
    content = <><b>{signedIn ? "Start your bracket above." : "Sign in to start a bracket."}</b> One bracket per person per tournament; everyone scores on the same leaderboard. Click any team for its dossier.</>;
  } else {
    content = <><b>Viewing {viewedName}&rsquo;s bracket</b> — read-only. Switch back to My bracket to change yours. Click any team for its dossier.</>;
  }
  return <p className="hint">{content}</p>;
}

function Board({ M, tree, real, dead, view, editable, query, justKey, zoom, boardRef, onClick, onInfo }: any) {
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
                      <Slot key={side} M={M} r={r} m={m} side={side as 0 | 1} mt={mt} truth={real[r][m]} view={view} editable={editable} dead={dead} query={query} just={justKey === `${r}:${m}:${side}`} onClick={onClick} onInfo={onInfo} />
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

function Slot({ M, r, m, side, mt, truth, view, editable, dead, query, just, onClick, onInfo }: any) {
  const team: Team | null = side === 0 ? mt.a : mt.b;
  let cls = "slot", margin = "", tip = "", pickable = false;
  if (!team) {
    return <div className="slotwrap"><button className="slot blank" disabled><span className="seed" /><span className="nm">{mt.bye ? "bye" : "—"}</span><span className="mg" /></button></div>;
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
      if (mt.a && mt.b && editable) { pickable = true; cls += " live"; }
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
  // pickable slots pick on click and open stats from the ◔ button; everything else opens stats on click
  return (
    <div className="slotwrap">
      <button className={cls + (pickable ? "" : " infoable")} title={pickable ? tip : tip + " — click for stats"} onClick={() => pickable ? onClick(r, m, side) : onInfo(team)}>
        <span className="seed">{team.seed}</span><span className="nm">{team.name}</span><span className="mg">{margin}</span>
      </button>
      {pickable && <button className="info" title={`${team.name} — stats`} aria-label={`${team.name} statistics`} onClick={(e) => { e.stopPropagation(); onInfo(team); }}>◔</button>}
    </div>
  );
}
