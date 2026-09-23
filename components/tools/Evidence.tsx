"use client";

import { useEffect, useRef } from "react";
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
 * What React does own is the mount. `boot` is handed this element and returns
 * the function that unbinds it, so leaving the page leaves nothing listening.
 */
export default function Evidence() {
  const ref = useRef<HTMLDivElement>(null);

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

  return (
    <div className="evi" ref={ref}>
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
      </div>

      <div className="veil" id="veil"><div className="card" id="card" /></div>
      <div className="toast" id="toast" />
      <div id="clipstage" contentEditable suppressContentEditableWarning />
    </div>
  );
}
