"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ThemePicker from "./ThemePicker";
import { useFitBar } from "./fitBar";
import { Keys, MapDemo, EvidenceDemo, FlowDemo, DocFlowDemo, ViewerDemo, SplitDemo, PopDemo, PastDemo, EveryDemo } from "./TutorialDemos";
import "./finish.css";
import "./tutorial.css";

/**
 * The tutorial: every other tool, explained — what it is for, a first go at
 * it step by step, its keys, and what is worth knowing — with a way into each.
 *
 * Written from the tools as they are (their key lists, their buttons), in the
 * words this computer uses for its keys: Ctrl and Alt, not symbols. Each
 * section has a "Try it" panel (TutorialDemos.tsx): the tool in miniature,
 * working, with one thing to do — done, it is ticked in the contents, and
 * the ticks are kept in this browser.
 */

interface Section {
  id: string;
  name: string;
  line: string;
  open?: { href: string; label: string }[];
  idea: React.ReactNode;
  steps?: React.ReactNode[];
  keys?: [string, string][];
  tips?: React.ReactNode[];
}

const K = (k: string) => <Keys k={k} />;

const SECTIONS: Section[] = [
  {
    id: "start",
    name: "Start here",
    line: "How the tools fit together, from prep to the last speech.",
    idea: (
      <>
        <p>Each tool does one job, and they talk to each other. A card you send from <b>Evidence</b> shows up ready to flow in <b>Flow</b>. A doc
          open in the <b>Doc viewer</b> can be rehighlighted and sent back to your send doc. One room code joins you and your partner in
          Flow, Evidence&apos;s send doc and the Doc viewer at once.</p>
      </>
    ),
    steps: [
      <>Before the tournament, <b>import your blocks</b> into Evidence. It only needs doing once per file.</>,
      <>In the round, open <b>Split screen</b> with Evidence on one side and Flow (or Doc flow) on the other.</>,
      <>When the other team sends their case, open it in the <b>Doc viewer</b>, then <b>Pop out</b> the doc so it stays in view.</>,
      <>Start a <b>room</b> in Flow and read the code to your partner. They join it in their Flow, their Evidence and their Doc viewer.</>,
      <>After the round, the flow is already in <b>Past flows</b>. Start the next one without losing anything.</>,
    ],
    tips: [
      <>Everything is kept in this browser, separately for each account. Nothing is uploaded unless you share a room, and a room passes changes straight between the two browsers.</>,
      <>Every tool has the same buttons in its banner: <b>Colours</b> (scheme and feel), <b>Full screen</b>, <b>Pop out</b> and <b>Split</b>. They&apos;re explained at the end.</>,
    ],
  },
  {
    id: "evidence",
    name: "Evidence",
    line: "Your blocks file, searchable by trigger. Send cards, build the send doc, format it for the other team.",
    open: [{ href: "/tools/evidence", label: "Open Evidence" }, { href: "/tools/split?a=evidence", label: "Evidence in Split screen" }],
    idea: <p>Paste in your evidence doc once. Its headings become blocks (Heading 3) and taglines (Heading 4), so the whole file is searchable by what it answers. Sending a card copies it, adds it to the send list and puts it in your send doc, ready to format and send.</p>,
    steps: [
      <>Open your evidence doc in Google Docs, press {K("Ctrl+A")} then {K("Ctrl+C")}, click <b>Import</b> and paste.</>,
      <>Press {K("/")} and type a trigger (&ldquo;econ&rdquo;, &ldquo;AT: heg&rdquo;). Move with {K("↑ ↓")}. {K("→")} opens a block&apos;s arguments so you can send just one.</>,
      <>Press {K("Enter")} to send. The card is copied, joins the <b>Send list</b> and goes into the <b>Send doc</b>. Cards from the same block merge into one block.</>,
      <>Click <b>Format</b> in the send doc&apos;s bar. It asks for your code, the speech and the tournament once, then titles the doc, can delete analytics (and put them back), makes highlighting one colour (grey stays grey), numbers responses (or doesn&apos;t), and adds the speech to each heading.</>,
      <>To search the open caselist, switch <b>Library</b> to <b>Caselist</b>. It searches this year&apos;s tags, with the strongest teams&apos; cards first.</>,
      <>Click <b>Room</b> to share the send doc with your partner. It&apos;s the same code as your flow room.</>,
    ],
    keys: [
      ["/", "Search"],
      ["↑ ↓", "Move through results"],
      ["→ / Tab", "Open a block's arguments"],
      ["Enter", "Copy and send"],
      ["Esc", "Clear the search"],
      ["Delete", "Remove from your library"],
      ["Alt+1 / Alt+2 / Alt+3", "Show or hide Search, Send list, Send doc"],
    ],
    tips: [
      <><b>+ Analytic</b> adds a tagline you write yourself under the last card.</>,
      <>The <b>Read</b> tab shows the doc as you&apos;ll read it: only what&apos;s highlighted.</>,
      <>Hide panes with {K("Alt+1")}–{K("Alt+3")} to split screen with just the send doc, or just the search.</>,
      <>With the search pane hidden, {K("/")} (or the Search button) brings the search up <b>as a pop-up over the send doc</b>. It works just the same: {K("Enter")} sends, and your search is still there next time. {K("Esc")} clears it, and a second {K("Esc")} (or a click outside) puts it away. Drag it by its bar anywhere on the screen, and it stays there. In Split screen it floats over both halves, over Flow too. Double-click the bar to centre it. <b>Keep it open</b> turns it back into a pane.</>,
    ],
  },
  {
    id: "flow",
    name: "Flow",
    line: "Flow a Public Forum round on a real grid, on the clock, with your partner in the same flow.",
    open: [{ href: "/tools/flow", label: "Open Flow" }, { href: "/tools/split?a=flow", label: "Flow in Split screen" }],
    idea: <p>One sheet per case. Its columns are the chain of answers: the case, their rebuttal, your rebuttal, through both final focuses. Each argument gets a row, and its answer sits to its right. The clock knows every speech and both prep clocks, and marks the column that&apos;s live.</p>,
    steps: [
      <>When it asks <b>Which flow?</b>, press {K("Enter")} to keep the one you were on, or start a new one.</>,
      <>Click a cell and type. {K("Enter")} goes to the next line, {K("Tab")} answers in the next column across, {K("Shift+Enter")} adds a line inside the cell.</>,
      <>Run the clock from the banner, or with {K("Ctrl+.")}. Pro and Con prep have their own clocks.</>,
      <>Type <i>ext</i>, <i>turn</i>, <i>dropped</i>, <i>perm</i> or <i>nuq</i> and they become marks. {K("Ctrl+D")} marks a cell dropped, {K("Ctrl+E")} extended.</>,
      <>Open the drawer with {K("Ctrl+J")}. It has <b>Notes</b>, <b>Cards</b> (tags you sent from Evidence), <b>Round vision</b> and <b>Send doc</b>. In Send doc, <b>Flow all ↓</b> puts every block beside the argument it names. &ldquo;AT: Midterms&rdquo; finds &ldquo;Contention 2 is MIDTERMS&rdquo;, and each response goes beside the next sub-point.</>,
      <>Click <b>Not shared</b> to start a room and read the code to your partner. You&apos;re both writing the same flow, and it stays shared through a page change.</>,
    ],
    keys: [
      ["Enter", "Write in the cell, or the next line down (a new row, if that one is written in)"],
      ["Ctrl+Enter", "A new row under this one, to answer in between"],
      ["Tab", "Answer: the next column across"],
      ["Shift+Enter", "A new line inside the cell"],
      ["Shift+↑ ↓ ← →", "Select a range"],
      ["Ctrl+K", "Command panel (everything, by name)"],
      ["Ctrl+/", "Find evidence that answers this cell"],
      ["Ctrl+J", "The drawer"],
      ["Ctrl+.", "Start or pause the clock"],
      ["Ctrl+Z / Ctrl+Y", "Undo, redo"],
      ["Alt+↑ / Alt+↓", "Move a row"],
      ["Ctrl+Backspace", "Delete the row"],
      ["Ctrl+B", "Round vision: add this cell as a stop"],
      ["Ctrl+] / Ctrl+[", "Next or previous stop"],
      ["Ctrl+Shift+1", "Write in column 1 (to 7)"],
      ["F2", "Rename this sheet"],
      ["Ctrl+\\", "Two sheets side by side"],
    ],
    tips: [
      <>In the command panel, {K("/")} searches your evidence and {K("Tab")} switches to the caselist. Picking a card flows its tag and sends the card to your send doc.</>,
      <>Drag a row by its grip, or select several cells and drag them up or down together.</>,
      <>When Flow is narrow (half of Split screen), columns nobody has reached yet fold into thin slivers, so the columns in use get the room. A column opens again when you click into it, Tab into it, or its speech starts.</>,
      <>Every key can be changed: open <b>Keyboard shortcuts</b> in the command panel.</>,
    ],
  },
  {
    id: "docflow",
    name: "Doc flow",
    line: "Flow the way a Google Doc gets flowed: boxed sides, their points in red, your answers under them.",
    open: [{ href: "/tools/docflow", label: "Open Doc flow" }, { href: "/tools/split?a=docflow", label: "Doc flow in Split screen" }],
    idea: <p>A document that knows it&apos;s a flow. {K("Tab")} answers a line and switches the speaker, and the numbering is Docs&apos; own. Your rhetoric sits beside it, ready to drag onto a line or call up with {K("/")}.</p>,
    steps: [
      <>Type their point. {K("Tab")} answers it underneath in your colour, and {K("Ctrl+Enter")} starts their next point.</>,
      <>Type {K("/")} for boxes (NEG, AFF, weighing), your rhetoric and your evidence.</>,
      <>Highlight with {K("Alt+Y")} yellow, {K("Alt+G")} green, {K("Alt+B")} blue or {K("Alt+P")} pink.</>,
      <>Select lines you always say and press {K("Alt+S")} to keep them as <b>rhetoric</b>. Drag them onto a line later, or paste a Google Doc of them.</>,
      <>Mark the lines you&apos;ll go to with {K("Alt+V")}, then click <b>Speak</b> and walk them in order with {K("Ctrl+]")} or Page Down.</>,
      <><b>Copy for Docs</b> pastes into Google Docs numbered, red and highlighted, and <b>.docx</b> saves a file. <b>Share</b> puts your partner in the same flow.</>,
    ],
    keys: [
      ["Tab", "Answer this line (or indent)"],
      ["Shift+Tab", "Back out a level"],
      ["Ctrl+Enter", "Their next point"],
      ["Shift+Enter", "Answer, straight under this line"],
      ["Alt+T", "Swap who said it"],
      ["Alt+↑ / Alt+↓", "Move the line"],
      ["Alt+V", "Mark a stop"],
      ["Alt+1", "Go to stop 1 (to 9)"],
      ["Alt+S", "Keep the selected lines as rhetoric"],
      ["Alt+R", "Show or hide the right panel"],
      ["Ctrl+K", "Command panel"],
      ["Ctrl+/", "Answer from your evidence"],
    ],
    tips: [<>Paste a flow straight out of Google Docs and it keeps its structure. <b>Change keys</b> (bottom left) moves any shortcut.</>],
  },
  {
    id: "viewer",
    name: "Doc viewer",
    line: "Read your partner's send doc live, the other team's doc off SpeechDrop, or any .docx. Rehighlight their cards.",
    open: [{ href: "/tools/viewer", label: "Open the Doc viewer" }, { href: "/tools/split?a=viewer", label: "Doc viewer in Split screen" }],
    idea: <p>Every document gets an outline of its pockets, hats, blocks and tags, each with how long its highlighting takes to read, and a search that marks every match.</p>,
    steps: [
      <>On the <b>Open</b> tab: type your partner&apos;s room code to read their send doc as they build it, or a <b>SpeechDrop</b> room code to open any file in it, or open a file or paste a Google Doc.</>,
      <>Use the <b>Outline</b> to jump around, and {K("J")} / {K("K")} for the next or previous block. {K("Ctrl+F")} searches, and {K("F3")} goes to the next match.</>,
      <><b>Highlighted only</b> fades everything that isn&apos;t read, and <b>A− / A+</b> changes the size.</>,
      <><b>Rehighlight</b> ({K("R")}): click a card and its highlighting turns grey. Select words to highlight them green (select green again to remove it, {K("Ctrl+Z")} to undo), then <b>Send to send doc</b>. The card lands in Evidence with its grey and green.</>,
    ],
    keys: [
      ["Ctrl+F", "Search the doc"],
      ["F3 / Enter", "Next match (Shift for the one before)"],
      ["J / K", "Next or previous block"],
      ["R", "Rehighlight a card"],
      ["Ctrl+Z", "Undo, while rehighlighting"],
      ["F", "Full screen (Esc leaves)"],
    ],
    tips: [<>A doc stays open when you go into or out of Split screen. <b>Pop out</b> gives it a window of its own.</>],
  },
  {
    id: "split",
    name: "Split screen",
    line: "Any two tools side by side in one window.",
    open: [{ href: "/tools/split", label: "Open Split screen" }],
    idea: <p>Each side is the whole tool, with its own keys, so typing in one never triggers the other&apos;s shortcuts. The two still talk to each other the way two tabs do.</p>,
    steps: [
      <>Pick what goes on each side from the strip at the top: Evidence, Flow, Doc viewer or Doc flow. Picking what the other side has swaps them.</>,
      <>Drag the line between them to resize. Arrow keys nudge it, and double-clicking makes it half and half. <b>⇄</b> swaps the sides.</>,
      <><b>×</b> on a side closes it, and the other tool takes the whole window.</>,
      <><b>Round mode</b> (the button over the line, in the strip) goes full screen and clears the clutter away. The site menu disappears, the strip tucks above the top edge until your pointer comes up to it, and each tool's banner gets shorter, with its key hints put away. {K("Esc")} leaves it.</>,
    ],
    tips: [
      <>The <b>Split</b> button in any tool opens Split screen with that tool on the left, still on the same flow and still in its room.</>,
      <>A good setup for a round: Flow and Evidence in <b>Round mode</b>, with Evidence showing only its send doc and the search as a pop-up ({K("/")}).</>,
    ],
  },
  {
    id: "popout",
    name: "Pop-outs",
    line: "One thing from a tool, in a small window of its own, to keep an eye on.",
    idea: <p><b>Pop out</b> (the arrow-out-of-a-box icon in each banner) opens a small window with one thing in it. It <b>stays on top</b>, floating above both halves of Split screen and above other apps, so clicking elsewhere never hides it (in Chrome and Edge; other browsers get an ordinary window). It stays live, and it can&apos;t be typed into, so it never conflicts with the tool itself.</p>,
    steps: [
      <>From the <b>Doc viewer</b>: just the doc. It follows whatever the Doc viewer shows, or can be pinned to one of your recent docs. Only one pop-out floats at a time, so a second one (the other team&apos;s other doc, say) opens as an ordinary window beside it.</>,
      <>From <b>Evidence</b>: the send doc, or the read doc, as it&apos;s written.</>,
      <>From <b>Flow</b>: the grid, one sheet at a time. <b>Written only</b> hides columns nobody has spoken in yet.</>,
      <>From <b>Doc flow</b>: the flow as a document.</>,
    ],
    keys: [["Ctrl+F", "Search"], ["+ / -", "Bigger or smaller"]],
    tips: [<>Each doc pop-out has <b>Jump to…</b> for any heading, and Highlighted only.</>],
  },
  {
    id: "flows",
    name: "Past flows",
    line: "Every round you've flowed, Doc or Grid, one click from opening again.",
    open: [{ href: "/tools/flows", label: "Open Past flows" }],
    idea: <p>Flow and Doc flow file every round here as you go, so starting the next round never loses the last.</p>,
    steps: [
      <>Search every word you&apos;ve ever flowed.</>,
      <>Group rounds by tournament, and read one back without opening it.</>,
      <>Open a round in the tool it came from, or delete it (and undo the delete).</>,
    ],
  },
  {
    id: "every",
    name: "In every tool",
    line: "The same four buttons in every banner, and what they do.",
    idea: <p>The Colours button and the three icons at the right of each banner work the same way in every tool.</p>,
    steps: [
      <><b>Colours</b> offers five schemes (Forest, Paper, Navy, Oxblood, Graphite) and a <b>Feel</b>. <b>Sharp</b> is square and crisp. <b>Cozy</b> is warm and rounded, with a softer typeface and lamp-light. The choice applies to every tool in this browser.</>,
      <><b>Full screen</b> gives the tool the whole screen, even from a side of Split screen. {K("Esc")} brings it back.</>,
      <><b>Pop out</b> is covered above.</>,
      <><b>Split</b> opens Split screen with this tool on the left.</>,
    ],
    tips: [<>When a banner gets too narrow for its words, its buttons turn into icons, and hovering one shows its name. If it&apos;s narrower still, scroll the banner sideways.</>],
  },
];

