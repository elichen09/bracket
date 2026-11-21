"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Grain from "@/components/Grain";
import ThemePicker from "./ThemePicker";
import { useFitBar } from "./fitBar";
import { Keys, WindowDemo, CutterDemo, EvidenceDemo, PaletteDemo, ViewerDemo, PopDemo, KeyDemo } from "./TutorialDemos";
import "./finish.css";
import "./tutorial.css";

/**
 * The tutorial: coda, a chapter at a time — what each part is for, a go at
 * it in a working miniature ("Try it", TutorialDemos.tsx), the moves, the
 * keys as a cheat sheet, and what is worth knowing.
 *
 * Written from the app as it is (its key list, its bar), in the words this
 * computer uses for its keys: Ctrl and Alt, not symbols. A chapter tried is
 * ticked in the contents and kept in this browser; all of them, and the end
 * says so.
 */

interface Chapter {
  id: string;
  name: string;
  /** what it is, in a line, under the name */
  line: string;
  idea: React.ReactNode;
  moves?: React.ReactNode[];
  keys?: [string, string][];
  tips?: React.ReactNode[];
}

const K = (k: string) => <Keys k={k} />;

const CHAPTERS: Chapter[] = [
  {
    id: "window",
    name: "The window",
    line: "One window for the round: your files, the library, the speech doc and their docs.",
    idea: <p>Everything happens in one place. Across the top, <b>the bar</b>; under it, <b>the format bar</b> with only what a card is cut with; down the side, your <b>outline</b>, <b>files</b>, the library <b>search</b> and the <b>round</b>; in the middle, the page. Every button and key works in whichever document has the cursor, the speech doc included.</p>,
    moves: [
      <><b>Edit</b> is just your file. <b>Split</b> ({K("Alt+B")}) puts the speech doc beside it. <b>Speech</b> ({K("Alt+Shift+B")}) is the speech doc alone, the whole width. <b>Flow</b> ({K("Alt+Shift+R")}) is your flow of the round: Public Forum sheets with a column per speech, flowed from the keyboard, and with your partner.</>,
      <>The box in the middle of the bar is the <b>command menu</b> ({K("Ctrl+Shift+K")}): any command, any file, or a search. It has a chapter of its own.</>,
      <>Your initial, top right, has home, this tutorial, Keys and sign out.</>,
    ],
    tips: [
      <>Everything is kept in this browser, separately for each account. Nothing is uploaded unless you share a file or start a room.</>,
      <>Full screen (the corner button) gives coda the keys Chrome or an extension would otherwise take, like {K("Ctrl+N")}.</>,
    ],
  },
  {
    id: "cut",
    name: "Cut a card",
    line: "Files of your own, cut one key per move. Every file is in the library search too.",
    idea: <p>A file is a cut file: pocket, hat, block, tag, and under each tag its cite and the card. Each move is one key, and any of them can be moved. Files save as you go, and each one is in the library search, kept up to date as you cut.</p>,
    moves: [
      <><b>New file</b> or <b>Open .docx</b> in the Files tab (cite, underline, emphasis and highlighting come with it). Rename the open file by clicking its name in the bar, or double-click one in the list.</>,
      <>Paste the article. {K("Ctrl+Shift+V")} pastes without the source&apos;s formatting, and {K("Alt+Q")} joins the lines a PDF breaks it into. {K("Alt+Shift+Q")} keeps a stretch you won&apos;t read whole, at 6pt, marked as condensed.</>,
      <>Type the tag and press {K("Alt+4")}. Select the author and date and press {K("Alt+C")} for the cite.</>,
      <>Select what matters and press {K("Ctrl+Alt")} together, then let go, to cut it. Again on cut words: emphasis; a third time: plain. {K("Alt+Z")} highlights. With nothing selected, a key works on the word the cursor is in.</>,
      <>{K("Ctrl+N")} shrinks everything neither underlined nor bold to 8pt (in full screen — Chrome keeps Ctrl+N otherwise). {K("Alt+N")} starts the next card.</>,
      <><b>Reformat</b> ({K("Alt+Shift+W")}) makes cards cut anywhere look cut here: one highlight colour, emphasis boxed, pasted fonts off, bracketed cites rewritten in your cite format (under Keys).</>,
      <><b>Extensions</b>: a pocket for the speech ({K("Alt+1")}, &ldquo;1AR&rdquo;), then {K("Alt+X")} for each block — a new page with a heading ending &ldquo;---1AR&rdquo;, and bold analytic lines under it.</>,
      <>Reorder from the <b>Outline</b> tab (drag a heading and everything under it comes too), or {K("Alt+↑")} / {K("Alt+↓")} on the card you&apos;re in. Each move is one {K("Ctrl+Z")}.</>,
    ],
    keys: [
      ["Ctrl+Alt", "Cut: underline at 11pt (twice: emphasis)"],
      ["Alt+Z", "Highlight"],
      ["Ctrl+N", "Shrink the rest to 8pt"],
      ["Ctrl+Shift+Space", "Emphasis: bold, underlined, boxed"],
      ["Alt+1 / Alt+2 / Alt+3 / Alt+4", "Pocket, hat, block, tag"],
      ["Alt+C", "Cite"],
      ["Ctrl+\\", "Clear formatting"],
      ["Alt+W", "Clean up"],
      ["Alt+Shift+W", "Reformat"],
      ["Alt+Q", "Condense"],
      ["Alt+Shift+Q", "Condense, none omitted"],
      ["Alt+N", "New card"],
      ["Alt+X", "New extension"],
      ["Alt+Shift+X", "Analytic"],
      ["Alt+G", "Keep the card for reference (grey)"],
      ["Alt+Shift+G", "Reference a card from any file"],
      ["Alt+V", "Verbatimise: just the highlighting"],
      ["Alt+R", "The read view beside you"],
      ["Alt+↑ / Alt+↓", "Move the card"],
      ["Ctrl+Enter", "Page break"],
    ],
    tips: [
      <>Select any part of a file to see its word count in the corner: all of it, what you&apos;d read, and how long that takes.</>,
      <><b>Pages</b> (in the format bar) opens up to three pages: the read view beside you, two places in one file, or another file.</>,
    ],
  },
  {
    id: "search",
    name: "Search and send",
    line: "Every card you have, found by what it says — and in the speech doc with one key.",
    idea: <p>Press {K("/")} anywhere you&apos;re not typing and the library search opens. It reads the cards, not only their tags, and knows a denial from a claim: &ldquo;econ decline doesn&apos;t cause war&rdquo; finds the cards that say it doesn&apos;t. Switch <b>Library</b> to <b>Caselist</b> to search this year&apos;s open caselist.</p>,
    moves: [
      <>Bring in your blocks once: copy your evidence doc, then <b>⋯ › Import an evidence file</b> and paste. Its headings become blocks and taglines.</>,
      <>Press {K("/")} (or {K("Alt+/")} while typing) and type a trigger. Move with {K("↑ ↓")}; {K("→")} opens a block to send just one card.</>,
      <>{K("Enter")} sends the card to the speech doc, where its cursor is. {K("Shift+Enter")} puts it in the file you&apos;re in instead; {K("Ctrl+Enter")} opens it as a page.</>,
      <>In the page, {K("Alt+Enter")} sends the card the cursor is in — on a block heading, the whole block.</>,
      <>On an empty line of the speech doc, type {K("/")} and a few words — <b>/skep turns</b> — and matching blocks open right there. {K("Space")} ticks several; {K("Enter")} puts them in.</>,
    ],
    keys: [
      ["/ or Alt+/", "Search the library"],
      ["↑ ↓", "Move through results"],
      ["→", "Open a block's cards"],
      ["Enter", "Send to the speech doc"],
      ["Shift+Enter", "Into the file you're in"],
      ["Alt+Enter", "Send the card you're in"],
      ["Ctrl+Shift+F", "Search every file of yours"],
    ],
    tips: [<>A ✓ in the results marks what&apos;s already in the speech doc. <b>Bins</b> narrow the search to what&apos;s in this round.</>],
  },
  {
    id: "command",
    name: "One box for everything",
    line: "The command menu: any command, any file, any search — a few letters and Enter.",
    idea: <p>Press {K("Ctrl+Shift+K")} (or click the box in the middle of the bar). Type what you want — &ldquo;read&rdquo;, &ldquo;reformat&rdquo;, &ldquo;layout deck&rdquo;, a file&apos;s name — and press {K("Enter")}. Anything that isn&apos;t a command is a search: {K("Enter")} looks for it in the library.</p>,
    moves: [
      <>With nothing typed, it shows what you reach for most: search, send, Split, Read, a new file, the timer, Keys, colours.</>,
      <>Every command shows its key on the right, so the menu teaches the keys as you use it.</>,
      <>Files come up by name: type part of one and {K("Enter")} opens it.</>,
    ],
    keys: [["Ctrl+Shift+K", "The command menu"], ["↑ ↓", "Move"], ["Enter", "Run it"], ["Esc", "Close"]],
    tips: [<>Ctrl+K is taken by the Docs Hotkey extension in Chrome, so coda uses Ctrl+Shift+K. Keys can move it.</>],
  },
  {
    id: "speech",
    name: "The speech doc",
    line: "What you'll read, built as you go, shared with your partner, timed.",
    idea: <p>The speech doc is a page like any other: the format bar, the outline and every key work in it. Cards you send land where its cursor is — after the card it&apos;s in — and a dashed line shows that spot while you search.</p>,
    moves: [
      <><b>Tags only</b> ({K("Alt+H")}) folds every card to its tag, so the doc reads as an outline to drag around. Nothing is deleted.</>,
      <>Point at any tag and drag the ⋮⋮ in the margin to move the card (or a whole block).</>,
      <><b>DOC ▾</b> in its head: <b>Format for sending</b> (title, analytics out, one highlight colour, numbered), Copy, .docx, SpeechDrop, Rebuild, Clear.</>,
      <><b>Room</b> in the bar shares the speech doc with your partner: you both write it, and every card either of you sends lands in it.</>,
      <><b>Share</b> gives the file you&apos;re in a link — whoever opens it is in it with you, like a Google Doc.</>,
      <><b>Read</b> ({K("Alt+Shift+R")}) shows it as you&apos;ll read it, with how long it takes; {K("Alt+T")} opens the speech timer.</>,
    ],
    keys: [["Alt+B", "Speech doc beside"], ["Alt+Shift+B", "Just the speech doc"], ["Alt+H", "Tags only"], ["Alt+Shift+R", "Flow"], ["Alt+T", "Speech timer"]],
  },
  {
    id: "theirs",
    name: "Their docs",
    line: "The other team's doc off SpeechDrop, a .docx, a PDF or a paste — opened to rehighlight and send from.",
    idea: <p>A doc of theirs opens in the same editor as your files, marked <b>Theirs</b>, with the same outline and keys, and Flow can take it down in one go. It&apos;s kept with your recent docs, never in your library.</p>,
    moves: [
      <>In the <b>Round</b> tab, type their <b>SpeechDrop</b> room and press <b>Look</b>, then click a file. Or open a .docx or PDF, or paste a Google Doc.</>,
      <>Rehighlight a card: {K("Alt+G")} greys their highlighting, {K("Alt+Z")} marks your own words, {K("Alt+Enter")} sends it to your speech doc.</>,
      <><b>Keep as mine</b> copies it into a file of your own — and into the library search.</>,
      <><b>Your partner&apos;s flow</b>: in the Round tab, connect Google once and paste the Doc&apos;s link. Its tab called <b>flow</b> becomes tables you write into — new lines go into the Doc a moment after you stop.</>,
    ],
    keys: [["Alt+G", "Grey their highlighting"], ["Alt+Z", "Highlight yours"], ["Alt+Enter", "Send to your speech doc"]],
  },
  {
    id: "popout",
    name: "Pop-outs",
    line: "The speech doc or their doc in a small window that stays on top.",
    idea: <p><b>⋯ › Pop out</b> opens one doc in a small window that floats above everything (in Chrome and Edge). It stays live as the doc changes, and it can&apos;t be typed into, so it never gets in the way.</p>,
    keys: [["Ctrl+F", "Search in it"], ["+ / -", "Bigger or smaller"]],
  },
  {
    id: "yours",
    name: "Make it yours",
    line: "Colours, layouts, keys — and room to work.",
    idea: <p>The half-moon button in the bar picks the <b>colours</b> (Ink is coda&apos;s own) and the <b>layout</b> — Classic, Desk, Mirror, Stack, Focus, Cockpit, Stage, Dock, Twin, Deck. {K("Alt+L")} steps through layouts. The menu stays open so you can try one after another.</p>,
    moves: [
      <><b>Keys</b> (your initial, top right, or the command menu) moves any key: click one, press the new key. The cite format is there too.</>,
      <>{K("Alt+M")} hides the format bar; the keys keep working, and ⋯ has every button.</>,
      <>{K("Alt+S")} hides the side; drag its edge to widen it for the search.</>,
      <><b>Spelling</b> checks what you write and leaves the cards you cut alone; {K("Alt+K")} switches it to everything, or off.</>,
    ],
    keys: [["Alt+L", "Next layout"], ["Alt+M", "Hide the format bar"], ["Alt+S", "Hide the side"], ["Alt+K", "Spelling"], ["Ctrl+S", "Save (it saves by itself too)"]],
  },
];

