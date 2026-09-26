"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import DocEditor from "./DocEditor";
import { polish } from "@/lib/evidence/polish";
import "./evidence.css";
import "./finish.css";
import ThemePicker from "./ThemePicker";
import Ico from "./Ico";
import { useFitBar } from "./fitBar";
import FullBtn, { useFullscreen } from "./FullBtn";
import PopBtn from "./PopBtn";
import { markHop } from "@/lib/toolsHop";

/**
 * Evidence, mounted.
 *
 * React renders the shell once and then keeps out of the way: everything
 * inside is drawn by the engine, which owns its own DOM the way it always
 * did. That is deliberate rather than lazy — the engine is a working tool
 * with a parser, a search and a store behind it, and rewriting it as
 * components would risk all of that to gain nothing a user would ever see.
 *
 * What React owns is the mount and the furniture: the two dividers and
 * whether the document panel is open. `boot` is handed this element and
 * returns the function that unbinds it, so leaving leaves nothing listening.
 *
 * There is no page header above this. The tool fills the window under the
 * site's nav, because a band of explanation is dead space in something you
 * work in for an hour; the back link and what it is live in its own toolbar.
 */

const SIDE_KEY = "evidence.side";
const DOC_KEY = "evidence.doc";
/** Which of the three show — kept apart for the split view, which wants its own. */
const PANES_KEY = "evidence.panes";
const HINTS_KEY = "evidence.hints";
const DOCW_KEY = "evidence.docw";
const MIN_SIDE = 300, MAX_SIDE = 820, DEFAULT_SIDE = 420;
const MIN_DOC = 320, MAX_DOC = 900, DEFAULT_DOC = 460;