const DONE_KEY = "tutorial.done";

export default function Tutorial() {
  // what has been tried, kept here so the ticks are still there next time
  const [tried, setTried] = useState<Set<string>>(new Set());
  useEffect(() => { try { setTried(new Set(JSON.parse(localStorage.getItem(DONE_KEY) || "[]"))); } catch { /* first visit */ } }, []);
  const mark = useCallback((id: string) => setTried((t) => {
    if (t.has(id)) return t;
    const n = new Set(t); n.add(id);
    try { localStorage.setItem(DONE_KEY, JSON.stringify([...n])); } catch { /* private browsing */ }
    return n;
  }), []);
  const doneFns = useMemo(() => Object.fromEntries(SECTIONS.map((x) => [x.id, () => mark(x.id)])), [mark]);
  const allKeys = useMemo(() => SECTIONS.flatMap((x) => (x.keys || []).map(([k, what]) => ({ tool: x.name, k, what }))), []);
  const demoFor = (id: string) => {
    const props = { onDone: doneFns[id], done: tried.has(id) };
    switch (id) {
      case "start": return <MapDemo {...props} />;
      case "evidence": return <EvidenceDemo {...props} />;
      case "flow": return <FlowDemo {...props} />;
      case "docflow": return <DocFlowDemo {...props} />;
      case "viewer": return <ViewerDemo {...props} />;
      case "split": return <SplitDemo {...props} />;
      case "popout": return <PopDemo {...props} />;
      case "flows": return <PastDemo {...props} />;
      case "every": return <EveryDemo {...props} allKeys={allKeys} />;
      default: return null;
    }
  };

  const bar = useRef<HTMLElement>(null);
  useFitBar(bar);
  const body = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(SECTIONS[0].id);

  // which section is being read: the last one whose top has passed a line near the top
  useEffect(() => {
    const box = body.current;
    if (!box) return;
    let raf = 0;
    const spy = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const line = box.getBoundingClientRect().top + 120;
        let at = SECTIONS[0].id;
        for (const s of SECTIONS) {
          const el = document.getElementById("tu-" + s.id);
          if (el && el.getBoundingClientRect().top <= line) at = s.id;
        }
        if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) at = SECTIONS[SECTIONS.length - 1].id;
        setCur(at);
      });
    };
    box.addEventListener("scroll", spy, { passive: true });
    spy();
    return () => { box.removeEventListener("scroll", spy); cancelAnimationFrame(raf); };
  }, []);

  const go = (id: string) => {
    const el = document.getElementById("tu-" + id), box = body.current;
    if (el && box) box.scrollTo({ top: el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 18, behavior: "smooth" });
  };

  return (
    <div className="tut">
      <header className="tu-top" ref={bar}>
        <Link className="back mono" href="/tools" title="Back to the tools">←</Link>
        <div className="brand mono">Tutorial</div>
        <div className="tu-gap" />
        <ThemePicker />
      </header>
      <div className="tu-body">
        <nav className="tu-nav" aria-label="Tools">
          <div className="tu-navh mono">The tools</div>
          <div className="tu-prog" aria-label={`${tried.size} of ${SECTIONS.length} tried`}>
            <div className="tu-progbar"><i style={{ width: `${(tried.size / SECTIONS.length) * 100}%` }} /></div>
            <span className="mono">{tried.size} of {SECTIONS.length} tried</span>
          </div>
          {SECTIONS.map((s, i) => (
            <button key={s.id} type="button" className={"tu-navi" + (cur === s.id ? " on" : "")} onClick={() => go(s.id)} aria-current={cur === s.id}>
              <span className="n mono">{String(i).padStart(2, "0")}</span>{s.name}
              <i className={"tu-tick" + (tried.has(s.id) ? " on" : "")} aria-label={tried.has(s.id) ? "tried" : undefined}>{tried.has(s.id) ? "✓" : ""}</i>
            </button>
          ))}
        </nav>
        <div className="tu-main" ref={body}>
          <div className="tu-col">
            <div className="tu-hero">
              <p className="mono">The Break · Tools</p>
              <h1>How every tool works</h1>
              <p className="tu-lead">What each tool is for, a first go at it step by step, its keys, and the things worth knowing. Every section has a <b>Try it</b> panel: a small working copy of the tool to have a go in. Nothing you do there touches your real flows or cards.</p>
            </div>
            {SECTIONS.map((s, i) => (
              <section key={s.id} id={"tu-" + s.id} className="tu-sec">
                <header className="tu-sech">
                  <span className="tu-n mono">{String(i).padStart(2, "0")}</span>
                  <div>
                    <h2>{s.name}</h2>
                    <p className="tu-line">{s.line}</p>
                  </div>
                </header>
                {s.open && (
                  <div className="tu-open">
                    {s.open.map((o, j) => <Link key={o.href} href={o.href} className={"tu-btn" + (j === 0 ? " ink" : "")}>{o.label} <span aria-hidden="true">→</span></Link>)}
                  </div>
                )}
                <div className="tu-idea">{s.idea}</div>
                {demoFor(s.id)}
                {s.steps && (
                  <>
                    <h3 className="mono">{s.id === "start" ? "A round with the tools" : s.id === "every" ? "The buttons" : "A first go"}</h3>
                    <ol className="tu-steps">{s.steps.map((st, j) => <li key={j}>{st}</li>)}</ol>
                  </>
                )}
                {s.keys && (
                  <>
                    <h3 className="mono">Keys</h3>
                    <dl className="tu-keylist">
                      {s.keys.map(([k, what]) => (
                        <div key={k + what} className="tu-krow"><dt><Keys k={k} /></dt><dd>{what}</dd></div>
                      ))}
                    </dl>
                  </>
                )}
                {s.tips && (
                  <>
                    <h3 className="mono">Good to know</h3>
                    <ul className="tu-tips">{s.tips.map((t, j) => <li key={j}>{t}</li>)}</ul>
                  </>
                )}
              </section>
            ))}
            <p className="tu-end mono">That&apos;s every tool. <Link href="/tools">Back to the tools →</Link></p>
          </div>
        </div>
      </div>
    </div>
  );
}
