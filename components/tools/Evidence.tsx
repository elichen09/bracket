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
const DOCW_KEY = "evidence.docw";
const MIN_SIDE = 300, MAX_SIDE = 820, DEFAULT_SIDE = 420;
const MIN_DOC = 320, MAX_DOC = 900, DEFAULT_DOC = 460;

export default function Evidence({ owner, me, room }: { owner?: string; me?: string; room?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const engine = useRef<any>(null);
  const bar = useRef<HTMLElement>(null);
  useFitBar(bar);
  const [side, setSide] = useState(DEFAULT_SIDE);
  const [docW, setDocW] = useState(DEFAULT_DOC);
  const [doc, setDoc] = useState(true);
  const [dragging, setDragging] = useState(false);

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
      const open = localStorage.getItem(DOC_KEY);
      if (open !== null) setDoc(open === "1");
      else if (window.innerWidth < 1400) setDoc(false);   // no room to spare
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
      if (which === "doc") {
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
      if (which === "doc") setDocW((w) => { remember(DOCW_KEY, String(Math.round(w))); return w; });
      else setSide((w) => { remember(SIDE_KEY, String(Math.round(w))); return w; });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }, [doc, docW]);

  const nudge = (which: "side" | "doc") => (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = (e.shiftKey ? 60 : 20) * (e.key === "ArrowLeft" ? 1 : -1);
    if (which === "doc") setDocW((w) => {
      const n = Math.min(MAX_DOC, Math.max(MIN_DOC, w + step)); remember(DOCW_KEY, String(Math.round(n))); return n;
    });
    else setSide((w) => {
      const n = Math.min(MAX_SIDE, Math.max(MIN_SIDE, w + step)); remember(SIDE_KEY, String(Math.round(n))); return n;
    });
  };

  // Opening the panel has to fill it: the engine only redraws it when the send
  // list changes, and it may not have changed since the panel was closed.
  const toggleDoc = () => setDoc((was) => {
    const now = !was;
    remember(DOC_KEY, now ? "1" : "0");
    if (now) setTimeout(() => engine.current?.renderDoc?.(), 0);
    return now;
  });

  return (
    <div className={"evi" + (dragging ? " resizing" : "") + (doc ? " withdoc" : "")} ref={ref}
      style={{
        ["--evi-side" as any]: `${Math.round(side)}px`,
        ["--evi-doc" as any]: `${Math.round(docW)}px`,
        // The page is drawn at its real 816px and zoomed to fit whatever the
        // panel has been dragged to, so the line breaks are the real ones.
        ["--evi-docscale" as any]: Math.max(0.3, Math.min(1.1, (docW - 34) / 816)).toFixed(3),
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
        <a className="btn splitlink" href="/tools/split" title="Evidence and Flow side by side"><Ico n="split" /><span className="lbl">Split ◫</span></a>
        {/* Share the send doc into a flow room, for a partner flowing on another computer. */}
        <button className="btn roombtn" data-act="room" title="Share the send doc with your partner's flow">
          <span className="dot" id="roomdot" /><span className="lbl" id="roomstate">Room</span>
        </button>
        <ThemePicker />
        <button className={"btn docbtn" + (doc ? " on" : "")} onClick={toggleDoc}
          aria-expanded={doc} title="Show the document as it will paste">
          <Ico n="doc" /><span className="lbl" id="doclabel">Send doc</span> {doc ? "›" : "‹"}
        </button>
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
        </section>

        <div className="grab" role="separator" aria-orientation="vertical" aria-label="Resize the send list"
          tabIndex={0} onPointerDown={grab("side")} onKeyDown={nudge("side")}><i /></div>

        <aside className="pane right">
          <div className="tabs mono">
            <button data-tab="send" className="on">Send <span className="count" id="sendCount" /></button>
            <button data-tab="read">Read</button>
          </div>
          <div className="sideacts" id="sideacts" />
          <div id="sidebody" />
        </aside>

        {doc && (
          <div className="grab" role="separator" aria-orientation="vertical" aria-label="Resize the document"
            tabIndex={0} onPointerDown={grab("doc")} onKeyDown={nudge("doc")}><i /></div>
        )}
        <aside className="pane docpane" aria-hidden={!doc}>
          <DocEditor host={ref} width={docW} owner={owner} />
        </aside>
      </div>

      <div className="foothint mono">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>→</kbd> arguments</span>
        <span><kbd>Enter</kbd> copy + send</span>
        <span><kbd>esc</kbd> clear</span>
        <span className="libonly"><kbd>del</kbd> remove from library</span>
        <span className="drift">drag a sent block to reorder it · type in the document to edit it</span>
      </div>

      <div className="veil" id="veil"><div className="card" id="card" /></div>
      <div className="toast" id="toast" />
      <div id="clipstage" contentEditable suppressContentEditableWarning />
    </div>
  );
}
