"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Ico from "./Ico";
import { useFitBar } from "./fitBar";

/**
 * The tutorial's "Try it" panels: each tool in miniature, working, with one
 * thing to do in it. They borrow nothing from the tools themselves (nothing
 * here can touch a real flow or a real send list); they only behave like them.
 */

/* ================================================================ shared */

/** "Ctrl+Shift+Z" as keys; "↑ ↓" as two; "F3 / Enter" as alternatives. */
export function Keys({ k }: { k: string }) {
  return (
    <span className="tu-keys">
      {k.split(" / ").map((alt, i) => (
        <span key={i} className="tu-alt">
          {i > 0 && <i>or</i>}
          {alt.split(" ").map((chord, j) => (
            <span key={j} className="tu-chord">
              {chord.split("+").map((x, n) => <kbd key={n}>{x}</kbd>)}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

export function Demo({ goal, done, onReset, children, wide }: { goal: string; done: boolean; onReset?: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={"tu-demo" + (done ? " done" : "") + (wide ? " wide" : "")}>
      <div className="tu-dh">
        <span className="tu-try mono">Try it</span>
        <span className="tu-goal"><i className="tu-check" aria-hidden="true">{done ? "✓" : ""}</i>{goal}</span>
        {onReset && <button type="button" className="tu-reset mono" onClick={onReset}>Reset</button>}
      </div>
      <div className="tu-dbody">{children}</div>
    </div>
  );
}

const TAGS = /\b(dropped|ext|turn|perm|nuq)\b/gi;
function Marked({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  text.replace(TAGS, (m, _g, at: number) => {
    if (at > last) parts.push(text.slice(last, at));
    parts.push(<span key={at} className={"tu-tg " + m.toLowerCase()}>{m.toUpperCase()}</span>);
    last = at + m.length;
    return m;
  });
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/* ================================================================ 00 the map, played */

const LANES = [
  ["Evidence", "Send list & send doc", "Flow · Send doc tab", "Flow all"],
  ["SpeechDrop / a .docx", "Doc viewer", "Rehighlight", "Evidence"],
  ["One room code", "Flow", "Send doc", "Doc viewer"],
];
const LANE_LAB = ["Your cards", "Their docs", "With your partner"];
const LANE_SAY = [
  ["You find “AT: Midterms” in Evidence and press Enter.", "It's copied, in your send list and in the send doc.", "Flow's drawer shows the send doc as you build it.", "Flow all lays every block beside the argument it answers."],
  ["The other team drops their case on SpeechDrop.", "You open it in the Doc viewer, outline and all.", "Their card, your way: their highlighting grey, yours green.", "Sent: it lands in your send list."],
  ["You start a room in Flow and read out the code.", "Your partner types it in their Flow: one flow, two people.", "Their Evidence joins too: one send doc for both of you.", "And the Doc viewer can read that send doc live."],
];

export function MapDemo({ onDone, done }: { onDone: () => void; done: boolean }) {
  const [step, setStep] = useState(-1);          // lane*4 + node
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setStep((s) => Math.min(11, s + 1)), 1500);
    return () => clearInterval(t);
  }, [playing]);
  // the whole round seen: done, and the playing stops
  useEffect(() => { if (step >= 11) { setPlaying(false); onDone(); } }, [step, onDone]);
  const lane = step < 0 ? -1 : Math.floor(step / 4), node = step < 0 ? -1 : step % 4;
  return (
    <Demo goal="Play a round through the tools" done={done} onReset={() => { setStep(-1); setPlaying(false); }}>
      <div className="tu-map interactive">
        {LANES.map((l, li) => (
          <div key={li} className={"tu-lane" + (li === lane ? " on" : "") + (li < lane ? " past" : "")}>
            <span className="tu-lab mono">{LANE_LAB[li]}</span>
            {l.map((n, ni) => (
              <span key={ni} className="tu-step">
                {ni > 0 && <span className={li === 2 && ni > 1 ? "tu-plus" : "tu-arrow"}>{li === 2 && ni > 1 ? "+" : "→"}</span>}
                <button type="button" className={"tu-node" + (ni % 2 ? " soft" : "") + (li < lane || (li === lane && ni <= node) ? " lit" : "") + (li === lane && ni === node ? " now" : "")}
                  onClick={() => { setPlaying(false); setStep(li * 4 + ni); }}>{n}</button>
              </span>
            ))}
          </div>
        ))}
        <div className="tu-say" aria-live="polite">{step < 0 ? "Press Play, or click any step." : LANE_SAY[lane][node]}</div>
        <div className="tu-row">
          <button type="button" className="tu-btn ink" onClick={() => { if (step >= 11) setStep(-1); setPlaying((p) => !p); }}>{playing ? "Pause" : step >= 11 ? "Play again" : "▶ Play"}</button>
          <button type="button" className="tu-btn" onClick={() => { setPlaying(false); setStep((s) => Math.max(-1, s - 1)); }}>‹ Back</button>
          <button type="button" className="tu-btn" onClick={() => { setPlaying(false); setStep((s) => Math.min(11, s + 1)); }}>Next ›</button>
        </div>
      </div>
    </Demo>
  );
}

/* ================================================================ 01 Evidence */

const LIB = [
  { title: "AT: Econ collapse", args: ["Growth is resilient", "AI boosts productivity", "No recession coming"] },
  { title: "AT: Tech race", args: ["China isn't racing", "No tech leadership impact"] },
  { title: "Heg good", args: ["Heg prevents great-power war", "Alliances hold"] },
  { title: "AT: Midterms", args: ["GOP wins now", "GOP gets credit", "Republicans block the dome"] },
  { title: "Space weaponization bad", args: ["Arms race", "Debris cascade"] },
];

export function EvidenceDemo({ onDone, done }: { onDone: () => void; done: boolean }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [arg, setArg] = useState<number | null>(null);
  const [sent, setSent] = useState<{ title: string; args: string[]; n: number }[]>([]);
  const [numbers, setNumbers] = useState(true);
  const [speech, setSpeech] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => {
    const terms = q.toLowerCase().replace(/^\//, "").split(/\s+/).filter(Boolean);
    return LIB.filter((b) => terms.every((t) => (b.title + " " + b.args.join(" ")).toLowerCase().includes(t)));
  }, [q]);
  useEffect(() => { setSel(0); setArg(null); }, [q]);
  const send = (bi: number, ai: number | null) => {
    const b = results[bi];
    if (!b) return;
    const picked = ai === null ? b.args : [b.args[ai]];
    setSent((list) => {
      const at = list.findIndex((x) => x.title === b.title);
      if (at >= 0) {
        const merged = [...list[at].args, ...picked.filter((p) => !list[at].args.includes(p))];
        const copy = list.slice(); copy[at] = { ...list[at], args: merged, n: Date.now() }; return copy;
      }
      return [...list, { title: b.title, args: picked, n: Date.now() }];
    });
    onDone();
    // the search stays, as it does in Evidence: the next card often comes from it
    input.current?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const b = results[sel];
    if (e.key === "ArrowDown") { e.preventDefault(); if (arg !== null && b) setArg(Math.min(b.args.length - 1, arg + 1)); else setSel((s) => Math.min(results.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (arg !== null) setArg(arg > 0 ? arg - 1 : null); else setSel((s) => Math.max(0, s - 1)); }
    else if ((e.key === "ArrowRight" && (e.currentTarget as HTMLInputElement).selectionStart === q.length) || e.key === "Tab") { e.preventDefault(); if (b) setArg(arg === null ? 0 : null); }
    else if (e.key === "ArrowLeft" && arg !== null) { e.preventDefault(); setArg(null); }
    else if (e.key === "Enter") { e.preventDefault(); send(sel, arg); }
    else if (e.key === "Escape") { e.preventDefault(); setQ(""); }
  };
  return (
    <Demo goal="Search for a trigger and send a card with Enter" done={done} wide onReset={() => { setQ(""); setSent([]); }}>
      <div className="tu-ev">
        <div className="tu-ev-l">
          <label className="tu-ev-q"><span>/</span>
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Try “econ” or “midterms”" spellCheck={false} aria-label="Search the demo library" />
          </label>
          <ul className="tu-ev-res">
            {results.map((b, i) => (
              <li key={b.title} className={i === sel ? "on" : ""} onMouseEnter={() => { if (arg === null) setSel(i); }}>
                <button type="button" className="tu-ev-b" onClick={() => { setSel(i); setArg(null); send(i, null); }} title="Send the whole block">
                  <b>{b.title}</b><small>{b.args.length} cards</small>
                </button>
                {i === sel && arg !== null && (
                  <ol>{b.args.map((a, j) => <li key={a} className={j === arg ? "on" : ""}><button type="button" onClick={() => send(i, j)}>{a}</button></li>)}</ol>
                )}
              </li>
            ))}
            {!results.length && <li className="none">Nothing says that. Try “tech”.</li>}
          </ul>
          <p className="tu-hint"><Keys k="↑ ↓" /> move · <Keys k="→" /> its cards · <Keys k="Enter" /> send · <Keys k="Esc" /> clear</p>
        </div>
        <div className="tu-ev-r">
          <div className="tu-ev-fmt">
            <span className="mono">Format</span>
            <button type="button" className={"tu-chip" + (numbers ? " on" : "")} onClick={() => setNumbers((x) => !x)}>{numbers ? "Number them" : "No numbers"}</button>
            <button type="button" className={"tu-chip" + (speech ? " on" : "")} onClick={() => setSpeech((x) => !x)}>Speech on headings</button>
          </div>
          <div className="tu-paper">
            {!sent.length && <p className="tu-empty">The send doc fills in as you send.</p>}
            {sent.map((b) => (
              <div key={b.title} className="tu-blk" data-n={b.n}>
                <h5>{b.title}{speech ? "---2NC" : ""}</h5>
                {b.args.map((a, j) => <h6 key={a}>{numbers ? `${j + 1}. ` : ""}{a}</h6>)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Demo>
  );
}

/* ================================================================ 02 Flow */

const FCOLS = [{ k: "CASE", s: "pro" }, { k: "REB", s: "con" }, { k: "REB", s: "pro" }];
const START_ROWS = () => [["Contention 1 is ECON.", "", ""], ["Econ collapses now", "", ""], ["AI boosts growth", "", ""], ["", "", ""]];
const SPEECHES = [{ n: "Pro constructive", c: 0 }, { n: "Con constructive", c: -1 }, { n: "Con rebuttal", c: 1 }, { n: "Pro rebuttal", c: 2 }];

export function FlowDemo({ onDone, done }: { onDone: () => void; done: boolean }) {
  const [rows, setRows] = useState<string[][]>(START_ROWS);
  const [sel, setSel] = useState({ r: 1, c: 1 });
  const [edit, setEdit] = useState<string | null>(null);
  const [sp, setSp] = useState(2);
  const [left, setLeft] = useState(240);
  const [run, setRun] = useState(false);
  const [popped, setPopped] = useState<Set<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!run) return; const t = setInterval(() => setLeft((l) => (l > 0 ? l - 1 : 0)), 1000); return () => clearInterval(t); }, [run]);
  const editing = edit !== null;
  useEffect(() => {
    const f = field.current;
    if (!editing || !f) return;
    f.focus();
    f.setSelectionRange(f.value.length, f.value.length);
  }, [editing]);

  const commit = useCallback((to?: { r: number; c: number }) => {
    if (edit !== null && edit.trim() && sel.c > 0) onDone();
    setRows((rs) => {
      const copy = rs.map((r) => r.slice());
      if (edit !== null) copy[sel.r][sel.c] = edit;
      if (to && to.r >= copy.length) copy.push(["", "", ""]);
      return copy;
    });
    setEdit(null);
    if (to) setSel({ r: to.r, c: Math.min(2, Math.max(0, to.c)) });
    setTimeout(() => box.current?.focus(), 0);
  }, [edit, sel, onDone]);

  const onKey = (e: React.KeyboardEvent) => {
    if (edit !== null) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit({ r: sel.r + 1, c: sel.c }); }
      else if (e.key === "Tab") { e.preventDefault(); commit({ r: sel.r, c: sel.c + 1 }); }
      else if (e.key === "Escape") { e.preventDefault(); commit(); }
      return;
    }
    const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key] as [number, number] | undefined;
    if (mv) { e.preventDefault(); setSel((s) => ({ r: Math.min(rows.length - 1, Math.max(0, s.r + mv[0])), c: Math.min(2, Math.max(0, s.c + mv[1])) })); return; }
    if (e.key === "Enter") { e.preventDefault(); setEdit(rows[sel.r][sel.c]); return; }
    if (e.key === "Tab") { e.preventDefault(); setSel((s) => ({ r: s.r, c: Math.min(2, s.c + 1) })); return; }
    if (e.key === "Backspace") { e.preventDefault(); setRows((rs) => { const c = rs.map((r) => r.slice()); c[sel.r][sel.c] = ""; return c; }); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setEdit(e.key); }
  };

  const flowAll = () => {
    const lines = ["AT: Econ collapse---2NC", "1. Growth is resilient", "2. AI boosts productivity", "3. No recession coming"];
    setRows((rs) => {
      const copy = rs.map((r) => r.slice());
      lines.forEach((ln, i) => { if (!copy[i]) copy.push(["", "", ""]); copy[i][1] = ln; });
      return copy;
    });
    setPopped(new Set(lines.map((_, i) => i + ":1")));
    setTimeout(() => setPopped(new Set()), 1400);
    onDone();
  };
  const live = SPEECHES[sp].c;
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <Demo goal="Answer an argument in the REB column, or press Flow all" done={done} wide onReset={() => { setRows(START_ROWS()); setSel({ r: 1, c: 1 }); setEdit(null); setLeft(240); setRun(false); }}>
      <div className="tu-fl">
        <div className="tu-fl-main">
          <div className="tu-clock">
            <button type="button" onClick={() => { setSp((s) => Math.max(0, s - 1)); setLeft(240); }} aria-label="Speech before">‹</button>
            <b>{SPEECHES[sp].n}</b>
            <button type="button" onClick={() => { setSp((s) => Math.min(SPEECHES.length - 1, s + 1)); setLeft(240); }} aria-label="Speech after">›</button>
            <span className={"tm" + (left <= 30 ? " low" : "")}>{clock}</span>
            <button type="button" className={"play" + (run ? " on" : "")} onClick={() => setRun((r) => !r)} aria-label="Start or pause">{run ? "❚❚" : "▶"}</button>
          </div>
          <div className="tu-grid" ref={box} tabIndex={0} onKeyDown={onKey} aria-label="A demo flow — click a cell and type">
            {FCOLS.map((c, i) => <div key={i} className={"tu-gh " + c.s + (i === live ? " live" : "")}><b>{c.k}</b><span>{c.s.toUpperCase()}</span>{i === live && <em>live</em>}</div>)}
            {rows.map((r, ri) => r.map((t, ci) => {
              const on = sel.r === ri && sel.c === ci;
              return (
                <div key={ri + ":" + ci} className={"tu-gc " + FCOLS[ci].s + (on ? " sel" : "") + (popped.has(ri + ":" + ci) ? " pop" : "")}
                  style={popped.has(ri + ":" + ci) ? { animationDelay: ri * 90 + "ms" } : undefined}
                  onMouseDown={(e) => { e.preventDefault(); if (edit !== null) commit(); setSel({ r: ri, c: ci }); box.current?.focus(); }}
                  onDoubleClick={() => setEdit(rows[ri][ci])}>
                  {on && edit !== null
                    ? <textarea ref={field} value={edit} onChange={(e) => setEdit(e.target.value)} onKeyDown={onKey} rows={2} />
                    : <Marked text={t} />}
                </div>
              );
            }))}
          </div>
          <p className="tu-hint">Click a cell and type · <Keys k="Enter" /> next line · <Keys k="Tab" /> answer across · try typing <i>ext</i> or <i>turn</i></p>
        </div>
        <aside className="tu-fl-side">
          <div className="mono">Drawer › Send doc</div>
          <div className="tu-sdb"><b>AT: Econ collapse---2NC</b><ol><li>Growth is resilient</li><li>AI boosts productivity</li><li>No recession coming</li></ol></div>
          <button type="button" className="tu-btn ink" onClick={flowAll}>Flow all ↓</button>
          <p className="tu-hint">Finds “Contention 1 is ECON.” by name and fills in beside its sub-points.</p>
        </aside>
      </div>
    </Demo>
  );
}

/* ================================================================ 03 Doc flow */

interface DLine { id: number; t: string; d: number; who: "them" | "us" }
const START_DOC = (): DLine[] => [
  { id: 1, t: "Econ collapses now", d: 0, who: "them" },
  { id: 2, t: "AI boosts growth", d: 0, who: "them" },
];
const numeral = (d: number, n: number) => (d % 3 === 0 ? String(n) : d % 3 === 1 ? String.fromCharCode(96 + n) : ["i", "ii", "iii", "iv", "v", "vi"][n - 1] || String(n));

export function DocFlowDemo({ onDone, done }: { onDone: () => void; done: boolean }) {
  const [lines, setLines] = useState<DLine[]>(START_DOC);
  const refs = useRef<Map<number, HTMLInputElement>>(new Map());
  const focusId = useRef<number | null>(null);
  useEffect(() => { if (focusId.current !== null) { refs.current.get(focusId.current)?.focus(); focusId.current = null; } });
  let nextId = Math.max(0, ...lines.map((l) => l.id)) + 1;
  const numbers = useMemo(() => {
    const count: number[] = [];
    return lines.map((l) => { count.length = l.d + 1; count[l.d] = (count[l.d] || 0) + 1; return numeral(l.d, count[l.d]); });
  }, [lines]);
  const onKey = (i: number) => (e: React.KeyboardEvent) => {
    const l = lines[i];
    if (e.key === "Tab") {
      e.preventDefault();
      const d = e.shiftKey ? Math.max(0, l.d - 1) : Math.min(3, l.d + 1);
      if (d === l.d) return;
      setLines((ls) => ls.map((x, j) => (j === i ? { ...x, d, who: x.who === "them" ? "us" : "them" } : x)));
      if (!e.shiftKey) onDone();
      focusId.current = l.id;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const n: DLine = e.ctrlKey ? { id: nextId++, t: "", d: 0, who: "them" } : { id: nextId++, t: "", d: l.d, who: l.who };
      setLines((ls) => [...ls.slice(0, i + 1), n, ...ls.slice(i + 1)]);
      focusId.current = n.id;
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const j = e.key === "ArrowUp" ? i - 1 : i + 1;
      if (j < 0 || j >= lines.length) return;
      setLines((ls) => { const c = ls.slice(); [c[i], c[j]] = [c[j], c[i]]; return c; });
      focusId.current = l.id;
    } else if (e.altKey && e.key.toLowerCase() === "t") {
      e.preventDefault();
      setLines((ls) => ls.map((x, j) => (j === i ? { ...x, who: x.who === "them" ? "us" : "them" } : x)));
    } else if (e.key === "Backspace" && !l.t && lines.length > 1) {
      e.preventDefault();
      setLines((ls) => ls.filter((_, j) => j !== i));
      focusId.current = lines[Math.max(0, i - 1)].id;
    }
  };
  return (
    <Demo goal="Put the cursor on their point, type an answer, press Tab" done={done} onReset={() => setLines(START_DOC())}>
      <div className="tu-df">
        <div className="tu-df-box">NEG</div>
        {lines.map((l, i) => (
          <div key={l.id} className={"tu-df-l " + l.who} style={{ paddingLeft: 10 + l.d * 26 }}>
            <span className="tu-df-n">{numbers[i]}.</span>
            <input ref={(el) => { if (el) refs.current.set(l.id, el); else refs.current.delete(l.id); }} value={l.t}
              onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, t: e.target.value } : x)))}
              onKeyDown={onKey(i)} placeholder={l.who === "them" ? "their point" : "your answer"} spellCheck={false} />
          </div>
        ))}
        <p className="tu-hint"><Keys k="Tab" /> answer (indents, your colour) · <Keys k="Shift+Tab" /> back out · <Keys k="Enter" /> next line · <Keys k="Ctrl+Enter" /> their next point · <Keys k="Alt+T" /> swap who said it</p>
      </div>
    </Demo>
  );
}

/* ================================================================ 04 Doc viewer: rehighlight */

const CARD_WORDS = "Studies show that large data centers consume millions of gallons of water every single day across the arid southwest, according to the survey, and demand is rising faster than supply.".split(" ");
const THEIR_HL = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

export function ViewerDemo({ onDone, done }: { onDone: () => void; done: boolean }) {
  const [mode, setMode] = useState<"read" | "rh" | "sent">("read");
  const [green, setGreen] = useState<Set<number>>(new Set());
  const [hlOnly, setHlOnly] = useState(false);
  const painting = useRef<null | boolean>(null);
  useEffect(() => { const up = () => { painting.current = null; }; window.addEventListener("mouseup", up); return () => window.removeEventListener("mouseup", up); }, []);
  const paint = (i: number, start: boolean) => {
    if (mode !== "rh") return;
    if (start) painting.current = !green.has(i);
    if (painting.current === null) return;
    const on = painting.current;
    setGreen((g) => { const n = new Set(g); if (on) n.add(i); else n.delete(i); return n; });
  };
  return (
    <Demo goal="Rehighlight their card and send it" done={done} onReset={() => { setMode("read"); setGreen(new Set()); }}>
      <div className="tu-vw">
        <div className="tu-vw-bar">
          <button type="button" className={"tu-chip" + (hlOnly ? " on" : "")} onClick={() => setHlOnly((h) => !h)}>Highlighted only</button>
          <button type="button" className={"tu-chip" + (mode !== "read" ? " on" : "")} onClick={() => { if (mode === "read") setMode("rh"); }} disabled={mode !== "read"}>Rehighlight <Keys k="R" /></button>
          {mode === "rh" && <span className="tu-vw-n mono">{green.size} green words</span>}
          {mode === "rh" && <button type="button" className="tu-btn ink" disabled={!green.size} onClick={() => { setMode("sent"); onDone(); }}>Send to send doc</button>}
        </div>
        <div className={"tu-vw-card" + (hlOnly ? " hlonly" : "") + (mode === "rh" ? " rh" : "") + (mode === "sent" ? " sent" : "")}>
          <h5>Data centers drain the water table</h5>
          <p className="cite"><b>Mahmood 24</b>, hydrologist, Western Water Review</p>
          <p className="txt" onMouseLeave={() => { painting.current = null; }}>
            {CARD_WORDS.map((w, i) => {
              const cls = green.has(i) ? "g" : THEIR_HL.has(i) ? (mode === "read" ? "y" : "gr") : "";
              return <span key={i} className={cls} onMouseDown={(e) => { e.preventDefault(); paint(i, true); }} onMouseEnter={(e) => { if (e.buttons === 1) paint(i, false); }}>{w} </span>;
            })}
          </p>
        </div>
        <p className="tu-hint" aria-live="polite">
          {mode === "read" ? "Their highlighting is yellow. Press Rehighlight." : mode === "rh" ? "Theirs is grey now. Drag across words to highlight them green; drag across green to clear it." : "Sent: it's in your send list with their grey and your green."}
        </p>
        {mode === "sent" && <div className="tu-landed"><span className="mono">Send list</span><b>Data centers DA</b><small>Data centers drain the water table · {green.size} green words</small></div>}
      </div>
    </Demo>
  );
}

/* ================================================================ 05 Split screen */

const SPLIT_TOOLS = ["Evidence", "Flow", "Doc viewer", "Doc flow"];
function Sketch({ tool }: { tool: string }) {
  if (tool === "Flow") return <div className="sk sk-grid">{Array.from({ length: 12 }, (_, i) => <i key={i} />)}</div>;
  if (tool === "Evidence") return <div className="sk sk-ev"><i className="q" /><i /><i /><i className="w" /><i /></div>;
  if (tool === "Doc viewer") return <div className="sk sk-doc"><i className="h" /><i /><i className="w" /><i /><i className="hl" /><i /></div>;
  return <div className="sk sk-df"><i className="box" /><i className="r" /><i className="u" /><i className="r" /><i className="u" /></div>;
}

export function SplitDemo({ onDone, done }: { onDone: () => void; done: boolean }) {
  const [sides, setSides] = useState<[string, string]>(["Evidence", "Flow"]);
  const [ratio, setRatio] = useState(0.5);
  const [closed, setClosed] = useState<0 | 1 | null>(null);
  const [drag, setDrag] = useState(false);
  const win = useRef<HTMLDivElement>(null);
  const grab = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(true);
  };
  const move = (e: React.PointerEvent) => {
    if (!drag || !win.current) return;
    const b = win.current.getBoundingClientRect();
    setRatio(Math.min(0.8, Math.max(0.2, (e.clientX - b.left) / b.width)));
    onDone();
  };
  const choose = (side: 0 | 1, t: string) => {
    if (sides[side] === t) return;
    if (sides[1 - side] === t) { setSides([sides[1], sides[0]]); return; }
    const s: [string, string] = [...sides] as [string, string]; s[side] = t; setSides(s);
  };
  return (
    <Demo goal="Drag the line between the two tools" done={done} onReset={() => { setSides(["Evidence", "Flow"]); setRatio(0.5); setClosed(null); }}>
      <div className="tu-sp" ref={win} onPointerMove={move} onPointerUp={() => setDrag(false)}>
        <div className="tu-sp-strip">
          {[0, 1].map((side) => closed === side ? null : (
            <div key={side} className="tu-sp-pick" style={{ flexBasis: closed !== null ? "100%" : `${(side === 0 ? ratio : 1 - ratio) * 100}%` }}>
              {SPLIT_TOOLS.map((t) => <button key={t} type="button" className={sides[side] === t ? "on" : sides[1 - side] === t ? "there" : ""} onClick={() => choose(side as 0 | 1, t)}>{t}{sides[1 - side] === t && closed === null ? " ⇄" : ""}</button>)}
              <button type="button" className="x" onClick={() => setClosed(side as 0 | 1)} title="Close this side">×</button>
            </div>
          ))}
        </div>
        <div className="tu-sp-row">
          {[0, 1].map((side) => closed === side ? null : (
            <div key={side} className="tu-sp-pane" style={{ flexBasis: closed !== null ? "100%" : `${(side === 0 ? ratio : 1 - ratio) * 100}%`, order: side * 2 }}>
              <span className="mono">{sides[side]}</span><Sketch tool={sides[side]} />
            </div>
          ))}
          {closed === null && (
            <div className={"tu-sp-bar" + (drag ? " drag" : "")} style={{ order: 1 }} onPointerDown={grab} onDoubleClick={() => setRatio(0.5)} title="Drag · double-click for half and half">
              <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setSides([sides[1], sides[0]])} aria-label="Swap sides">⇄</button>
            </div>
          )}
        </div>
        {closed !== null && <button type="button" className="tu-btn tu-sp-back" onClick={() => setClosed(null)}>Bring the other side back</button>}
      </div>
    </Demo>
  );
}

