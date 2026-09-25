"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { polish } from "@/lib/evidence/polish";
import ThemePicker from "./ThemePicker";
import Ico from "./Ico";
import { useFitBar } from "./fitBar";
import FlowPicker, { worthAsking, type PickerCurrent } from "./FlowPicker";
import Presence from "./Presence";
import "./flow.css";
import "./finish.css";

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
export default function Flow({ join, owner, me, open }: { join?: string; owner?: string; me?: string; open?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);
  useFitBar(bar);
  // Which round? — asked on the way in, unless a link already said
  const [asking, setAsking] = useState<PickerCurrent | null>(null);
  const api = useRef<any>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let off: (() => void) | undefined;
    let dead = false;
    const unpolish = polish(el);
    import("@/lib/flow/engine").then((m: any) => {
      if (dead) return;
      // Whose flow, and the name a partner sees on your cursor by default.
      off = m.boot(el, {
        join, owner, me, open,
        ask: (a: any) => {
          api.current = a;
          const cur = a.current();
          worthAsking(owner, "grid", cur).then((yes) => { if (yes && !dead) setAsking(cur); });
        },
      });
    });
    return () => { dead = true; unpolish(); if (off) off(); };
  }, [join, owner, me, open]);

  const done = () => { setAsking(null); api.current?.focus(); };

  return (
    <>
    <Presence show={!!asking}>{asking && (
      <FlowPicker owner={owner} kind="grid" current={asking} onClose={done}
        onOpen={(id) => { setAsking(null); api.current?.open(id); }}
        onNew={() => { setAsking(null); api.current?.fresh(); }} />
    )}</Presence>
    <div className="flw" ref={ref}>
      <header className="topbar" ref={bar}>
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
        <button className="btn cmd" id="cmd-btn" type="button" title="Everything this does, and your evidence">
          <Ico n="command" /><span className="lbl">Commands</span> <kbd data-key="panel">Ctrl+K</kbd>
        </button>
        {/* Its own tab, reused: the tools talk across tabs, and Evidence's send
            list is the one Flow sends into. */}
        <a className="btn nosplit" href="/tools/evidence" target="break-evidence" title="Open Evidence beside this"><Ico n="cards" /><span className="lbl">Evidence ↗</span></a>
        <Link className="btn" href="/tools/flows" title="Past flows — every round you have flowed, this one kept there as you go"><Ico n="history" /><span className="lbl">Past flows</span></Link>
        <a className="btn splitlink" href="/tools/split" title="Flow and Evidence side by side"><Ico n="split" /><span className="lbl">Split ◫</span></a>
        <button className="btn" id="share-btn" aria-pressed="false" title="Flow with your partner">
          <span className="dot" id="share-dot" /><span className="lbl" id="share-state">Not shared</span>
        </button>
        <ThemePicker />
        <button className="btn" id="drawer-btn" aria-pressed="false" title="Drawer"><Ico n="drawer" /><span className="lbl">Drawer</span> <kbd data-key="drawer">Ctrl+J</kbd></button>
      </header>

      <div className="panes" id="panes">
        <section className="pw active" data-p="0">
          <div className="phead">
            <span className="pn">A</span>
            <select className="psheet" aria-label="Flow on screen A" />
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
            <select className="psheet" aria-label="Flow on screen B" />
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

        <aside className="drawer" id="drawer" aria-label="Notes, cards and round vision">
          <div className="dtabs" role="tablist">
            <button type="button" role="tab" aria-selected="true" data-p="notes">Notes</button>
            <button type="button" role="tab" aria-selected="false" data-p="cards">Cards</button>
            <button type="button" role="tab" aria-selected="false" data-p="vision">Round vision</button>
            <button type="button" role="tab" aria-selected="false" data-p="doc">Send doc</button>
            <button type="button" className="x" id="drawer-x" aria-label="Close">×</button>
          </div>
          <div className="pane" id="p-notes">
            <label className="small" htmlFor="notes">Round notes</label>
            <textarea id="notes" placeholder="The judge, the flip, what to go for." />
          </div>
          <div className="pane" id="p-cards" hidden>
            <div id="inbox" className="inbox" hidden />
            <div className="search">
              <input id="q" type="search" placeholder="search your cut file" aria-label="Search the evidence library" />
            </div>
            <div id="cardlist" />
          </div>
          <div className="pane" id="p-vision" hidden>
            <div className="vhead">
              <span className="small">The speech, as a path <i id="v-count" /></span>
              <button className="btn go" type="button" id="v-speak">Speak ▸</button>
            </div>
            <ol className="vlist" id="vlist" />
            <button className="addstop" type="button" id="v-add">+ Add the selected cell <kbd data-key="stop.toggle">Ctrl+B</kbd></button>
            <p className="small vkeys">
              <kbd data-key="stop.1">Alt+1</kbd>… jumps to a stop · <kbd data-key="stop.next">Ctrl+]</kbd> next ·{" "}
              <kbd data-key="stop.prev">Ctrl+[</kbd> back · drag to reorder · double-click to rename.
              While speaking, Page Down — or a clicker — walks it.
            </p>
          </div>
          <div className="pane" id="p-doc" hidden>
            <div id="sdoc" />
          </div>
        </aside>

        {/* Speaking through round vision: where you are in the speech, over the flow. */}
        <div className="speak" id="speak" hidden>
          <div className="spk">
            <button type="button" id="sp-prev" aria-label="The stop before">‹</button>
            <span className="n mono" id="sp-n">1 / 1</span>
            <span className="what"><b id="sp-name">—</b><span className="where mono" id="sp-where" /></span>
            <button type="button" id="sp-next" aria-label="The next stop">›</button>
            <button type="button" className="x" id="sp-x" aria-label="Stop speaking">×</button>
            <i className="bar"><i id="sp-bar" /></i>
          </div>
        </div>
      </div>

      <footer className="bottom">
        <div className="tabs" role="tablist" id="tabs" />
        <div className="keys mono" aria-label="Keys">
          <span><kbd data-kb="enter">Enter</kbd> next line</span>
          <span><kbd data-kb="tab">Tab</kbd> answer</span>
          <span><kbd data-kb="back">Backspace</kbd> clear</span>
          <span className="k2"><kbd data-key="row.up|row.down">Alt+↑ Alt+↓</kbd> move row</span>
          <span className="k2"><kbd data-key="split">Ctrl+\</kbd> split</span>
          <span className="k2"><kbd data-key="stop.toggle">Ctrl+B</kbd> vision stop</span>
          <span><kbd data-key="answer">Ctrl+/</kbd> answer from evidence</span>
          <span><kbd data-key="panel">Ctrl+K</kbd> everything</span>
        </div>
        <div className="vw">
          <button type="button" id="v-split" aria-pressed="false" title="Two flows side by side">Split</button>
          <button type="button" id="v-stack" aria-pressed="false" title="Two flows, one above the other">Stack</button>
          <button type="button" id="v-focus" aria-pressed="true" title="Widen the column you are in and the one it answers">Focus</button>
          <button type="button" id="v-compact" aria-pressed="false" title="Tighter rows">Compact</button>
          <button type="button" className="zm" id="v-minus" aria-label="Smaller">A−</button>
          <button type="button" className="zm" id="v-plus" aria-label="Larger">A+</button>
          <button type="button" id="keys-btn" title="Change the keyboard shortcuts">Keys</button>
        </div>
      </footer>

      <div className="scrim" id="scrim" hidden>
        <div className="pal" id="pal" role="dialog" aria-modal="true" aria-label="Command panel">
          <div className="palin">
            <span className="glyph mono" aria-hidden="true">›</span>
            <input id="pal-q" placeholder="Run a command, go somewhere — or / to search your evidence" aria-label="Search commands" autoComplete="off" spellCheck={false} />
          </div>
          <div className="palsrc" id="pal-src" hidden />
          <div className="palbins mono" id="pal-bins" hidden />
          <ul id="pal-list" />
          <div className="palfoot mono" id="pal-foot" />
        </div>
      </div>

      {/* The keyboard shortcuts, each one changeable. */}
      <div className="scrim" id="keysbox" hidden>
        <div className="card keyed" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
          <h2 className="mono">Keyboard shortcuts<button type="button" className="x" id="keys-x" aria-label="Close">×</button></h2>
          <div className="kin">
            <input id="keys-q" placeholder="find a command or a key" autoComplete="off" spellCheck={false} />
            <p className="small khelp">Click a shortcut and press the keys you want. Backspace takes it off; Esc leaves it as it was.
              A key can only do one thing — giving it here takes it from wherever it was.</p>
            <ul id="keys-list" />
          </div>
          <div className="kout"><button className="btn" type="button" id="keys-reset">Reset every shortcut</button></div>
        </div>
      </div>

      {/* Asks for a name next to the thing being named, instead of prompt(). */}
      <div className="namer" id="namer" hidden>
        <span className="small" id="namer-t">Name</span>
        <input id="namer-in" autoComplete="off" spellCheck={false} />
        <span className="small hint" id="namer-h" />
      </div>

      {/* The other team's case, off SpeechDrop, down a column: the engine fills it. */}
      <div className="scrim" id="sdbox" hidden>
        <div className="card sdc" role="dialog" aria-modal="true" aria-label="Their case from SpeechDrop">
          <h2 className="mono">Their case, from SpeechDrop<button type="button" className="x" id="sd-x" aria-label="Close">×</button></h2>
          <div className="in" id="sd-in-box" />
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
            <div className="row evirow">
              <span className="small">Partner building the send doc?</span>
              <button className="btn" type="button" id="share-evi" hidden>Copy the Evidence link</button>
            </div>
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
    </>
  );
}
