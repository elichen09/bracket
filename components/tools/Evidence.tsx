"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * What React does own is the mount and the divider between the two panes.
 * `boot` is handed this element and returns the function that unbinds it, so
 * leaving the page leaves nothing listening.
 */

const SIDE_KEY = "evidence.side";
const MIN_SIDE = 300;
const MAX_SIDE = 820;
const DEFAULT_SIDE = 440;

export default function Evidence() {
  const ref = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState(DEFAULT_SIDE);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let off: (() => void) | undefined;
    let dead = false;
    // The engine reaches for IndexedDB and the clipboard the moment it starts,
    // so it is imported in the browser rather than rendered on the server.
    import("@/lib/evidence/engine").then((m: any) => {
      if (!dead) off = m.boot(el);
    });
    return () => { dead = true; if (off) off(); };
  }, []);

  // How wide the send pane was left last time. Read after mount so the server
  // and the first paint agree on the default.
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(SIDE_KEY));
      if (saved >= MIN_SIDE && saved <= MAX_SIDE) setSide(saved);
    } catch { /* private browsing */ }
  }, []);

  /**
   * Drag the divider. The width is written to a CSS variable rather than to
   * the pane, because the keyboard hint strip at the foot has to stop at the
   * same line, and one variable keeps the two honest.
   */
  const onGrab = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const host = ref.current;
    if (!host) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);

    const move = (ev: PointerEvent) => {
      const right = host.getBoundingClientRect().right;
      setSide(Math.min(MAX_SIDE, Math.max(MIN_SIDE, right - ev.clientX)));
    };
    const up = () => {
      setDragging(false);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      setSide((w) => { try { localStorage.setItem(SIDE_KEY, String(Math.round(w))); } catch {} return w; });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }, []);

  const nudge = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 60 : 20;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setSide((w) => {
      const next = Math.min(MAX_SIDE, Math.max(MIN_SIDE, w + (e.key === "ArrowLeft" ? step : -step)));
      try { localStorage.setItem(SIDE_KEY, String(Math.round(next))); } catch {}
      return next;
    });
  };

  return (
    <div className={"evi" + (dragging ? " resizing" : "")} ref={ref}
      style={{ ["--evi-side" as any]: `${Math.round(side)}px` }}>
      <header className="bar">
        <div className="brand mono">Evidence</div>
        <div className="stat" id="stat" />
        <div className="spacer" />
        <button className="btn" data-act="import">Import</button>
        <button className="btn" data-act="case">Case</button>
        <button className="btn" data-act="export">Export</button>
        <button className="btn" data-act="settings">Settings</button>
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

        <div className="grab" role="separator" aria-orientation="vertical" aria-label="Resize the send pane"
          tabIndex={0} onPointerDown={onGrab} onKeyDown={nudge}><i /></div>

        <aside className="pane right">
          <div className="tabs mono">
            <button data-tab="send" className="on">Send <span className="count" id="sendCount" /></button>
            <button data-tab="read">Read</button>
          </div>
          <div className="sideacts" id="sideacts" />
          <div id="sidebody" />
        </aside>
      </div>

      <div className="foothint mono">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>→</kbd> arguments</span>
        <span><kbd>↵</kbd> copy + send</span>
        <span><kbd>esc</kbd> clear</span>
        <span><kbd>del</kbd> remove from library</span>
        <span className="drift">drag a sent block to reorder it</span>
      </div>

      <div className="veil" id="veil"><div className="card" id="card" /></div>
      <div className="toast" id="toast" />
      <div id="clipstage" contentEditable suppressContentEditableWarning />
    </div>
  );
}
