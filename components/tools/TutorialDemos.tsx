"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Ico from "./Ico";

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

/* ================================================================ Card cutter */

const CUT_WORDS = "Heidegger would obviously concur with Socrates’ statement that the unexamined life is not worth living. Unfortunately, this statement often passes into the plethora of unpracticed platitudes that perform the task of thinking for the One.".split(" ");
type CutMark = { u?: boolean; e?: boolean; h?: boolean };

export function CutterDemo({ onDone, done }: { onDone: () => void; done: boolean }) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [marks, setMarks] = useState<Record<number, CutMark>>({});
  const [small, setSmall] = useState(false);
  const anchor = useRef<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const chord = useRef(false);
  useEffect(() => { const up = () => { anchor.current = null; }; window.addEventListener("mouseup", up); return () => window.removeEventListener("mouseup", up); }, []);
  const range = (a: number, b: number) => { const s = new Set<number>(); for (let i = Math.min(a, b); i <= Math.max(a, b); i++) s.add(i); return s; };

  const apply = useCallback((what: "u" | "e" | "h" | "clear" | "shrink" | "cut") => {
    if (what === "shrink") { setSmall((s) => !s); box.current?.focus(); return; }
    if (!sel.size) return;
    setMarks((m) => {
      const n = { ...m };
      if (what === "cut") {
        // plain → cut → emphasis → plain, like the cutter's Ctrl+Alt
        const cutAll = [...sel].every((i) => n[i]?.u || n[i]?.e), emphAll = [...sel].every((i) => n[i]?.e);
        for (const i of sel) {
          if (emphAll) { const c = { ...n[i] }; delete c.u; delete c.e; n[i] = c; }
          else n[i] = { ...n[i], u: true, ...(cutAll ? { e: true } : {}) };
        }
        return n;
      }
      const all = what !== "clear" && [...sel].every((i) => (what === "e" ? n[i]?.e : n[i]?.[what]));
      for (const i of sel) {
        const c: CutMark = { ...n[i] };
        if (what === "clear") { delete n[i]; continue; }
        if (what === "e") { c.e = !all; if (!all) c.u = true; }
        else c[what] = !all;
        n[i] = c;
      }
      return n;
    });
    box.current?.focus();
  }, [sel]);

  const under = Object.values(marks).filter((m) => m.u || m.e).length;
  const lit = Object.values(marks).filter((m) => m.h).length;
  useEffect(() => { if (under >= 3 && lit >= 2 && !done) onDone(); }, [under, lit, done, onDone]);

  const onKey = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    // Ctrl+Alt alone is cut: it counts when let go (onKeyUp), unless another key came first
    if ((e.key === "Control" && e.altKey) || (e.key === "Alt" && ctrl)) { chord.current = true; return; }
    if (e.key !== "Control" && e.key !== "Alt") chord.current = false;
    const k = ctrl && e.shiftKey && e.code === "Space" ? "e" : e.altKey && e.code === "KeyZ" ? "h"
      : ctrl && e.code === "KeyN" ? "shrink" : ctrl && e.code === "Backslash" ? "clear" : null;
    if (!k) return;
    e.preventDefault();
    apply(k);
  };

  return (
    <Demo goal="Cut the card: underline what matters, then highlight what you'll read" done={done}
      onReset={() => { setSel(new Set()); setMarks({}); setSmall(false); }}>
      <div className="tu-vw" ref={box} tabIndex={0} onKeyDown={onKey} style={{ outline: "none" }}
        onKeyUp={(e) => {
          if (!chord.current || (e.key !== "Control" && e.key !== "Alt")) return;
          chord.current = false; e.preventDefault();
          apply("cut");
        }}>
        <div className="tu-vw-bar">
          <button type="button" className="tu-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => apply("cut")}><Keys k="Ctrl+Alt" /> Cut</button>
          <button type="button" className="tu-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => apply("e")}><Keys k="Ctrl+Shift+Space" /> Emphasis</button>
          <button type="button" className="tu-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => apply("h")}><Keys k="Alt+Z" /> Highlight</button>
          <button type="button" className={"tu-chip" + (small ? " on" : "")} onMouseDown={(e) => e.preventDefault()} onClick={() => apply("shrink")}><Keys k="Ctrl+N" /> Shrink</button>
          <button type="button" className="tu-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => apply("clear")}><Keys k="Ctrl+\\" /> Clear</button>
        </div>
        <div className="tu-vw-card tu-ct">
          <h5>The unexamined life is not worth living</h5>
          <p className="cite"><b style={{ fontSize: "14px" }}>Steele 14</b> Master of Arts in Political Science, Carleton University</p>
          <p className={"txt" + (small ? " small" : "")}>
            {CUT_WORDS.map((w, i) => {
              const m = marks[i] || {};
              const cls = [sel.has(i) ? "sel" : "", m.u || m.e ? "u" : "", m.e ? "e" : "", m.h ? "h" : ""].filter(Boolean).join(" ");
              return (
                <span key={i}>
                  <span className={cls}
                    onMouseDown={(e) => { e.preventDefault(); box.current?.focus(); anchor.current = i; setSel(new Set([i])); }}
                    onMouseEnter={(e) => { if (e.buttons === 1 && anchor.current !== null) setSel(range(anchor.current, i)); }}>{w}</span>{" "}
                </span>
              );
            })}
          </p>
        </div>
        <p className="tu-hint" aria-live="polite">
          {!sel.size ? "Drag across some words to select them (in the cutter a double-click takes one word, without the space after it)." :
            under < 3 ? "Now cut them: Ctrl+Alt (press both, let go), or the button. Underlined words are the ones you'll read from." :
            lit < 2 ? "Highlight what you'll actually say: select a few underlined words and press Alt+Z." :
            "That's a cut card. Shrink makes everything that is neither underlined nor bold small."}
        </p>
      </div>
    </Demo>
  );
}

