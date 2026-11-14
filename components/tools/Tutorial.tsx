"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ThemePicker from "./ThemePicker";
import { useFitBar } from "./fitBar";
import { Keys, MapDemo, EvidenceDemo, CutterDemo, FlowDemo, DocFlowDemo, ViewerDemo, SplitDemo, PopDemo, PastDemo, EveryDemo } from "./TutorialDemos";
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
        <p><b>Round Magic</b> is where the evidence lives: your files, cut by key; the library search; the speech doc; and the other team&apos;s
          docs, all in one window. <b>Flow</b> (or <b>Doc flow</b>) is where the round is flowed, and a card you send in Round Magic shows up there
          ready to flow. One room code joins you and your partner in Flow and in one shared speech doc.</p>
      </>
    ),
    steps: [
      <>Before the tournament, cut into files of your own in <b>Round Magic</b>, or <b>import your blocks</b> (More › Import). Either way they&apos;re in the library search.</>,
      <>In the round, open <b>Split screen</b> with Round Magic on one side and Flow (or Doc flow) on the other.</>,
      <>When the other team sends their case, open it from the <b>Round</b> tab (SpeechDrop, a file, or a paste). It opens in the same editor, to rehighlight and send from.</>,
      <>Start a <b>room</b> in Flow and read the code to your partner. They join it in their Flow and in Round Magic, and you share one speech doc.</>,
      <>After the round, the flow is already in <b>Past flows</b>. Start the next one without losing anything.</>,
    ],
    tips: [
      <>Everything is kept in this browser, separately for each account. Nothing is uploaded unless you share a room, and a room passes changes straight between the two browsers.</>,
      <>Every tool has the same buttons in its banner: <b>Colours</b> (scheme and feel), <b>Full screen</b>, <b>Pop out</b> and <b>Split</b>. They&apos;re explained at the end.</>,
      <>{K("Ctrl+Shift+K")} in any tool opens <b>Jump</b>. Type a couple of letters of another tool and press {K("Enter")} to go there, still on the same flow.</>,
    ],
  },
  {
    id: "magic",
    name: "Round Magic",
    line: "The card cutter, the library, the speech doc and their docs: one window for the round.",
    open: [{ href: "/tools/magic", label: "Open Round Magic" }, { href: "/tools/split?a=magic&b=flow", label: "Round Magic beside Flow" }],
    idea: <p>Down the side, four tabs: the <b>outline</b> of whatever the cursor is in, your <b>files</b>, the library <b>search</b> and the <b>round</b> (SpeechDrop and the other team&apos;s docs). In the middle, the file you&apos;re cutting. The ribbon on top works in whichever document has the cursor, the speech doc included. Each button shows what it does to the text, and hovering one shows its key.</p>,
    steps: [
      <><b>EDIT</b> is just the file. <b>SPLIT</b> ({K("Alt+B")}) puts the speech doc beside it, <b>SPEECH</b> ({K("Alt+Shift+B")}) is the speech doc alone, the whole width, with the ribbon and outline working in it, and <b>READ</b> ({K("Alt+Shift+R")}) shows the speech doc or the file the way you&apos;ll read it: tags big, highlighted words large and the rest small and grey (or hidden), with how long it takes at your pace and each card&apos;s time down the side. {K("Esc")} goes back.</>,
      <>Put the cursor in a card and press {K("Alt+Enter")} to <b>send</b> it to the speech doc. On a block heading, the whole block goes. It lands <b>where the speech doc&apos;s cursor is</b> — after the card it&apos;s in, or at the top of a block whose heading it&apos;s on — and a dashed line in the speech doc shows that spot while you&apos;re searching. A single card sent into a block comes without its own block heading; each card you send goes after the last, in order. Until you&apos;ve clicked in the speech doc, cards go at its end.</>,
      <><b>Tags only</b> ({K("Alt+H")}, or TAGS ONLY on the speech doc&apos;s head — TAGS on a file&apos;s): every card folds down to its tag, with a small ▸ after it, so the doc reads as an outline you can drag around. Nothing is deleted; the ▸ opens just that card (its ▾ hides it again), ↑ ↓ step from tag to tag, and the same key shows everything again. The speech doc remembers it.</>,
      <><b>Reordering</b>: point at any tag or block heading and a ⋮⋮ shows in the margin — drag it to move the card (or the block, with everything under it); a line shows where it&apos;ll land, Esc puts it back, and near the top or bottom the page scrolls. A click on ⋮⋮ selects the whole card, for Delete or Ctrl+X. {K("Alt+↑")} / {K("Alt+↓")} move the one you&apos;re in a place at a time, and the outline in the side drags too.</>,
      <>{K("/")} (or {K("Alt+/")} while typing) jumps to the library search. Type a trigger, move with {K("↑ ↓")}, and {K("Enter")} sends to the speech doc — {K("Shift+Enter")} puts the card in the file you&apos;re in instead, and {K("Ctrl+Enter")} opens it as a page of its own (a card from one of your files opens that file, at the card). With the mouse: click a card to send it, click a block to open or fold it (the → on a block sends all of it). The card the mark is on shows its cite and what it reads, and a ✓ marks what is already in the speech doc. <b>Bins</b> is one line naming what&apos;s in this round — click it to switch bins. Switch <b>Library</b> to <b>Caselist</b> to search this year&apos;s open caselist. The search knows a denial from a claim: &ldquo;econ decline doesn&apos;t cause war&rdquo; finds the cards that say it doesn&apos;t, and leaves out the ones that say it does.</>,
      <>The search reads the cards, not only their tags: a card tagged &ldquo;1. They&apos;re wrong&rdquo; is found by what it says, and the words that found it show under the tag.</>,
      <>The speech doc is a page like any other. With the cursor in it, the ribbon, the outline and the status line follow it there: cut, highlight, reformat and reorder it with the same keys. <b>OUTLINE</b> in its head shows it as a list in the side — click a heading to go there, drag one to move it and everything under it, × to take it out — and <b>DOC</b> has Format, Copy, .docx, SpeechDrop, Rebuild and Clear.</>,
      <><b>Share</b> (top right) gives the file you&apos;re in a link. Whoever is signed in and opens it has the file in their own list and is in it with you — both typing at once, each other&apos;s cursor in view, saved for both — the way a Google Doc works. Stop sharing and the link stops; everyone keeps their copy.</>,
      <><b>Room</b> (beside it) shares the speech doc with your partner. You both write it, and every card either of you sends lands in it.</>,
      <>The status line shows where you are (pocket › hat › block › tag), which card, and how many words you&apos;ll read and how long they take. {K("Alt+T")} opens the <b>speech timer</b>.</>,
      <>Room to work: the chevron in a group&apos;s corner folds it into one button (its buttons open under it), and {K("Alt+M")} folds the whole ribbon to one line. Drag the side&apos;s edge (or its ⇔ button) to widen it for the search.</>,
      <><b>Spelling</b> is the browser&apos;s own checker: right-click a red underline for what it should be, or to add the word to the dictionary. It checks what you write (tags, analytics, headings, notes) and leaves the cards you cut alone; {K("Alt+K")} (or More › Spelling) switches it to everything, or off.</>,
      <><b>Layout</b> is at the top of the same menu, or {K("Alt+L")} steps through them: <b>Classic</b>; <b>Desk</b>, the pages laid on the palette&apos;s colour with room round them; <b>Mirror</b>, the side on the right and the speech doc on the left; <b>Stack</b>, the speech doc under the file (drag the edge between them up or down); and <b>Focus</b>, the ribbon on one line, no site bar, and the side tucked away — point at the left edge, or press {K("Alt+S")} or {K("Alt+/")}, and it slides out. And three that take the window apart: <b>Cockpit</b> (the outline on the left and the search on the right, both always open, your pages between); <b>Stage</b> (the page you&apos;re in, front and centre, the other leaning in from the side — click into it to swap); <b>Dock</b> (the ribbon a floating dock at the bottom, the pages running to the top); <b>Twin</b> (the speech doc as you write it, and beside it a second look at it — verbatimised, or tags only — that follows your cursor; click in it to jump there); and <b>Deck</b> (one page at a time, full width, in tabs along the top — {K("Alt+[")} and {K("Alt+]")} flip, and the speech doc&apos;s tab flashes when a card lands in it). A <b>&gt;</b> typed in the search ({K("Ctrl+P")} gets you there) lists every command by name.</>,
      <><b>Colours</b> (the swatch, top right) picks the palette — Graphite, Ember, Forest, Navy, Oxblood, Paper, and the louder six: Midnight (cyan), Synthwave (hot pink), Aurora (mint), Volt (acid lime), Dusk (amber) and Glacier (ice and cobalt); and six light ones that each change the feel, not just the colour — Blueprint (a drafting grid, dashed rules, a technical mono face), Sakura (blush, a soft rounded face, buttons that lift), Matcha (paper grain, a double rule), Library (parchment, a gold rule, Garamond in small capitals), Lilac (a haze behind frosted panels) and Citrus (hard black outlines and offset shadows). The menu stays open so you can try them one after another; the bar at the top of the site wears the palette too. The page stays white.</>,
    ],
    keys: [
      ["Alt+Enter", "Send the card (or block) you're in to the speech doc"],
      ["Alt+B", "The speech doc beside the file (again: just the file)"],
      ["Alt+Shift+B", "Just the speech doc (again: a file beside it)"],
      ["Alt+H", "Tags only: every card folded to its tag, to reorder the doc (again: everything back)"],
      ["Alt+Shift+R", "Read mode (again, or Esc: back)"],
      ["/ or Alt+/", "Search the library and the caselist"],
      ["Alt+T", "Speech timer"],
      ["Alt+S", "Hide or show the side"],
      ["Alt+M", "Fold the ribbon to one line (again: back)"],
      ["Alt+K", "Spelling: what you write, everything, or off"],
    ],
    tips: [
      <>Everything from the Card cutter, Evidence and the Doc viewer is here; their old addresses open Round Magic.</>,
      <><b>More</b> has the library&apos;s Import, Case, Export and Settings, and <b>Pop out</b> for the speech doc or a doc of theirs.</>,
      <>Full screen (the corner button) lets Round Magic have the keys Chrome or an extension would otherwise take, like Ctrl+N.</>,
    ],
  },
  {
    id: "evidence",
    name: "The library",
    line: "Round Magic's search: your blocks and files, searchable by trigger. Send cards, build the speech doc, format it for the other team.",
    open: [{ href: "/tools/magic", label: "Open Round Magic" }],
    idea: <p>Every file you cut is in the library already. Blocks from elsewhere: paste in your evidence doc once. Its headings become blocks (Heading 3) and taglines (Heading 4), so the whole file is searchable by what it answers. Sending a card copies it, adds it to the send list and puts it in your send doc, ready to format and send.</p>,
    steps: [
      <>Open your evidence doc in Google Docs, press {K("Ctrl+A")} then {K("Ctrl+C")}, click <b>More › Import</b> in Round Magic and paste.</>,
      <>Press {K("/")} and type a trigger (&ldquo;econ&rdquo;, &ldquo;AT: heg&rdquo;). Move with {K("↑ ↓")}. {K("→")} opens a block&apos;s arguments so you can send just one.</>,
      <>Press {K("Enter")} to send. The card is copied and goes into the <b>speech doc</b> (SPLIT shows it), and its block and tag show in the speech doc&apos;s <b>OUTLINE</b>. Cards from the same block merge into one block. Delete a card from the doc and it's gone for good; sending more never brings it back.</>,
      <>Click <b>DOC › Format for sending</b> in the speech doc&apos;s head. It asks for your code, the speech and the tournament once, then titles the doc, can delete analytics (and put them back), makes highlighting one colour (grey stays grey), numbers responses (or doesn&apos;t), and adds the speech to each heading.</>,
      <>To search the open caselist, switch <b>Library</b> to <b>Caselist</b>. It searches this year&apos;s cards by their tags, the blocks they sit in and their highlighted words, with the strongest teams&apos; cards first.</>,
      <>Click <b>Room</b> to share the speech doc with your partner. It&apos;s the same code as your flow room.</>,
    ],
    keys: [
      ["/", "Search"],
      ["↑ ↓", "Move through results"],
      ["→ / Tab", "Open a block's arguments"],
      ["Enter", "Copy and send"],
      ["Esc", "Clear the search"],
      ["Delete", "Remove from your library"],
    ],
    tips: [
      <><b>+ Analytic</b> adds a tagline you write yourself under the last card.</>,
      <>The speech doc&apos;s <b>OUTLINE</b> is what is in it: every block and tag. Click one to jump there, drag it to move it, × to take it out.</>,
      <>Round Magic&apos;s <b>READ</b> mode shows the speech doc as you&apos;ll read it — only what&apos;s highlighted — timed.</>,
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
      <>Open the drawer with {K("Ctrl+J")}. It has <b>Notes</b>, <b>Cards</b> (tags you sent from Round Magic), <b>Round vision</b> and <b>Send doc</b>. In Send doc, <b>Flow all ↓</b> puts every block beside the argument it names. &ldquo;AT: Midterms&rdquo; finds &ldquo;Contention 2 is MIDTERMS&rdquo;, and each response goes beside the next sub-point.</>,
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
    id: "cutter",
    name: "Cutting cards",
    line: "Round Magic's files: cut cards into files of your own, one key per move. Every file is in the library search too.",
    open: [{ href: "/tools/magic", label: "Open Round Magic" }],
    idea: <p>A file is a cut file: pocket, hat, block, tag, and under each tag its cite and the card. Each move is one key, and any of them can be moved. Files save as you go, and each one is in the library search too, updated whenever you save.</p>,
    steps: [
      <>Make a file with <b>New file</b>, or <b>Open .docx</b> to bring in one you have (cite, underline, emphasis and highlighting come with it). Rename a file with its <b>✎</b> in the list (or double-click its name), or click the open file&apos;s name in the ribbon. The library takes the new name too.</>,
      <>Paste the article. {K("Ctrl+Shift+V")} pastes without the source&apos;s formatting, and {K("Alt+Q")} (condense) joins the lines a PDF breaks it into. Select a stretch you won&apos;t read and press {K("Alt+Shift+Q")}: it stays in the card, whole, at 6pt, with ¶ where the paragraphs broke and a line before and after saying so.</>,
      <>Type the tag and press {K("Alt+4")}. Select the author and date and press {K("Alt+C")} for the cite.</>,
      <>Select what matters and press {K("Ctrl+Alt")} (together, then let go) to cut it (underlined, at 11pt); press it again on cut words for emphasis (bold, underlined, boxed), and a third time to take it all off. {K("Ctrl+Shift+Space")} goes straight to emphasis, {K("Alt+Z")} to highlight. With nothing selected, a key works on the word the cursor is in. A double-click takes the word without the space after it, so a highlight stops where the word does.</>,
      <>{K("Ctrl+N")} shrinks everything that is neither underlined nor bold to 8pt. Chrome keeps Ctrl+N for a new window, so it works with the cutter full screen; anywhere else, give shrink another key. {K("Alt+N")} starts the next card. The coloured squares pick the highlighter, and {K("Alt+Shift+Z")} cycles through them.</>,
      <><b>Extensions</b>, the way a 1AR file is written: put the speech in a pocket ({K("Alt+1")}, &ldquo;1AR&rdquo;), then {K("Alt+X")} for each block. It starts a new page with a heading that already ends in &ldquo;---1AR&rdquo;; type &ldquo;AT: Presumption&rdquo; and press {K("Enter")}, and each line you write under it is a Heading 4 (bold, 13pt); {K("Enter")} on an empty one ends the run. {K("Ctrl+Alt")} underlines the words that matter, and {K("Alt+Shift+X")} turns any line into an analytic or back. {K("Ctrl+Enter")} adds a page break anywhere, and the .docx keeps them.</>,
      <>Cards you&apos;re pointing at, not reading: {K("Alt+Shift+G")} finds a card in any file and puts it in under your line as a reference, with &ldquo;&lt;&lt;FOR REFERENCE---Lange 23&gt;&gt;&rdquo; (its author, from its cite) under its tag and its highlighting grey. {K("Alt+G")} does the same to a card already there (again: back). Select part of one first to grey just that. Grey isn&apos;t counted as read.</>,
      <>More than one page when you want it: <b>Pages</b> in the ribbon, or {K("Alt+R")} for the read view beside you. It follows the card you&apos;re editing, and clicking a card in it takes you there. Two places in one file, another file beside, or a new file to write extensions next to the cards: up to three pages, each with its own file and Edit / Read on one thin line. A file open twice stays one document. Drag between pages to resize; {K("Alt+S")} hides the side for room.</>,
      <>Reorder in the <b>Outline</b> tab: drag a heading and everything under it moves with it in the file (a tag takes its card, a block its cards). {K("Alt+↑")} / {K("Alt+↓")} move the card the cursor is in one place up or down. Each move is one {K("Ctrl+Z")}.</>,
      <><b>Verbatimise</b> ({K("Alt+V")}) shows just the highlighting: each card&apos;s tag and cite, then only the words you&apos;ll read, with how many there are and how long they take. Nothing in the file changes; {K("Alt+V")} again goes back to editing.</>,
      <>Cards from somewhere else? <b>Reformat</b> ({K("Alt+Shift+W")}) makes them look cut here: tags that pasted in as bold lines become tags again, every highlight in your highlighter&apos;s colour (grey stays grey), bold-and-underlined words boxed as emphasis, card text at 11pt where it&apos;s read and 8pt where it&apos;s shrunk, pasted fonts and text colours gone, the spaces cleaned up, and bracketed cites (&ldquo;Olech 26 [title, pub, date, link, quals//Spence]&rdquo;) rewritten in your cite format (under <b>Keys</b>; it starts as <code>%author% %y%. &quot;%title%&quot;. %date%. %url%. elimafia 🕵</code>), so &ldquo;Aleksander <b>Olech 26.</b> &ldquo;Title&rdquo;. 2-19-2026. https://….&rdquo; The whole file, or just what you select.</>,
      <>Select any part of a file to see its word count in the corner: all its words, how many you&apos;d read (highlighted card text, tags and analytics; grey left out) and how long that takes.</>,
      <>Search every file from the <b>Files</b> tab by tag, cite, block or the words that are read. In the library search the same cards come up, kept up to date as you cut — without the list moving while you type.</>,
    ],
    keys: [
      ["Ctrl+Alt", "Cut: underline, at 11pt (press both, let go)"],
      ["Ctrl+Alt Ctrl+Alt", "Twice: emphasis (a third time: plain)"],
      ["Ctrl+N", "Shrink what is neither underlined nor bold (full screen)"],
      ["Alt+Z", "Highlight (green to start with)"],
      ["Ctrl+Shift+Space", "Emphasis: bold, underlined, boxed"],
      ["Alt+C", "Cite"],
      ["Alt+1 / Alt+2 / Alt+3 / Alt+4", "Pocket, hat, block, tag (the same key again: back to normal text)"],
      ["Ctrl+\\", "Clear formatting"],
      ["Alt+W", "Clean up: marks off the spaces they spilled onto, double spaces to one"],
      ["Alt+Shift+W", "Reformat: one highlight colour, emphasis boxed, pasted fonts off, cleaned up"],
      ["Alt+Q", "Condense the card into one paragraph"],
      ["Alt+Shift+Q", "Condense, none omitted: the selected paragraphs into one at 6pt, ¶ where each broke, between <<TEXT CONDENSED - NONE OMITTED>> and <<PARAGRAPH BREAKS RESUME>>"],
      ["Alt+↑ / Alt+↓", "Move the card (or block) the cursor is in up or down"],
      ["Alt+X", "New extension: a new page, a heading ending in the speech, bold lines under it"],
      ["Alt+Shift+X", "Make a line an analytic, Heading 4 (again: plain)"],
      ["Ctrl+Enter", "Page break"],
      ["Alt+G", "The card here kept for reference: grey, <<FOR REFERENCE---its author>> (again: back)"],
      ["Alt+Shift+G", "Find a card in any file and put it here as a reference"],
      ["Alt+V", "Verbatimise this page: just the highlighting (again: back)"],
      ["Alt+R", "The read view beside you, following your card (again: closes it)"],
      ["Alt+.", "The cursor to the next page"],
      ["Alt+S", "Hide or show the side"],
      ["Alt+N", "New card"],
      ["Ctrl+S", "Save (it also saves by itself)"],
      ["Ctrl+Shift+F", "Search every file"],
    ],
    tips: [
      <><b>Keys</b> (the keyboard button in the ribbon) moves any of them: click one, press the new key.</>,
      <>Deleting a file takes its cards out of the library too. <b>.docx</b> downloads the file for Word or Google Docs.</>,
    ],
  },
  {
    id: "viewer",
    name: "Their docs",
    line: "Round Magic's Round tab: the other team's doc off SpeechDrop, a .docx, a PDF or a paste, opened to rehighlight and send from.",
    open: [{ href: "/tools/magic", label: "Open Round Magic" }],
    idea: <p>A doc of theirs opens in the same editor as your files, marked <b>THEIRS</b>, with the same outline, keys and Read mode. It&apos;s kept with your recent docs, never in your library.</p>,
    steps: [
      <><b>Your partner&apos;s flow, in its Google Doc:</b> paste the Doc&apos;s link under <b>Partner&apos;s flow</b> in the <b>Round</b> tab and press <b>Open</b>. The Doc&apos;s text opens beside your speech doc, just the page — no menus or toolbar — to write in together, live ({K("Ctrl+B")}, {K("Ctrl+I")}, {K("Ctrl+U")} and the right-click menu format it) (you need to be signed into Google with access to it, or it shared <b>Anyone with the link</b> as Editor). <b>READ</b> shows it formatted instead, read again every few seconds, and a click on a line looks for it in the library. <b>DOCS ↗</b> opens it in its own tab; <b>FILE</b> goes back to your file.</>,
      <>In the <b>Round</b> tab, type their <b>SpeechDrop</b> room code and press <b>Look</b>, then click a file. Or <b>Open theirs</b> for a .docx or PDF, or <b>Paste a doc</b> for a Google Doc.</>,
      <>Use the <b>Outline</b> to jump around, and <b>READ</b> to see how long their speech is.</>,
      <>Rehighlight a card: select its text and press {K("Alt+G")} to grey their highlighting, then {K("Alt+Z")} your own words green. {K("Alt+Enter")} sends it to your speech doc.</>,
      <><b>Keep as mine</b> copies it into a file of your own, which puts it in the library search too.</>,
    ],
    keys: [
      ["Alt+G", "Grey the highlighting in what's selected (or the card)"],
      ["Alt+Z", "Highlight in your colour"],
      ["Alt+Enter", "Send the card to your speech doc"],
    ],
    tips: [<>A PDF opens in the browser&apos;s own reader, to read rather than cut. <b>More › Pop out</b> gives their doc a window of its own that stays on top.</>],
  },
  {
    id: "split",
    name: "Split screen",
    line: "Any two tools side by side in one window.",
    open: [{ href: "/tools/split", label: "Open Split screen" }],
    idea: <p>Each side is the whole tool, with its own keys, so typing in one never triggers the other&apos;s shortcuts. The two still talk to each other the way two tabs do.</p>,
    steps: [
      <>Pick what goes on each side from the strip at the top: Round Magic, Flow or Doc flow. Picking what the other side has swaps them.</>,
      <>Drag the line between them to resize. Arrow keys nudge it, and double-clicking makes it half and half. <b>⇄</b> swaps the sides.</>,
      <><b>×</b> on a side closes it, and the other tool takes the whole window.</>,
      <><b>Round mode</b> (the button over the line, in the strip) goes full screen and clears the clutter away. The site menu disappears, the strip tucks above the top edge until your pointer comes up to it, and each tool's banner gets shorter, with its key hints put away. {K("Esc")} leaves it.</>,
    ],
    tips: [
      <>The <b>Split</b> button in any tool opens Split screen with that tool on the left, still on the same flow and still in its room.</>,
      <>A good setup for a round: Flow and Round Magic in <b>Round mode</b>, with Round Magic in SPLIT so the speech doc is in view.</>,
    ],
  },
  {
    id: "popout",
    name: "Pop-outs",
    line: "One thing from a tool, in a small window of its own, to keep an eye on.",
    idea: <p><b>Pop out</b> (the arrow-out-of-a-box icon in each banner) opens a small window with one thing in it. It <b>stays on top</b>, floating above both halves of Split screen and above other apps, so clicking elsewhere never hides it (in Chrome and Edge; other browsers get an ordinary window). It stays live, and it can&apos;t be typed into, so it never conflicts with the tool itself.</p>,
    steps: [
      <>From <b>Round Magic</b> (More › Pop out): the speech doc as it&apos;s written, or a doc of theirs. Only one pop-out floats at a time, so a second one (the other team&apos;s other doc, say) opens as an ordinary window beside it.</>,
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
    line: "Jump between tools by typing, and the four buttons in every banner.",
    idea: <p>One key gets you from any tool to any other, and the Colours button and the three icons at the right of each banner work the same way everywhere.</p>,
    steps: [
      <><b>Jump</b>: press {K("Ctrl+Shift+K")} in any tool, type a few letters (&ldquo;rm&rdquo;, &ldquo;flow&rdquo;, &ldquo;doc&rdquo;) and press {K("Enter")}. With nothing typed, {K("Enter")} goes back to the tool you were just in, and a number picks its row. You stay on the same flow.</>,
      <>In Split screen, Jump changes the side you pressed it in, so the other side keeps going. Rows further down put a tool on the other side, swap the sides, start round mode, or leave the split. From a tool on its own, &ldquo;Flow + Round Magic&rdquo; opens those two side by side.</>,
      <><b>Colours</b> offers seventeen schemes (Forest, Paper, Navy, Oxblood, Graphite; the louder Midnight, Synthwave, Aurora, Volt, Dusk and Glacier; and the light Blueprint, Sakura, Matcha, Library, Lilac, Citrus) and a <b>Feel</b>. <b>Sharp</b> is square and crisp. <b>Cozy</b> is warm and rounded, with a softer typeface and lamp-light. The choice applies to every tool in this browser.</>,
      <><b>Full screen</b> gives the tool the whole screen, even from a side of Split screen. {K("Esc")} brings it back.</>,
      <><b>Pop out</b> is covered above.</>,
      <><b>Split</b> opens Split screen with this tool on the left.</>,
    ],
    keys: [
      ["Ctrl+Shift+K", "Jump to another tool"],
      ["Enter", "Go (with nothing typed: back to the last tool)"],
      ["1–9", "Go straight to that row"],
      ["Esc", "Close Jump"],
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
      case "cutter": return <CutterDemo {...props} />;
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
