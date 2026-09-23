"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import DocFormat from "./DocFormat";
import "./evidence.css";

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

export default function Evidence() {
  const ref = useRef<HTMLDivElement>(null);
  const engine = useRef<any>(null);
  const [side, setSide] = useState(DEFAULT_SIDE);
  const [docW, setDocW] = useState(DEFAULT_DOC);
  const [doc, setDoc] = useState(true);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let off: (() => void) | undefined;
    let dead = false;
    // The engine reaches for IndexedDB and the clipboard the moment it starts,
    // so it is imported in the browser rather than rendered on the server.
    import("@/lib/evidence/engine").then((m: any) => {
      if (dead) return;
      engine.current = m;
      off = m.boot(el);
    });
    return () => { dead = true; if (off) off(); };
  }, []);

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
      <header className="bar">
        <Link className="back mono" href="/tools" title="Back to the tools">←</Link>
        <div className="brand mono">Evidence</div>
        <div className="stat" id="stat" />
        <div className="spacer" />
        <button className="btn" data-act="import">Import</button>
        <button className="btn" data-act="case">Case</button>
        <button className="btn" data-act="export">Export</button>
        <button className="btn" data-act="settings">Settings</button>
        <button className={"btn docbtn" + (doc ? " on" : "")} onClick={toggleDoc}
          aria-expanded={doc} title="Show the document as it will paste">
          <span id="doclabel">Send doc</span> {doc ? "›" : "‹"}
        </button>
      </header>

      <div className="panes">
        <section className="pane left">
          <div className="searchwrap">
            <span className="slash">/</span>
            <input id="q" type="text" placeholder="search evidence" autoComplete="off" spellCheck={false} />
            <span className="searchmeta mono" id="searchmeta" />
          </div>
          <div className="indexhead mono">
            <i className="c1">Trigger</i>
            <i className="c2">Block</i>
            <i className="c3">Cards <button className="link" data-act="groups">Fold all</button></i>
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
          <DocFormat host={ref} />
          <div id="docbody" />
        </aside>
      </div>

      <div className="foothint mono">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>→</kbd> arguments</span>
        <span><kbd>↵</kbd> copy + send</span>
        <span><kbd>esc</kbd> clear</span>
        <span><kbd>del</kbd> remove from library</span>
        <span className="drift">drag a sent block to reorder it · type in the document to edit it</span>
      </div>

      <div className="veil" id="veil"><div className="card" id="card" /></div>
      <div className="toast" id="toast" />
      <div id="clipstage" contentEditable suppressContentEditableWarning />
    </div>
  );
}