/* ================================================================ sketches, for the pop-out's backdrop */

function Sketch({ tool }: { tool: "coda" | "speech" }) {
  if (tool === "coda") return <div className="sk sk-ev"><i className="q" /><i /><i /><i className="w" /><i /></div>;
  return <div className="sk sk-df"><i className="box" /><i className="r" /><i className="u" /><i className="r" /><i className="u" /></div>;
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
    <Demo goal="Pop their doc out (it stays on top), then drag it where you want it" done={done} onReset={() => { setOpen(false); setShown(2); setPos({ x: 58, y: 18 }); }}>
      <div className="tu-desk" ref={desk}
        onPointerMove={(e) => {
          const d = dragFrom.current, b = desk.current?.getBoundingClientRect();
          if (!d || !b) return;
          setPos({ x: Math.min(64, Math.max(0, d.px + ((e.clientX - d.x) / b.width) * 100)), y: Math.min(44, Math.max(0, d.py + ((e.clientY - d.y) / b.height) * 100)) });
        }}
        onPointerUp={() => { dragFrom.current = null; }}>
        <div className="tu-mainwin">
          <div className="tu-wbar"><i /><i /><i /><span>coda — your file and the speech doc</span>
            <button type="button" className="tu-popbtn" onClick={() => { setOpen(true); onDone(); }} title="Pop out their doc"><Ico n="pop" /></button>
          </div>
          <div className="tu-mainpanes"><div><Sketch tool="coda" /></div><div><Sketch tool="speech" /></div></div>
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
        {!open && <p className="tu-deskhint">Click <Ico n="pop" /> — in coda it's ⋯ › Pop out</p>}
      </div>
    </Demo>
  );
}

/* ================================================================ the window, toured */