export default function Evidence({ owner, me, room }: { owner?: string; me?: string; room?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const engine = useRef<any>(null);
  const bar = useRef<HTMLElement>(null);
  useFitBar(bar);
  const fs = useFullscreen(ref);
  const [side, setSide] = useState(DEFAULT_SIDE);
  const [docW, setDocW] = useState(DEFAULT_DOC);
  // Search, the send list, the document: each can be put away, any two or
  // one of them left — the send doc alone beside Flow, say. One always stays.
  const [show, setShow] = useState({ search: true, list: true, doc: true });
  const doc = show.doc;
  const [dragging, setDragging] = useState(false);
  const [hintsShut, setHintsShut] = useState(false);
  const panesKey = useRef(PANES_KEY);
  // the document's real width: it is the one that stretches when search is away
  const docPane = useRef<HTMLElement>(null);
  const [docReal, setDocReal] = useState(DEFAULT_DOC);
  useEffect(() => {
    const el = docPane.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (el.clientWidth) setDocReal(el.clientWidth); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let off: (() => void) | undefined;
    let dead = false;
    // The ripples and the flight of a sent card. It listens on the root and
    // owns nothing, so it can go on before the engine has finished loading.
    const unpolish = polish(el);
    // The engine reaches for IndexedDB and the clipboard the moment it starts,
    // so it is imported in the browser rather than rendered on the server.
    import("@/lib/evidence/engine").then((m: any) => {
      if (dead) return;
      engine.current = m;
      // Whose library: the engine opens this account's database, not a shared one.
      off = m.boot(el, { owner, me, room });
    });
    return () => { dead = true; unpolish(); if (off) off(); };
  }, [owner, me, room]);

  // How it was left last time. Read after mount so the server and the first
  // paint agree on the defaults.
  useEffect(() => {
    try {
      const s = Number(localStorage.getItem(SIDE_KEY));
      if (s >= MIN_SIDE && s <= MAX_SIDE) setSide(s);
      const w = Number(localStorage.getItem(DOCW_KEY));
      if (w >= MIN_DOC && w <= MAX_DOC) setDocW(w);
      if (localStorage.getItem(HINTS_KEY) === "1") setHintsShut(true);
      if (window.self !== window.top) panesKey.current = PANES_KEY + ".split";
      const kept = JSON.parse(localStorage.getItem(panesKey.current) || "null");
      if (kept && (kept.search || kept.list || kept.doc)) setShow({ search: !!kept.search, list: !!kept.list, doc: !!kept.doc });
      else {
        const open = localStorage.getItem(DOC_KEY);
        if (open !== null) setShow((s) => ({ ...s, doc: open === "1" }));
        else if (window.innerWidth < 1400) setShow((s) => ({ ...s, doc: false }));   // no room to spare
      }
    } catch { /* private browsing */ }
  }, []);

  const remember = (key: string, value: string) => {
    try { localStorage.setItem(key, value); } catch { /* private browsing */ }
  };

  /**
   * Drag a divider. Widths are written to CSS variables rather than to the
   * panes, because the keyboard hint strip at the foot has to stop at the same
   * line, and one variable keeps them honest.
   */
  const grab = useCallback((which: "side" | "doc") => (e: React.PointerEvent<HTMLDivElement>) => {
    const host = ref.current;
    if (!host) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);

    const move = (ev: PointerEvent) => {
      const box = host.getBoundingClientRect();
      // with search away the send list sits at the left edge, and the line after
      // it (whichever that is) sets its width from there
      if (!show.search && show.list) {
        setSide(Math.min(MAX_SIDE, Math.max(MIN_SIDE, ev.clientX - box.left)));
      } else if (which === "doc") {
        setDocW(Math.min(MAX_DOC, Math.max(MIN_DOC, box.right - ev.clientX)));
      } else {
        // the send pane is measured from the document panel's left edge
        const rightOf = doc ? docW + 9 : 0;
        setSide(Math.min(MAX_SIDE, Math.max(MIN_SIDE, box.right - rightOf - ev.clientX)));
      }
    };
    const up = () => {
      setDragging(false);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      if (which === "doc" && show.search) setDocW((w) => { remember(DOCW_KEY, String(Math.round(w))); return w; });
      else setSide((w) => { remember(SIDE_KEY, String(Math.round(w))); return w; });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }, [doc, docW, show]);

  const nudge = (which: "side" | "doc") => (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = (e.shiftKey ? 60 : 20) * (e.key === "ArrowLeft" ? 1 : -1);
    // measured from the left, the send list grows to the right
    if (!show.search && show.list) setSide((w) => {
      const n = Math.min(MAX_SIDE, Math.max(MIN_SIDE, w - step)); remember(SIDE_KEY, String(Math.round(n))); return n;
    });
    else if (which === "doc") setDocW((w) => {
      const n = Math.min(MAX_DOC, Math.max(MIN_DOC, w + step)); remember(DOCW_KEY, String(Math.round(n))); return n;
    });
    else setSide((w) => {
      const n = Math.min(MAX_SIDE, Math.max(MIN_SIDE, w + step)); remember(SIDE_KEY, String(Math.round(n))); return n;
    });
  };

  // Put a part away or bring it back. Opening the document has to fill it: the
  // engine only redraws it when the send list changes, and it may not have
  // changed since the panel was closed.
  const toggle = useCallback((k: "search" | "list" | "doc") => {
    setShow((s) => {
      const n = { ...s, [k]: !s[k] };
      if (!n.search && !n.list && !n.doc) return s;            // one always stays
      remember(panesKey.current, JSON.stringify(n));
      if (k === "doc" && n.doc) setTimeout(() => engine.current?.renderDoc?.(), 0);
      if (k === "search" && n.search) setTimeout(() => (document.getElementById("q") as HTMLInputElement | null)?.focus(), 0);
      return n;
    });
  }, []);
  // Alt+1, Alt+2, Alt+3: search, the send list, the document
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const k = ({ Digit1: "search", Digit2: "list", Digit3: "doc" } as const)[e.code as "Digit1" | "Digit2" | "Digit3"];
      if (!k) return;
      e.preventDefault();
      toggle(k);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [toggle]);

  return (
    <div className={"evi" + (dragging ? " resizing" : "") + (doc ? " withdoc" : "") + (show.search ? "" : " nosearch") + (show.list ? "" : " nolist")} ref={ref}
      style={{
        ["--evi-side" as any]: `${Math.round(side)}px`,
        ["--evi-doc" as any]: `${Math.round(docW)}px`,
        // The page is drawn at its real 816px and zoomed to fit whatever the
        // panel has been dragged to, so the line breaks are the real ones.
        ["--evi-docscale" as any]: Math.max(0.3, Math.min(1.1, (docReal - 34) / 816)).toFixed(3),
      }}>
      <header className="bar" ref={bar}>
        <Link className="back mono" href="/tools" title="Back to the tools">←</Link>
        <div className="brand mono">Evidence</div>
        <div className="stat" id="stat" />
        <div className="spacer" />
        <button className="btn" data-act="import" title="Import"><Ico n="import" /><span className="lbl">Import</span></button>
        <button className="btn" data-act="case" title="Case"><Ico n="case" /><span className="lbl">Case</span></button>
        <button className="btn" data-act="export" title="Export"><Ico n="export" /><span className="lbl">Export</span></button>
        <button className="btn" data-act="settings" title="Settings"><Ico n="settings" /><span className="lbl">Settings</span></button>
        {/* Its own tab, reused: the two tools talk across tabs, and the send
            list Flow writes into is this one. */}
        <a className="btn nosplit" href="/tools/flow" target="break-flow" title="Open Flow in its own tab"><Ico n="grid" /><span className="lbl">Flow ↗</span></a>
        <FullBtn className="btn" full={fs.full} toggle={fs.toggle} />
        <PopBtn className="btn" view="send" />
        <a className="btn splitlink icoonly" aria-label="Split screen" href="/tools/split?a=evidence" onClick={markHop} title="Split screen — Evidence beside another tool"><Ico n="split" /><span className="lbl">Split ◫</span></a>
        {/* Share the send doc into a flow room, for a partner flowing on another computer. */}
        <button className="btn roombtn" data-act="room" title="Share the send doc with your partner's flow">
          <span className="dot" id="roomdot" /><span className="lbl" id="roomstate">Room</span>
        </button>
        <ThemePicker />
        {/* what is on screen: any of the three, any two, or one alone */}
        <div className="panesw" role="group" aria-label="Show">
          <button type="button" className={"btn pv" + (show.search ? " on" : "")} aria-pressed={show.search} onClick={() => toggle("search")} title="Search — Alt+1">
            <Ico n="search" /><span className="lbl">Search</span>
          </button>
          <button type="button" className={"btn pv" + (show.list ? " on" : "")} aria-pressed={show.list} onClick={() => toggle("list")} title="The send list — Alt+2">
            <Ico n="list" /><span className="lbl">Send list</span>
          </button>
          <button type="button" className={"btn pv" + (doc ? " on" : "")} aria-pressed={doc} onClick={() => toggle("doc")} title="The document as it will paste — Alt+3">
            <Ico n="doc" /><span className="lbl" id="doclabel">Send doc</span>
          </button>
        </div>
      </header>

      <div className="panes">
        <section className="pane left">
          {/* where the search looks: your library, or this season's caselist wikis */}
          <div className="srcsw mono" id="srcsw" role="group" aria-label="Search in">
            <button type="button" data-src="lib" className="on" aria-pressed="true">Library</button>
            <button type="button" data-src="cl" aria-pressed="false">Caselist</button>
          </div>
          <div className="searchwrap">
            <span className="slash">/</span>
            <input id="q" type="text" placeholder="search evidence" autoComplete="off" spellCheck={false} />
            <span className="searchmeta mono" id="searchmeta" />
          </div>
          {/* the bins this round searches — the engine draws them */}
          <div className="binbar" id="binbar" hidden />
          <div className="indexhead mono">
            <i>Outline</i>
            <i className="c3"><button className="link" data-act="groups">Fold all</button></i>
          </div>
          <div id="results" />
          {/* the keys, for the search they belong to — one line when the pane is narrow, and yours to put away */}
          <div className={"foothint mono" + (hintsShut ? " shut" : "")}>
            {!hintsShut && (
              <>
                <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
                <span><kbd>→</kbd> arguments</span>
                <span><kbd>Enter</kbd> copy + send</span>
                <span><kbd>esc</kbd> clear</span>
                <span className="libonly"><kbd>del</kbd> remove from library</span>
                <span className="drift">drag a sent block to reorder it · type in the document to edit it</span>
              </>
            )}
            <button type="button" className="hintx" onClick={() => setHintsShut((s) => { remember(HINTS_KEY, s ? "0" : "1"); return !s; })}
              title={hintsShut ? "Show the keys" : "Put the keys away"} aria-label={hintsShut ? "Show the keys" : "Put the keys away"}>
              {hintsShut ? "keys" : "×"}
            </button>
          </div>
        </section>

        {show.search && show.list && (
          <div className="grab" role="separator" aria-orientation="vertical" aria-label="Resize the send list"
            tabIndex={0} onPointerDown={grab("side")} onKeyDown={nudge("side")}><i /></div>
        )}

        <aside className="pane right">
          <div className="tabs mono">
            <button data-tab="send" className="on">Send <span className="count" id="sendCount" /></button>
            <button data-tab="read">Read</button>
          </div>
          <div className="sideacts" id="sideacts" />
          <div id="sidebody" />
        </aside>

        {doc && (show.search || show.list) && (
          <div className="grab" role="separator" aria-orientation="vertical" aria-label="Resize the document"
            tabIndex={0} onPointerDown={grab("doc")} onKeyDown={nudge("doc")}><i /></div>
        )}
        <aside className="pane docpane" aria-hidden={!doc} ref={docPane}>
          <DocEditor host={ref} width={docReal} owner={owner} />
        </aside>
      </div>

      <div className="veil" id="veil"><div className="card" id="card" /></div>
      <div className="toast" id="toast" />
      <div id="clipstage" contentEditable suppressContentEditableWarning />
    </div>
  );
}
