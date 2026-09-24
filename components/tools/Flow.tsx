"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { polish } from "@/lib/evidence/polish";
import "./flow.css";

/**
 * Flow, mounted.
 *
 * Same bargain as Evidence: React renders this shell once and then keeps out
 * of the way, because a round is typed at speed and a component tree that
 * re-renders on every keystroke is the one thing a flow cannot afford. The
 * engine is handed this element and owns everything inside it.
 *
 * Everything here is markup the engine fills: the grid, the tabs, the clock's
 * numbers, the drawer's panes, the palette and the share room.
 */
export default function Flow({ join, owner, me }: { join?: string; owner?: string; me?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let off: (() => void) | undefined;
    let dead = false;
    const unpolish = polish(el);
    import("@/lib/flow/engine").then((m: any) => {
      if (dead) return;
      // Whose flow, and the name a partner sees on your cursor by default.
      off = m.boot(el, { join, owner, me });
    });
    return () => { dead = true; unpolish(); if (off) off(); };
  }, [join, owner, me]);

  return (
    <div className="flw" ref={ref}>
      <header className="topbar">
        <Link className="back mono" href="/tools" title="Back to the tools">←</Link>
        <div className="brand mono">Flow</div>
        <div className="crumb mono"><span id="crumb">Sheet</span></div>

        <div className="tbar" id="tbar" role="group" aria-label="Speech clock">
          <span className="dot" aria-hidden="true" />
          <button type="button" id="t-prev" aria-label="The speech before">‹</button>
          <button type="button" className="sp" id="t-sp" title="The next speech">PRO CASE</button>
          <button type="button" id="t-next" aria-label="The speech after">›</button>
          <span className="tm" id="t-tm">4:00</span>
          <button type="button" className="play" id="t-go" aria-label="Start the clock">▶</button>
          <button type="button" id="t-rs" aria-label="Put this speech back to full time">↺</button>
        </div>

        <div className="prep">
          <button type="button" id="prep-pro" aria-pressed="false">Pro prep 3:00</button>
          <button type="button" id="prep-con" aria-pressed="false">Con prep 3:00</button>
        </div>

        <div className="spacer" />
        <button className="btn" id="share-btn" aria-pressed="false" title="Flow with your partner">
          <span className="dot" id="share-dot" /><span id="share-state">Not shared</span>
        </button>
        <button className="btn" id="drawer-btn" aria-pressed="false">Notes <kbd>J</kbd></button>
      </header>

      <div className="panes" id="panes">
        <section className="pw active" data-p="0">
          <div className="phead">
            <span className="pn">A</span>
            <select className="psheet" aria-label="Sheet on screen A" />
            <span className="pside" />
            <span className="pact">writing here</span>
            <button type="button" className="pclose" aria-label="Close this screen">×</button>
          </div>
          <div className="flow" tabIndex={0} aria-label="Flow, screen A. Type to write in the selected cell.">
            <div className="grid" />
            <div className="cursor" aria-hidden="true"><span className="lab" /></div>
            <button className="hx" type="button" tabIndex={-1} aria-label="Clear this cell">×</button>
            <div className="dropline" hidden />
          </div>
        </section>

        <section className="pw" data-p="1" hidden>
          <div className="phead">
            <span className="pn">B</span>
            <select className="psheet" aria-label="Sheet on screen B" />
            <span className="pside" />
            <span className="pact">writing here</span>
            <button type="button" className="pclose" aria-label="Close this screen">×</button>
          </div>
          <div className="flow" tabIndex={0} aria-label="Flow, screen B. Type to write in the selected cell.">
            <div className="grid" />
            <div className="cursor" aria-hidden="true"><span className="lab" /></div>
            <button className="hx" type="button" tabIndex={-1} aria-label="Clear this cell">×</button>
            <div className="dropline" hidden />
          </div>
        </section>

        <aside className="drawer" id="drawer" aria-label="Notes, cards and roadmap">
          <div className="dtabs" role="tablist">
            <button type="button" role="tab" aria-selected="true" data-p="notes">Notes</button>
            <button type="button" role="tab" aria-selected="false" data-p="cards">Cards</button>
            <button type="button" role="tab" aria-selected="false" data-p="road">Roadmap</button>
            <button type="button" className="x" id="drawer-x" aria-label="Close">×</button>
          </div>
          <div className="pane" id="p-notes">
            <label className="small" htmlFor="notes">Round notes</label>
            <textarea id="notes" placeholder="The judge, the flip, what to go for." />
          </div>
          <div className="pane" id="p-cards" hidden>
            <div className="search">
              <input id="q" type="search" placeholder="search your cut file" aria-label="Search the evidence library" />
            </div>
            <div id="cardlist" />
          </div>
          <div className="pane" id="p-road" hidden>
            <span className="small" id="road-for">Roadmap for the next speech</span>
            <ol className="road" id="road" />
            <button className="addstop" type="button" id="road-add">+ Add the selected cell</button>
          </div>
        </aside>
      </div>

      <footer className="bottom">
        <div className="tabs" role="tablist" id="tabs" />
        <div className="keys mono" aria-label="Keys">
          <span><kbd>↵</kbd> next line</span>
          <span><kbd>⇥</kbd> answer</span>
          <span><kbd>⌫</kbd> clear</span>
          <span className="k2"><kbd>⌥↑↓</kbd> move row</span>
          <span className="k2"><kbd>⌘\</kbd> split</span>
          <span><kbd>⌘K</kbd> everything</span>
        </div>
        <div className="vw">
          <button type="button" id="v-split" aria-pressed="false" title="Two flows side by side">Split</button>
          <button type="button" id="v-stack" aria-pressed="false" title="Two flows, one above the other">Stack</button>
          <button type="button" id="v-focus" aria-pressed="true" title="Widen the column you are in and the one it answers">Focus</button>
          <button type="button" id="v-compact" aria-pressed="false" title="Tighter rows">Compact</button>
          <button type="button" className="zm" id="v-minus" aria-label="Smaller">A−</button>
          <button type="button" className="zm" id="v-plus" aria-label="Larger">A+</button>
        </div>
      </footer>

      <div className="scrim" id="scrim" hidden>
        <div className="pal" role="dialog" aria-modal="true" aria-label="Everything this does">
          <input id="pal-q" placeholder="Type a command…" aria-label="Search commands" />
          <ul id="pal-list" />
        </div>
      </div>

      <div className="scrim" id="sharebox" hidden>
        <div className="card shr" role="dialog" aria-modal="true" aria-label="Flow with your partner">
          <h2 className="mono">Flow together<button type="button" className="x" id="share-x" aria-label="Close">×</button></h2>
          <div className="in">
            <p className="blurb">
              One of you starts a room and sends the other the link. After that it is
              one flow — what either of you writes turns up in the other's, and you can see where your
              partner is working. Nothing is stored anywhere: the room lasts as long as you are both in it.
            </p>
            <label className="row"><span className="small">You are</span>
              <input id="share-name" maxLength={24} placeholder="your name" />
            </label>
            <div className="code">
              <span className="small">Room code</span>
              <b id="share-code">—</b>
              <button className="btn" type="button" id="share-copy">Copy link</button>
            </div>
            <div id="share-peers" className="peers" />
            <div className="row">
              <button className="btn go" type="button" id="share-start">Start a room</button>
              <span className="small or">or</span>
              <input id="share-in" maxLength={8} placeholder="code" aria-label="Room code to join" />
              <button className="btn" type="button" id="share-join">Join</button>
              <button className="btn" type="button" id="share-leave" hidden>Leave the room</button>
            </div>
          </div>
        </div>
      </div>

      <div className="tst" id="toast" role="status" />
      <div className="menu" id="menu" role="menu" hidden />
    </div>
  );
}