/** coda's window as a sketch: each part lights, says what it is for, and counts once seen. */
const PARTS = [
  { id: "bar", name: "The bar", say: "Home, the file you're in, the one box for everything (Ctrl+Shift+K), the four views — Edit, Split, Speech, Read — and share, room, timer." },
  { id: "fmt", name: "The format bar", say: "Only what a card is cut with: the headings, Cut, Emphasis, Shrink, Highlight, Send. ⋯ has every other button. Alt+M hides it; the keys keep working." },
  { id: "side", name: "The side", say: "Four tabs: the outline of whatever the cursor is in, your files, the library search, and the round (their docs, SpeechDrop, your partner's flow)." },
  { id: "page", name: "The page", say: "The file you're cutting — or, in Split, the speech doc beside it. Every key works in whichever one has the cursor." },
  { id: "status", name: "The status line", say: "Where you are (pocket › hat › block › tag), which card, and how long what's highlighted takes to read." },
] as const;

export function WindowDemo({ onDone, done }: { onDone: () => void; done: boolean }) {
  const [at, setAt] = useState<string | null>(null);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const look = (id: string) => {
    setAt(id);
    setSeen((s) => {
      if (s.has(id)) return s;
      const n = new Set(s); n.add(id);
      if (n.size === PARTS.length) onDone();
      return n;
    });
  };
  const part = PARTS.find((p) => p.id === at);
  const P = ({ id, className, children }: { id: string; className: string; children?: React.ReactNode }) => (
    <button type="button" className={"tu-wpart " + className + (at === id ? " on" : "") + (seen.has(id) ? " seen" : "")}
      onMouseEnter={() => look(id)} onFocus={() => look(id)} onClick={() => look(id)} aria-label={PARTS.find((p) => p.id === id)?.name}>
      {children}
    </button>
  );
  return (
    <Demo goal={`Point at each part of the window (${seen.size} of ${PARTS.length})`} done={done} onReset={() => { setAt(null); setSeen(new Set()); }} wide>
      <div className="tu-win">
        <div className="tu-winframe">
          <P id="bar" className="w-bar"><b>coda</b><span className="w-file">AT: Econ</span><span className="w-box">Search, or run a command</span><span className="w-modes"><i className="on" /><i /><i /><i /></span></P>
          <P id="fmt" className="w-fmt"><span className="w-pill">Pocket Hat Block Tag Cite</span><span className="w-pill">Cut Emph Highlight</span><span className="w-pill send">Send</span></P>
          <div className="w-body">
            <P id="side" className="w-side"><i /><i /><i /><i /><i /><i /></P>
            <P id="page" className="w-page"><i className="t" /><i className="c" /><i /><i className="h" /><i /><i className="t" /><i className="c" /><i /></P>
          </div>
          <P id="status" className="w-status"><span>AT: Econ › Growth is resilient</span><span>Card 2 of 6 · 1:12</span></P>
        </div>
        <div className="tu-winsay" aria-live="polite">
          {part ? <><b>{part.name}</b><p>{part.say}</p></> : <p className="tu-hint">Point at a part of the window — the bar, the format bar, the side, the page, the status line.</p>}
          <div className="tu-wdots" aria-hidden="true">{PARTS.map((p) => <i key={p.id} className={seen.has(p.id) ? "on" : ""} />)}</div>
        </div>
      </div>
    </Demo>
  );
}

/* ================================================================ the command menu */

const PAL_CMDS = [
  { label: "Search the library", key: "Alt+/", say: "The side's Search tab opens with the cursor in it." },
  { label: "Speech doc beside", key: "Alt+B", say: "Split: your file on the left, the speech doc on the right." },
  { label: "Flow", key: "Alt+Shift+R", say: "Your flow of the round, a column per speech." },
  { label: "Reformat", key: "Alt+Shift+W", say: "Cards cut anywhere now look cut here." },
  { label: "Condense", key: "Alt+Q", say: "The card's paragraphs, joined into one." },
  { label: "Tags only", key: "Alt+H", say: "Every card folded to its tag, to reorder the doc." },
  { label: "Layout: Deck", key: "", say: "One page at a time, in tabs." },
  { label: "Colours: Ink", key: "", say: "coda's own: near-black, ivory." },
  { label: "Speech timer", key: "Alt+T", say: "A clock for the speech, prep or cross-ex." },
  { label: "New file", key: "Alt+Shift+N", say: "An empty file, ready to cut into." },
];