const DONE_KEY = "tutorial.done.coda";

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
  const doneFns = useMemo(() => Object.fromEntries(CHAPTERS.map((x) => [x.id, () => mark(x.id)])), [mark]);
  // every key in every chapter, for the key tester at the end
  const allKeys = useMemo(() => CHAPTERS.flatMap((x) => (x.keys || []).map(([k, what]) => ({ tool: x.name, k, what }))), []);
  const demoFor = (id: string) => {
    const props = { onDone: doneFns[id], done: tried.has(id) };
    switch (id) {
      case "window": return <WindowDemo {...props} />;
      case "cut": return <CutterDemo {...props} />;
      case "search": return <EvidenceDemo {...props} />;
      case "command": return <PaletteDemo {...props} />;
      case "theirs": return <ViewerDemo {...props} />;
      case "popout": return <PopDemo {...props} />;
      case "yours": return <KeyDemo {...props} allKeys={allKeys} />;
      default: return null;
    }
  };

  const bar = useRef<HTMLElement>(null);
  useFitBar(bar);
  const body = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(CHAPTERS[0].id);

  // which chapter is being read: the last one whose top has passed a line near the top
  useEffect(() => {
    const box = body.current;
    if (!box) return;
    let raf = 0;
    const spy = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const line = box.getBoundingClientRect().top + 140;
        let at = CHAPTERS[0].id;
        for (const s of CHAPTERS) {
          const el = document.getElementById("tu-" + s.id);
          if (el && el.getBoundingClientRect().top <= line) at = s.id;
        }
        if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) at = CHAPTERS[CHAPTERS.length - 1].id;
        setCur(at);
      });
    };
    box.addEventListener("scroll", spy, { passive: true });
    spy();
    return () => { box.removeEventListener("scroll", spy); cancelAnimationFrame(raf); };
  }, []);

  // chapters rise into place as they come into view; the speech doc's, having no Try it, is tried by reading it
  useEffect(() => {
    const box = body.current;
    if (!box) return;
    const io = new IntersectionObserver((es) => {
      for (const e of es) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        const id = (e.target as HTMLElement).dataset.read;
        if (id) mark(id);
      }
    }, { root: box, threshold: 0.15 });
    box.querySelectorAll(".tu-sec, .tu-end2").forEach((el) => io.observe(el));
    box.querySelectorAll("[data-read]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [mark]);

  const go = (id: string) => {
    const el = document.getElementById("tu-" + id), box = body.current;
    if (el && box) box.scrollTo({ top: el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 18, behavior: "smooth" });
  };

  const n = tried.size, total = CHAPTERS.length, all = n >= total;
  const R = 15, C = 2 * Math.PI * R;
  return (
    <div className="tut">
      <header className="tu-top" ref={bar}>
        <Link className="back mono" href="/tools/magic" title="Back to coda">←</Link>
        <div className="brand mono">coda · Tutorial</div>
        <div className="tu-gap" />
        <ThemePicker />
      </header>
      <div className="tu-body">
        <nav className="tu-nav" aria-label="Chapters">
          <div className={"tu-ring" + (all ? " all" : "")} aria-label={`${n} of ${total} tried`}>
            <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
              <circle cx="20" cy="20" r={R} className="bg" />
              <circle cx="20" cy="20" r={R} className="fg" style={{ strokeDasharray: C, strokeDashoffset: C * (1 - n / total) }} />
            </svg>
            <div><b>{all ? "You know coda" : `${n} of ${total}`}</b><span>{all ? "Every chapter tried" : "chapters tried"}</span></div>
          </div>
          {CHAPTERS.map((s, i) => (
            <button key={s.id} type="button" className={"tu-navi" + (cur === s.id ? " on" : "")} onClick={() => go(s.id)} aria-current={cur === s.id}>
              <span className="n mono">{String(i + 1).padStart(2, "0")}</span>{s.name}
              <i className={"tu-tick" + (tried.has(s.id) ? " on" : "")} aria-label={tried.has(s.id) ? "tried" : undefined}>{tried.has(s.id) ? "✓" : ""}</i>
            </button>
          ))}
        </nav>
        <div className="tu-main" ref={body}>
          <div className="tu-hero2">
            <Grain />
            <div className="tu-hero2in">
              <p className="tu-kick">coda · the tutorial</p>
              <h1>Learn coda<span>.</span></h1>
              <p className="tu-lead2">Eight short chapters. Each has a working miniature to try it in — nothing you do there touches your files.</p>
              <div className="tu-chips">
                <span><b>8</b> chapters</span><span><b>1</b> window</span><span><Keys k="Ctrl+Shift+K" /> for everything</span>
              </div>
              <button type="button" className="tu-begin" onClick={() => go(CHAPTERS[0].id)}>Begin <span aria-hidden="true">↓</span></button>
            </div>
          </div>
          <div className="tu-col">
            {CHAPTERS.map((s, i) => (
              <section key={s.id} id={"tu-" + s.id} className="tu-sec">
                <header className="tu-sech2">
                  <span className="tu-big" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <h2>{s.name}</h2>
                    <p className="tu-line">{s.line}</p>
                  </div>
                </header>
                <div className="tu-idea">{s.idea}</div>
                {demoFor(s.id)}
                {s.moves && (
                  <>
                    <h3 className="mono">The moves</h3>
                    <ol className="tu-steps">{s.moves.map((st, j) => <li key={j}>{st}</li>)}</ol>
                  </>
                )}
                {s.keys && (
                  <>
                    <h3 className="mono">Keys</h3>
                    <div className="tu-kgrid">
                      {s.keys.map(([k, what]) => (
                        <div key={k + what} className="tu-kcard"><Keys k={k} /><span>{what}</span></div>
                      ))}
                    </div>
                  </>
                )}
                {s.tips && (
                  <>
                    <h3 className="mono">Good to know</h3>
                    <ul className="tu-tips">{s.tips.map((t, j) => <li key={j}>{t}</li>)}</ul>
                  </>
                )}
                {!demoFor(s.id) && <span className="tu-readmark" data-read={s.id} aria-hidden="true" />}
              </section>
            ))}
            <div className={"tu-end2" + (all ? " all" : "")}>
              <Grain />
              <div className="tu-end2in">
                <p className="tu-kick">{all ? "Every chapter tried" : `${n} of ${total} chapters tried`}</p>
                <h2>{all ? "You know coda." : "That's coda."}</h2>
                <p>Cut, search, send, read. Everything else is one box away: <Keys k="Ctrl+Shift+K" />.</p>
                <Link className="tu-begin" href="/tools/magic">Open coda <span aria-hidden="true">→</span></Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