/* ================================================================ 06 Pop-outs */

const THEIR_1AC = ["Contention 1 is Midterms.", "Democrats win now: our evidence is best.", "A moratorium flips key voters.", "Blue-collar voters decide the midterms.", "Democrats are key to stopping the Golden Dome.", "That prevents a space arms race."];

export function PopDemo({ onDone, done }: { onDone: () => void; done: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 58, y: 18 });
  const [shown, setShown] = useState(2);
  const desk = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  useEffect(() => { if (!open) return; const t = setInterval(() => setShown((n) => (n < THEIR_1AC.length ? n + 1 : n)), 2200); return () => clearInterval(t); }, [open]);
  return (
    <Demo goal="Pop their doc out, then drag it where you want it" done={done} onReset={() => { setOpen(false); setShown(2); setPos({ x: 58, y: 18 }); }}>
      <div className="tu-desk" ref={desk}
        onPointerMove={(e) => {
          const d = dragFrom.current, b = desk.current?.getBoundingClientRect();
          if (!d || !b) return;
          setPos({ x: Math.min(64, Math.max(0, d.px + ((e.clientX - d.x) / b.width) * 100)), y: Math.min(44, Math.max(0, d.py + ((e.clientY - d.y) / b.height) * 100)) });
        }}
        onPointerUp={() => { dragFrom.current = null; }}>
        <div className="tu-mainwin">
          <div className="tu-wbar"><i /><i /><i /><span>Split screen: Evidence | Flow</span>
            <button type="button" className="tu-popbtn" onClick={() => { setOpen(true); onDone(); }} title="Pop out their doc"><Ico n="pop" /></button>
          </div>
          <div className="tu-mainpanes"><div><Sketch tool="Evidence" /></div><div><Sketch tool="Flow" /></div></div>
        </div>
        {open && (
          <div className="tu-popwin" style={{ left: pos.x + "%", top: pos.y + "%" }}>
            <div className="tu-wbar grab" onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); dragFrom.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; }}>
              <span>Their 1AC</span><em className="live"><i />Live</em>
              <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="tu-popdoc">{THEIR_1AC.slice(0, shown).map((l, i) => <p key={i} className={i === shown - 1 && shown > 2 ? "new" : ""}>{l}</p>)}</div>
          </div>
        )}
        {!open && <p className="tu-deskhint">Click <Ico n="pop" /> in the banner</p>}
      </div>
    </Demo>
  );
}