export function PaletteDemo({ onDone, done }: { onDone: () => void; done: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [ran, setRan] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length ? PAL_CMDS.filter((c) => words.every((w) => c.label.toLowerCase().includes(w))) : PAL_CMDS.slice(0, 5);
  const rows = q.trim() && !hits.length ? [{ label: `Search the library for “${q.trim()}”`, key: "Enter", say: "Nothing by that name, so it searches: the library opens with those words in it." }] : hits;
  const run = (c: { label: string; say: string }) => { setRan(c.label + " — " + c.say); setOpen(false); setQ(""); setSel(0); onDone(); };
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  return (
    <Demo goal="Open the command menu, type a few letters, press Enter" done={done} onReset={() => { setOpen(false); setQ(""); setRan(null); }}>
      <div className="tu-paldesk" tabIndex={0}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyK") { e.preventDefault(); setOpen((o) => !o); } }}>
        <div className="tu-palbar"><b>coda</b><button type="button" className="tu-palbox" onClick={() => setOpen(true)}>Search, or run a command <Keys k="Ctrl+Shift+K" /></button></div>
        {ran && !open && <p className="tu-palran"><i aria-hidden="true">✓</i>{ran}</p>}
        {!ran && !open && <p className="tu-hint">Click the box, or click here and press <Keys k="Ctrl+Shift+K" />.</p>}
        {open && (
          <div className="tu-pal" role="dialog" aria-label="Command menu">
            <input ref={input} value={q} placeholder="Try “read”, “reformat”, or “econ”…" spellCheck={false}
              onChange={(e) => { setQ(e.target.value); setSel(0); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setSel((n) => Math.min(rows.length - 1, n + 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setSel((n) => Math.max(0, n - 1)); }
                if (e.key === "Enter") { e.preventDefault(); const c = rows[sel]; if (c) run(c); }
                if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
              }} />
            <ul>
              {rows.map((c, i) => (
                <li key={c.label} className={i === sel ? "on" : ""} onMouseMove={() => setSel(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => run(c)}>
                  <span>{c.label}</span>{c.key && <Keys k={c.key} />}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Demo>
  );
}

/* ================================================================ every key, by pressing it */

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

export function KeyDemo({ onDone, done, allKeys }: { onDone: () => void; done: boolean; allKeys: { tool: string; k: string; what: string }[] }) {
  const [pressed, setPressed] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const found = pressed ? allKeys.filter((x) => chordsOf(x.k).includes(pressed.toLowerCase())) : [];
  return (
    <Demo goal="Click the box and press any shortcut" done={done} wide>
      <div className="tu-kt" tabIndex={0} onKeyDown={(e) => {
        const c = chordOf(e);
        if (!c) return;
        if (!/^Ctrl\+[TWNR]$/.test(c)) e.preventDefault();
        setPressed(c); setN((x) => x + 1);
        if (allKeys.some((x) => chordsOf(x.k).includes(c.toLowerCase()))) onDone();
      }}>
        {!pressed ? <span className="tu-kt-ask">Click here, then press a shortcut — try <Keys k="Alt+Enter" /> or <Keys k="Alt+4" /></span> : (
          <>
            <div className="tu-kt-k" key={n}><Keys k={pressed} /></div>
            {found.length
              ? <ul>{found.map((f, i) => <li key={i}><b>{f.tool}</b> {f.what}</li>)}</ul>
              : <p className="tu-empty">coda doesn&apos;t use that one — Keys can give it to anything.</p>}
          </>
        )}
      </div>
    </Demo>
  );
}