/* ================================================================ 07 Past flows */

const ROUNDS = [
  { tourn: "Mid America Cup", round: "Round 3 · Pro", vs: "Stuyvesant DB", text: "Midterms: Democrats win now; GOP gets credit; Golden Dome" },
  { tourn: "Mid America Cup", round: "Round 1 · Con", vs: "University CC", text: "Econ collapse, AI boosts growth, tech race impact" },
  { tourn: "Run for the Roses", round: "Octas · Pro", vs: "JR Masterman AB", text: "Space weaponization, debris cascade, arms race" },
  { tourn: "Run for the Roses", round: "Round 5 · Con", vs: "Lexington KR", text: "Heg good, alliances hold, great-power war" },
];

export function PastDemo({ onDone, done }: { onDone: () => void; done: boolean }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = ROUNDS.map((r, i) => ({ r, i })).filter(({ r }) => terms.every((t) => (r.tourn + " " + r.round + " " + r.vs + " " + r.text).toLowerCase().includes(t)));
  useEffect(() => { if (terms.length && hits.length && hits.length < ROUNDS.length) onDone(); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const mark = (s: string) => {
    if (!terms.length) return s;
    const re = new RegExp("(" + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
    return s.split(re).map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p));
  };
  let lastT = "";
  return (
    <Demo goal="Search every word you've flowed. Try “dome” or “econ”" done={done} onReset={() => { setQ(""); setOpen(null); }}>
      <div className="tu-pf">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search every round" spellCheck={false} aria-label="Search the demo rounds" />
        <div className="tu-pf-list">
          {hits.map(({ r, i }) => {
            const head = r.tourn !== lastT ? (lastT = r.tourn) : null;
            return (
              <div key={i}>
                {head && <div className="tu-pf-t mono">{head}</div>}
                <button type="button" className={"tu-pf-r" + (open === i ? " on" : "")} onClick={() => setOpen(open === i ? null : i)}>
                  <b>{r.round}</b><span>vs {mark(r.vs)}</span>
                </button>
                {open === i && <div className="tu-pf-read">{mark(r.text)}</div>}
              </div>
            );
          })}
          {!hits.length && <p className="tu-empty">No round says that.</p>}
        </div>
      </div>
    </Demo>
  );
}

/* ================================================================ 08 every tool: the keys, and a banner that fits */

const KEYNAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", " ": "Space", Escape: "Esc", Delete: "Delete", Backspace: "Backspace", Enter: "Enter", Tab: "Tab" };
function chordOf(e: React.KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  let key = KEYNAMES[e.key] || e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (e.code === "Slash") key = "/";
  else if (e.code === "Period") key = ".";
  else if (e.code === "Backslash") key = "\\";
  else if (e.code === "BracketRight") key = "]";
  else if (e.code === "BracketLeft") key = "[";
  else if (key.length === 1) key = key.toUpperCase();
  return [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", key].filter(Boolean).join("+");
}
const chordsOf = (spec: string) => spec.split(" / ").flatMap((alt) => alt.split(" ")).map((c) => c.toLowerCase());

export function EveryDemo({ onDone, done, allKeys }: { onDone: () => void; done: boolean; allKeys: { tool: string; k: string; what: string }[] }) {
  const [pressed, setPressed] = useState<string | null>(null);
  const [width, setWidth] = useState(640);
  const bar = useRef<HTMLDivElement>(null);
  useFitBar(bar as React.RefObject<HTMLElement>);
  const found = pressed ? allKeys.filter((x) => chordsOf(x.k).includes(pressed.toLowerCase())) : [];
  return (
    <Demo goal="Click the box and press any shortcut" done={done} wide>
      <div className="tu-ev2">
        <div className="tu-kt" tabIndex={0} onKeyDown={(e) => {
          const c = chordOf(e);
          if (!c) return;
          if (!/^Ctrl\+[TWNR]$/.test(c)) e.preventDefault();
          setPressed(c);
          if (allKeys.some((x) => chordsOf(x.k).includes(c.toLowerCase()))) onDone();
        }}>
          {!pressed ? <span className="tu-kt-ask">Click here, then press a shortcut, like <Keys k="Ctrl+J" /> or <Keys k="Alt+S" /></span> : (
            <>
              <div className="tu-kt-k"><Keys k={pressed} /></div>
              {found.length
                ? <ul>{found.map((f, i) => <li key={i}><b>{f.tool}</b> {f.what}</li>)}</ul>
                : <p className="tu-empty">No tool uses that one.</p>}
            </>
          )}
        </div>
        <div className="tu-fit">
          <div className="tu-fit-h"><span className="mono">A banner that fits</span><input type="range" min={300} max={760} value={width} onChange={(e) => setWidth(+e.target.value)} aria-label="Banner width" /></div>
          <div className="tu-minibar bar" ref={bar} style={{ width }}>
            <span className="brand mono">Flow</span>
            <span className="tu-gap" />
            <button type="button" className="btn"><Ico n="command" /><span className="lbl">Commands</span></button>
            <button type="button" className="btn"><Ico n="cards" /><span className="lbl">Evidence ↗</span></button>
            <button type="button" className="btn"><Ico n="history" /><span className="lbl">Past flows</span></button>
            <button type="button" className="btn icoonly"><Ico n="full" /></button>
            <button type="button" className="btn icoonly"><Ico n="pop" /></button>
            <button type="button" className="btn icoonly"><Ico n="split" /></button>
            <button type="button" className="btn"><Ico n="drawer" /><span className="lbl">Drawer</span></button>
          </div>
          <p className="tu-hint">Drag the slider: when the words stop fitting, they turn into icons, with each name in its tooltip.</p>
        </div>
      </div>
    </Demo>
  );
}
