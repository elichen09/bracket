"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { DOMParser as PMParser, DOMSerializer, Fragment as PMFragment, type Node as PMNode } from "prosemirror-model";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { undoCommand, redoCommand, ySyncPlugin, yCursorPlugin, yUndoPlugin, initProseMirrorDoc, prosemirrorToYXmlFragment } from "y-prosemirror";
import { openShare, createShare, stopShare, peekShare, shareLink, NotShared, type Shared } from "@/lib/cutter/share";
import { schema } from "@/lib/evidence/docSchema";
import { listFiles, getFile, putFile, dropFile, newFileId, type CutMeta, type CutFile } from "@/lib/cutter/store";
import * as C from "@/lib/cutter/commands";
import * as X from "@/lib/cutter/extensions";
import * as R from "@/lib/cutter/reference";
import { reformat } from "@/lib/cutter/reformat";
import { DEFAULT_CITE_FORMAT } from "@/lib/cutter/cites";
import { ACTIONS, ACTION, comboOf, keyLabel, keyFor, actionFor, bind, refuse, caveat, loadKeys, saveKeys, watchChords, type Overrides } from "@/lib/cutter/keys";
import { docxToHtml } from "@/lib/cutter/docxIn";
import { sanitize, readTime } from "@/lib/viewer/doc";
import { textToHtml } from "@/lib/viewer/draw";
import { listDocs, getDoc, keepDoc, dropDoc, newDocId, type ViewDoc, type ViewMeta, type DocKind } from "@/lib/viewer/store";
import { verbatimPlugin, verbKey, readWords, countIn } from "@/lib/cutter/verbatim";
import { spellPlugin, spellKey, SPELL_MODES, type SpellMode } from "@/lib/cutter/spell";
import { placePlugin, placeCard } from "@/lib/cutter/place";
import { gripPlugin } from "@/lib/cutter/grips";
import { foldPlugin, setFolded as foldTags, isFolded } from "@/lib/cutter/fold";
import { RM_PALETTE_KEY } from "@/lib/toolTheme";
import { buildSearch, searchCards } from "@/lib/caselist/search.js";
import { openBus, type Bus } from "@/lib/toolsBus";
import { scoped } from "@/lib/owner";
import { useFullscreen } from "./FullBtn";
import { popOut } from "./PopBtn";
import DocEditor, { type DocApi } from "./DocEditor";
import MagicRead, { clock } from "./MagicRead";
import "./evidence.css";
import "./finish.css";
import "./magic.css";

/**
 * Round Magic — the Card cutter, Evidence and the Doc viewer as one tool.
 *
 * The three were one round's work split across three tabs: cut a card in the
 * cutter, go to Evidence to find it again and send it, go to the viewer to
 * read the other team's doc. Here they are one window and one editor:
 *
 *  - the page in the middle is any of your files (the cutter's workspace: one
 *    page, or up to three, each to edit or verbatimise), or any doc of theirs
 *    — a SpeechDrop file, a .docx, a paste — opened in the same editor, with
 *    every cutting key, and kept apart from your library;
 *  - beside it, when you want it (Split), the speech doc — Evidence's send
 *    doc, shared with your partner when you are in a room; Alt+Enter sends
 *    the card the cursor is in to it, and the ribbon works in it too;
 *  - down the side, the outline of whatever you are in, your files, the
 *    library search (Evidence's engine, mounted here: Enter sends), and the
 *    round — SpeechDrop and the docs you have opened of theirs;
 *  - Read mode, the speech doc or the file as you will read it, timed.
 *
 * Evidence's engine draws its own DOM, found by id under the element it is
 * booted on — so it is booted on this whole tool, and its pieces (the search,
 * the speech doc, its dialogs) sit wherever the layout wants them, each in an
 * `.evi` wrapper that keeps its stylesheet scoped. Nothing here may carry the
 * attributes its click handler reads (data-act, data-tab, data-oh, data-del)
 * unless it means them.
 */

const parser = () => PMParser.fromSchema(schema);
const toHtml = (doc: PMNode) => {
  const holder = document.createElement("div");
  holder.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  return holder.innerHTML;
};
const fromHtml = (html: string) => {
  const holder = document.createElement("div");
  holder.innerHTML = html || "<p></p>";
  return parser().parse(holder);
};
const docOf = (f: CutFile) => {
  try { return f.doc ? schema.nodeFromJSON(f.doc as object) : fromHtml(f.html); } catch { return fromHtml(f.html); }
};
const when = (t: number) => {
  const d = new Date(t), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
};
/**
 * A .docx read in before its highlight colours were fixed (lib/viewer/wordColors.ts) carries
 * Word's "green" as CSS drew it — a dark green. Opening it again brings it back to the green it was.
 */
const DARK_GREEN = /^(#008000|#006400|green|darkgreen|rgb\(0,\s*(128|100),\s*0\))$/i;
function brightenGreens(doc: PMNode): PMNode | null {
  const tr = EditorState.create({ doc }).tr;
  const H = schema.marks.highlight;
  doc.descendants((n, pos) => {
    if (!n.isText) return;
    const m = n.marks.find((x) => x.type === H && DARK_GREEN.test(String(x.attrs.color).trim()));
    if (m) { tr.removeMark(pos, pos + n.nodeSize, H); tr.addMark(pos, pos + n.nodeSize, H.create({ color: "#00ff00" })); }
  });
  return tr.docChanged ? tr.doc : null;
}
/** Their tag, cut to what a heading says: its numbering off, its first clause, a dozen words at most. */
function headOf(t: string) {
  const s = t.replace(/\s+/g, " ").trim().replace(/^\(?\d{1,2}[.)\]:]?\s*[—–-]*\s*/, "");
  const cut = s.split(/\s*(?:-{2,}|—|–|;|\.\s)\s*/)[0] || s;
  const w = cut.split(" ");
  return (w.length > 12 ? w.slice(0, 12).join(" ") + "…" : cut).replace(/[.:,]+$/, "");
}
/** Where a heading that says this is, or -1. */
function headPos(doc: PMNode, text: string) {
  const want = text.trim().toLowerCase();
  let pos = -1;
  doc.forEach((n, p) => { if (pos < 0 && n.type === schema.nodes.heading && n.textContent.trim().toLowerCase() === want) pos = p; });
  return pos;
}
/** A partner's caret in a shared file: a bar in their colour, their name over it. */
function mateCaret(user: { name: string; color: string }) {
  const el = document.createElement("span");
  el.className = "rm-caret";
  el.style.setProperty("--c", user.color);
  const tag = document.createElement("span");
  tag.className = "rm-caret-name";
  tag.textContent = user.name;
  el.append("\u2060", tag, "\u2060");
  return el;
}
const countWords = (doc: PMNode) => (doc.textContent.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A doc of theirs, in a page: its id in the Doc viewer's store, marked so it is never mistaken for a file of yours. */
const THEIRS = "v:";
const isTheirs = (id: string) => id.startsWith(THEIRS);
const SOURCE: Record<string, string> = { room: "Partner", speechdrop: "SpeechDrop", file: "Opened", paste: "Pasted", library: "From your library", caselist: "Off the caselist" };
const kindOf = (name: string, type = ""): DocKind => {
  const n = name.toLowerCase();
  if (n.endsWith(".docx") || type.includes("wordprocessingml")) return "docx";
  if (n.endsWith(".pdf") || type.includes("pdf")) return "pdf";
  if (n.endsWith(".html") || n.endsWith(".htm") || type.includes("html")) return "html";
  return "text";
};

interface Head { level: number; text: string; pos: number }
/** One page of the workspace: which file (or doc of theirs), and whether it is for editing or reading. */
interface Pane { key: string; fileId: string; read: boolean; follow: boolean }
type Mode = "edit" | "split" | "speech" | "read";
type Tab = "outline" | "files" | "search" | "round";
interface SdFile { i: number; name: string; ctime: number }

const MAX_PANES = 3;
let paneSeq = 0;
const newKey = () => "p" + (++paneSeq) + "_" + Date.now().toString(36);

/** What only makes sense with the cursor in a document. */
const IN_DOC = new Set(["pocket", "hat", "block", "tag", "cite", "underline", "emphasis", "highlight", "clear", "shrink", "condense", "paste", "new-card", "move-up", "move-down", "new-extension", "analytic", "page-break", "clean-up", "reference", "insert-reference", "reformat", "send", "condense-omitted"]);
/** What still works in a read page. */
const IN_READ = new Set(["move-up", "move-down", "send"]);

const LAYOUTS = [
  { id: "one", name: "One page", sub: "Just the file", cols: ["e"] },
  { id: "read", name: "Page + read view", sub: "Verbatimised beside you, following your card", cols: ["e", "r"], key: "read-beside" },
  { id: "two", name: "Two places in one file", sub: "Same file, each page scrolled on its own", cols: ["e", "e"] },
  { id: "other", name: "Beside another file", sub: "Your cards on one side, the file you're writing on the other", cols: ["e", "o"] },
  { id: "write", name: "Write beside the cards", sub: "A new file for extensions, next to this one", cols: ["e", "n"] },
] as const;

/** Speech lengths, for the timer. */
const CLOCKS = [
  { label: "Policy constructive · 9:00", s: 540 }, { label: "Policy rebuttal · 6:00", s: 360 }, { label: "Cross-ex · 3:00", s: 180 },
  { label: "HS constructive · 8:00", s: 480 }, { label: "HS rebuttal · 5:00", s: 300 },
  { label: "PF constructive · 4:00", s: 240 }, { label: "PF summary · 3:00", s: 181 }, { label: "PF final focus · 2:00", s: 120 },
  { label: "Prep · 10:00", s: 600 }, { label: "Prep · 8:00", s: 481 },
];

/** The colour palettes: the chrome round the page, and the accent. The page itself stays white. */
const PALETTES = [
  { id: "graphite", name: "Graphite", sub: "Charcoal, violet", chrome: "#1b1b1b", side: "#1e1e1e", acc: "#8b7cf0" },
  { id: "ember", name: "Ember", sub: "Charcoal, orange", chrome: "#1b1b1b", side: "#1e1e1e", acc: "#E97A3E" },
  { id: "forest", name: "Forest", sub: "The suite's green, terracotta", chrome: "#1F2C24", side: "#22302A", acc: "#D9694B" },
  { id: "navy", name: "Navy", sub: "Deep blue, sky", chrome: "#121A2A", side: "#151F32", acc: "#5B9BFF" },
  { id: "oxblood", name: "Oxblood", sub: "Dark red, ember", chrome: "#221416", side: "#261719", acc: "#E0703A" },
  { id: "paper", name: "Paper", sub: "Light, terracotta", chrome: "#EFEBE3", side: "#F6F3EC", acc: "#C4553A" },
  { id: "midnight", name: "Midnight", sub: "Ink black, electric cyan", chrome: "#0B0F17", side: "#0E131C", acc: "#22D3EE" },
  { id: "synthwave", name: "Synthwave", sub: "Deep indigo, hot pink", chrome: "#160F2B", side: "#1A1233", acc: "#FF4FA3" },
  { id: "aurora", name: "Aurora", sub: "Black teal, mint", chrome: "#0A1614", side: "#0D1B18", acc: "#34E0A1" },
  { id: "volt", name: "Volt", sub: "Pure black, acid lime", chrome: "#0B0B0A", side: "#0E0E0D", acc: "#D4FF3A" },
  { id: "dusk", name: "Dusk", sub: "Plum, amber", chrome: "#1F1424", side: "#23172A", acc: "#FFB454" },
  { id: "glacier", name: "Glacier", sub: "Ice, cobalt", chrome: "#E8EEF5", side: "#F1F5FA", acc: "#2563EB" },
] as const;
type PaletteId = (typeof PALETTES)[number]["id"];

/**
 * The window's layouts: where the side, the file and the speech doc sit.
 * Drawn in the menu as a picture of each — chrome, side, page, speech doc —
 * as rects on a 60×38 grid: [x, y, w, h, what].
 */
const LAYOUT_MODES = [
  { id: "classic", name: "Classic", sub: "Side left, the speech doc beside", pic: [[0, 0, 60, 6, "c"], [0, 6, 14, 32, "s"], [15, 6, 22, 32, "p"], [38, 6, 22, 32, "d"]] },
  { id: "desk", name: "Desk", sub: "Pages laid on the desk, with room round them", pic: [[0, 0, 60, 38, "c"], [2, 8, 12, 28, "s"], [16, 8, 20, 28, "p"], [38, 8, 20, 28, "d"]] },
  { id: "mirror", name: "Mirror", sub: "Speech doc left, side right", pic: [[0, 0, 60, 6, "c"], [0, 6, 22, 32, "d"], [23, 6, 22, 32, "p"], [46, 6, 14, 32, "s"]] },
  { id: "stack", name: "Stack", sub: "The speech doc under the file", pic: [[0, 0, 60, 6, "c"], [0, 6, 14, 32, "s"], [15, 6, 45, 15, "p"], [15, 22, 45, 16, "d"]] },
  { id: "focus", name: "Focus", sub: "One-line ribbon, side slides in from the edge", pic: [[0, 0, 60, 3, "c"], [10, 3, 22, 35, "p"], [33, 3, 18, 35, "d"], [0, 3, 2, 35, "s"]] },
  // the radical four: the window rearranged, not just its columns moved
  { id: "cockpit", name: "Cockpit", sub: "Outline left, search right, both always open — the pages between", pic: [[0, 0, 60, 6, "c"], [0, 6, 11, 32, "s"], [12, 6, 17, 32, "p"], [30, 6, 17, 32, "d"], [48, 6, 12, 32, "s"]] },
  { id: "stage", name: "Stage", sub: "The page you're in front and centre; the other leans in, click it to swap", pic: [[0, 0, 60, 38, "c"], [3, 4, 36, 30, "p"], [42, 9, 15, 20, "d"]] },
  { id: "dock", name: "Dock", sub: "The ribbon a floating dock at the bottom; the pages run to the top", pic: [[0, 0, 14, 38, "s"], [15, 0, 45, 38, "p"], [12, 31, 38, 5, "c"]] },
  { id: "deck", name: "Deck", sub: "One page at a time, full width, with tabs along the top — Alt+[ and Alt+] flip", pic: [[0, 0, 60, 4, "c"], [0, 4, 13, 34, "s"], [14, 5, 10, 4, "d"], [25, 5, 10, 4, "c"], [14, 9, 46, 29, "p"]] },
  { id: "spotlight", name: "Spotlight", sub: "No ribbon, no side: just the pages. Ctrl+P or / brings up cards and commands", pic: [[0, 0, 60, 38, "p"], [14, 6, 32, 15, "c"], [16, 10, 28, 3, "s"], [16, 15, 22, 2, "s"]] },
  { id: "board", name: "Flow-board", sub: "Their doc, your speech doc and the search in three columns, each tag wired to its answer", pic: [[0, 0, 60, 4, "c"], [0, 4, 19, 34, "p"], [20, 4, 19, 34, "d"], [40, 4, 20, 34, "s"], [16, 12, 8, 1, "s"], [16, 22, 8, 1, "s"]] },
] as const;
type LayoutId = (typeof LAYOUT_MODES)[number]["id"];
const SIDE_W = 290, SIDE_WIDE = 560;

/* ------------------------------------------------------------------ the ribbon's pictures */
const I = {
  folder: <svg width="16" height="16" viewBox="0 0 24 24" fill="#e8b84a" aria-hidden="true"><path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>,
  newfile: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8zM14 3v5h5M12 11v6M9 14h6" /></svg>,
  down: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>,
  keys: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></svg>,
  up: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>,
  dn: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" /></svg>,
  undo: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3" /></svg>,
  redo: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3" /></svg>,
  send: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>,
  plus: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  condense: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10" /><path d="M18 15v6M15 18l3 3 3-3" /></svg>,
  pilcrow: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M13 4v16M17 4v16M19 4H9.5a4.5 4.5 0 000 9H13" /></svg>,
  timer: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2M9 2h6" /></svg>,
  full: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>,
  pages: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M12 4v16" /></svg>,
  search: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>,
  x: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  menu: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>,
  fold: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>,
  unfold: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>,
  share: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 8v6M14 11h6" /></svg>,
  answer: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h9a7 7 0 017 7v4" /></svg>,
  wide: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M3 12h18" /></svg>,
};

export default function RoundMagic({ owner, me, room, sd, doc: sharedLink }: { owner?: string; me?: string; room?: string; sd?: string; doc?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const qIn = useRef<HTMLInputElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const theirIn = useRef<HTMLInputElement>(null);
  const panesBox = useRef<HTMLDivElement>(null);
  const workBox = useRef<HTMLDivElement>(null);
  const speechBox = useRef<HTMLDivElement>(null);
  const bus = useRef<Bus | null>(null);

  // ---- the workspace: pages, the editor in each, and what each holds ---------------
  const views = useRef(new Map<string, EditorView>());
  const viewFile = useRef(new Map<string, string>());
  const loaded = useRef(new Map<string, CutFile>());
  const theirMeta = useRef(new Map<string, ViewDoc>());     // a doc of theirs open in a page: its record in the viewer's store
  const dirty = useRef(new Set<string>());
  /** The files open here that are shared: each one's live document (lib/cutter/share.ts). */
  const shares = useRef(new Map<string, Shared>());
  const sharing = useRef(new Map<string, Promise<Shared | null>>());
  const [, setShareTick] = useState(0);
  /** What a shared document calls back into, defined further down. */
  const shareFns = useRef({ peerRenamed: (_fid: string, _t: string) => {}, unshare: (_fid: string, _why: "gone" | "stop" | "leave") => {} });
  const refCbs = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const lastFollow = useRef(new Map<string, number>());
  /** The page being worked in. */
  const view = useRef<EditorView | null>(null);
  /** The speech doc's editor (DocEditor's), and whether it, not a page, has the cursor. */
  const speechView = useRef<EditorView | null>(null);
  const inSpeech = useRef(false);
  const speechApi = useRef<DocApi | null>(null);
  const [panes, setPanesState] = useState<Pane[]>([]);
  const panesRef = useRef<Pane[]>([]);
  const setPanes = useCallback((next: Pane[]) => { panesRef.current = next; setPanesState(next); }, []);
  const [activeKey, setActiveKey] = useState("");
  const activeRef = useRef("");
  const [widths, setWidths] = useState<number[]>([1]);
  const [side, setSide] = useState(true);
  const [tick, setTick] = useState(0);
  const [pdfs, setPdfs] = useState<Record<string, string>>({});   // a PDF of theirs: the browser's own reader, not the editor

  const [mode, setModeState] = useState<Mode>("edit");
  const modeRef = useRef<Mode>("edit");
  const [tab, setTabState] = useState<Tab>("files");
  const [speechW, setSpeechW] = useState(0.46);                   // share of the work area
  const [speechH, setSpeechH] = useState(0.42);                   // its share of the height, in Stack
  const [speechOutline, setSpeechOutline] = useState(false);
  const [speechWidth, setSpeechWidth] = useState(700);
  const [sentPulse, setSentPulse] = useState(0);
  // answering their case: what is being answered, and the heading of the speech doc its answers go under
  const [answering, setAnsweringState] = useState<{ claim: string; head: string } | null>(null);
  const answerRef = useRef<{ claim: string; head: string } | null>(null);
  const setAnswering = useCallback((a: { claim: string; head: string } | null) => {
    answerRef.current = a;
    setAnsweringState(a);
    (window as any).EV?.setAnswer?.(a);
  }, []);
  const [readSrc, setReadSrc] = useState<"speech" | "file">("file");
  const [readDoc, setReadDoc] = useState<PMNode | null>(null);
  const [wpm, setWpm] = useState(230);
  const [hideDim, setHideDim] = useState(false);
  const [depth, setDepth] = useState(4);
  const [olFilter, setOlFilter] = useState("");
  // the outline's folds, the way Word's navigation pane has them: a heading opened or shut by hand, over what the depth buttons say
  const [olFold, setOlFold] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<null | { id: string; x: number; y: number; up?: number }>(null);
  // the ribbon: folded to one line, or with some of its groups folded into a button each
  const [ribMin, setRibMin] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutId>("classic");
  // Focus: the side is a drawer, out of sight until the pointer reaches the edge or a key asks for it
  const [drawer, setDrawer] = useState(false);
  // Spotlight: the search, floated in the middle, is open
  const [spot, setSpot] = useState(false);
  // Deck: the pages opened this session, as tabs
  const [deckTabs, setDeckTabs] = useState<{ id: string; name: string }[]>([]);
  // what is typed in the library search, for the commands that sit over its results
  const [cmdQ, setCmdQ] = useState("");
  const [cmdSel, setCmdSel] = useState(0);
  const focusLayout = layoutMode === "focus";
  // the dock is the folded ribbon, laid out another way
  const ribSmall = ribMin || focusLayout || layoutMode === "dock";
  const [folded, setFolded] = useState<string[]>([]);
  const [palette, setPalette] = useState<PaletteId>("graphite");
  const [sideW, setSideW] = useState(SIDE_W);
  // spelling: what the browser's checker looks at (lib/cutter/spell.ts)
  // tags only, in the speech doc: kept, so the doc opens the way it was left
  const [speechTags, setSpeechTagsState] = useState(false);
  const speechTagsRef = useRef(false);
  const setSpeechTags = useCallback((on: boolean) => { speechTagsRef.current = on; setSpeechTagsState(on); }, []);
  const [spell, setSpell] = useState<SpellMode>("writing");
  const spellRef = useRef(spell);
  spellRef.current = spell;

  const [files, setFilesState] = useState<CutMeta[]>([]);
  const filesRef = useRef<CutMeta[]>([]);
  const setFiles = useCallback((u: CutMeta[] | ((l: CutMeta[]) => CutMeta[])) => {
    setFilesState((l) => { const n = typeof u === "function" ? u(l) : u; filesRef.current = n; return n; });
  }, []);
  const [theirs, setTheirs] = useState<ViewMeta[]>([]);
  const [cur, setCur] = useState<CutFile | null>(null);
  const curRef = useRef<CutFile | null>(null);
  curRef.current = cur;
  const [name, setName] = useState("");
  const [state, setStateTag] = useState<"saved" | "saving" | "dirty">("saved");
  const [heads, setHeads] = useState<Head[]>([]);
  const [headsOf, setHeadsOf] = useState<"page" | "speech">("page");
  const [selCount, setSelCount] = useState<{ words: number; read: number } | null>(null);
  const [at, setAt] = useState(-1);
  const [docStat, setDocStat] = useState<{ read: number; cards: number }>({ read: 0, cards: 0 });
  const [q, setQ] = useState("");
  const [keys, setKeys] = useState<Overrides>({});
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const [keysOpen, setKeysOpen] = useState(false);
  const [listening, setListening] = useState<string | null>(null);
  const listeningRef = useRef(listening);
  listeningRef.current = listening;
  const [keyNote, setKeyNote] = useState("");
  const [hl, setHl] = useState(C.HIGHLIGHTS[0].color);
  const [citeFormat, setCiteFormat] = useState(DEFAULT_CITE_FORMAT);
  const citeRef = useRef(citeFormat);
  citeRef.current = citeFormat;
  const hlRef = useRef(hl);
  hlRef.current = hl;
  const [toastMsg, setToastMsg] = useState<{ t: string; n: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refPick, setRefPick] = useState<{ q: string; sel: number } | null>(null);
  const refIn = useRef<HTMLInputElement>(null);
  const saveT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickT = useRef<ReturnType<typeof setTimeout> | null>(null);

  // SpeechDrop, and pasting a doc of theirs
  const [sdCode, setSdCode] = useState("");
  const [sdState, setSdState] = useState<{ code: string; files: SdFile[] | null; err: string; loading: boolean } | null>(null);
  const [pasting, setPasting] = useState(false);

  // the speech timer
  const [timer, setTimer] = useState<{ open: boolean; limit: number; ran: number; since: number | null }>({ open: false, limit: 540, ran: 0, since: null });
  const [, setNow] = useState(0);

  const toast = useCallback((t: string) => setToastMsg((m) => ({ t, n: (m?.n || 0) + 1 })), []);
  useEffect(() => { if (!toastMsg) return; const t = setTimeout(() => setToastMsg(null), 2600); return () => clearTimeout(t); }, [toastMsg]);

  const refused = useCallback(() => toast("This browser would not go full screen here"), [toast]);
  const { full, toggle: toggleFull } = useFullscreen(root, refused);
  // full screen: the keys Chrome or an extension would otherwise take first come here (Keyboard Lock)
  useEffect(() => {
    const kb = (navigator as any).keyboard;
    if (!full || !kb?.lock) return;
    const codes = new Set<string>();
    for (const a of ACTIONS) {
      const last = (keyFor(keys, a.id) || "").split("+").pop() || "";
      if (/^[A-Z]$/.test(last)) codes.add("Key" + last);
      else if (/^\d$/.test(last)) codes.add("Digit" + last);
      else if (last === "Space") codes.add("Space");
      else if (last === "\\") codes.add("Backslash");
    }
    kb.lock([...codes]).catch(() => {});
    return () => { try { kb.unlock(); } catch { /* gone */ } };
  }, [full, keys]);

  // ---- preferences ---------------------------------------------------------
  const UI_KEY = scoped("magic.ui", owner);
  // nothing is saved until what was kept has been read — or the defaults would be written over it first
  const [uiReady, setUiReady] = useState(false);
  useEffect(() => {
    setKeys(loadKeys(owner));
    try { const c = localStorage.getItem(scoped("cutter.hl", owner)); if (c) setHl(c); } catch { /* private */ }
    try {
      const old = localStorage.getItem(scoped("cutter.sig", owner))?.trim();
      setCiteFormat(localStorage.getItem(scoped("cutter.citefmt", owner))
        ?? (old ? DEFAULT_CITE_FORMAT.replace(/\S+\s+\S+$/, old) : DEFAULT_CITE_FORMAT));
    } catch { /* private */ }
    try {
      const u = JSON.parse(localStorage.getItem(UI_KEY) || "null");
      if (u) {
        if (u.mode === "split" || u.mode === "speech") { modeRef.current = u.mode; setModeState(u.mode); if (u.mode === "speech") inSpeech.current = true; }
        if (["outline", "files", "search", "round"].includes(u.tab)) setTabState(u.tab);
        if (typeof u.speechW === "number") setSpeechW(Math.min(.75, Math.max(.25, u.speechW)));
        if (typeof u.speechH === "number") setSpeechH(Math.min(.75, Math.max(.25, u.speechH)));
        if (typeof u.wpm === "number") setWpm(u.wpm);
        if (typeof u.hideDim === "boolean") setHideDim(u.hideDim);
        if (typeof u.speechOutline === "boolean") setSpeechOutline(u.speechOutline);
        if (typeof u.depth === "number") setDepth(u.depth);
        if (typeof u.limit === "number") setTimer((t) => ({ ...t, limit: u.limit }));
        if (typeof u.ribMin === "boolean") setRibMin(u.ribMin);
        if (LAYOUT_MODES.some((l) => l.id === u.layout)) setLayoutMode(u.layout);
        if (Array.isArray(u.folded)) setFolded(u.folded.filter((x: unknown) => typeof x === "string"));
        if (PALETTES.some((p) => p.id === u.palette)) setPalette(u.palette);
        if (typeof u.sideW === "number") setSideW(Math.min(760, Math.max(220, u.sideW)));
        if (SPELL_MODES.some((m) => m.id === u.spell)) setSpell(u.spell);
        if (typeof u.speechTags === "boolean") setSpeechTags(u.speechTags);
      }
    } catch { /* first time */ }
    setUiReady(true);
  }, [owner]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem(scoped("cutter.hl", owner), hl); } catch { /* private */ } }, [hl, owner]);
  // the site's nav, above the ribbon, wears the palette too (magic.css) — and from before the page paints, next time (lib/toolTheme)
  useEffect(() => {
    if (!uiReady) return;
    document.documentElement.setAttribute("data-rm-palette", palette);
    try { localStorage.setItem(RM_PALETTE_KEY, palette); } catch { /* private */ }
  }, [palette, uiReady]);
  useEffect(() => {
    if (!uiReady) return;
    try { localStorage.setItem(UI_KEY, JSON.stringify({ mode: mode === "read" ? "edit" : mode, tab, speechW, speechH, wpm, hideDim, speechOutline, depth, limit: timer.limit, ribMin, folded, palette, sideW, spell, speechTags, layout: layoutMode })); } catch { /* private */ }
  }, [mode, tab, speechW, speechH, wpm, hideDim, speechOutline, depth, timer.limit, ribMin, folded, palette, sideW, spell, speechTags, layoutMode, UI_KEY, uiReady]);
  // the site's nav steps aside in Focus (magic.css), set on <html> so it can
  useEffect(() => {
    if (!uiReady) return;
    document.documentElement.setAttribute("data-rm-layout", layoutMode);
    return () => document.documentElement.removeAttribute("data-rm-layout");
  }, [layoutMode, uiReady]);
  useEffect(() => { if (!focusLayout) setDrawer(false); }, [focusLayout]);

  const setTab = useCallback((t: Tab) => { setTabState(t); setSide(true); }, []);

  // ---- small questions about the workspace ------------------------------------------
  const paneOf = (key: string) => panesRef.current.find((p) => p.key === key) || null;
  const isRead = (key: string) => !!paneOf(key)?.read;
  const keyShowing = (fid: string, except?: string) => {
    for (const [k, f] of viewFile.current) if (f === fid && k !== except && views.current.has(k)) return k;
    return null;
  };
  const scrollerOf = (v: EditorView) => v.dom.closest(".rm-scroll, #docbody") as HTMLElement | null;
  /** The editor the ribbon and the keys work in: the speech doc while the cursor is in it, else the page. */
  const target = () => {
    const s = speechView.current;
    if (s && modeRef.current === "speech") return s;                       // just the speech doc: it is all there is
    return inSpeech.current && s && modeRef.current === "split" ? s : view.current;
  };

  const makeState = useCallback((doc: PMNode, read: boolean, fid?: string) => {
    const fmt = { "Mod-b": toggleMark(schema.marks.strong), "Mod-i": toggleMark(schema.marks.em), "Mod-u": toggleMark(schema.marks.underline), Enter: X.enterKeepingAnalytics };
    const sh = fid ? shares.current.get(fid) : null;
    if (sh) {
      // a shared file: the page is bound to the shared document, and what it shows is that document
      const start = initProseMirrorDoc(sh.frag, schema);
      return EditorState.create({
        schema, doc: start.doc,
        plugins: [
          ySyncPlugin(sh.frag, { mapping: start.mapping }),
          yCursorPlugin(sh.awareness, { cursorBuilder: mateCaret, selectionBuilder: (u: { color: string }) => ({ style: `background-color: ${u.color}2e`, class: "rm-matesel" }) }),
          yUndoPlugin(),
          keymap({ "Mod-z": undoCommand, "Mod-y": redoCommand, "Shift-Mod-z": redoCommand, ...fmt }),
          keymap(baseKeymap),
          verbatimPlugin(read),
          spellPlugin(spellRef.current),
          gripPlugin(),
          foldPlugin(),
        ],
      });
    }
    return EditorState.create({
      doc,
      plugins: [
        history(),
        keymap({ "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo, ...fmt }),
        keymap(baseKeymap),
        verbatimPlugin(read),
        spellPlugin(spellRef.current),
        gripPlugin(),
        foldPlugin(),
      ],
    });
  }, []);

  // ---- the outline and the status line follow whatever has the cursor --------------------
  // Reading a whole document for its headings and its words is not something to do on every key:
  // the headings are read again only when the document is a different one (and its words a beat
  // after the typing stops); a cursor that only moved just says where it is now.
  const headsFor = useRef<{ doc: PMNode | null; heads: Head[] }>({ doc: null, heads: [] });
  const wordsT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readHeadsNow = useCallback(() => {
    const v = target();
    if (!v) return;
    setHeadsOf(v === speechView.current ? "speech" : "page");
    const { from: sf, to: st, empty } = v.state.selection;
    const c = empty ? null : countIn(v.state.doc, sf, st);
    setSelCount(c && c.words ? c : null);
    let out = headsFor.current.heads;
    if (headsFor.current.doc !== v.state.doc) {
      const doc = v.state.doc;
      out = [];
      let cards = 0;
      doc.forEach((n, pos) => { if (n.type === schema.nodes.heading) { out.push({ level: n.attrs.level, text: n.textContent.trim() || "(empty)", pos }); if (n.attrs.level === 4) cards++; } });
      headsFor.current = { doc, heads: out };
      setHeads(out);
      setDocStat((d) => (d.cards === cards ? d : { ...d, cards }));
      if (wordsT.current) clearTimeout(wordsT.current);
      wordsT.current = setTimeout(() => { const w = target(); if (w) { const read = readWords(w.state.doc); setDocStat((d) => (d.read === read ? d : { ...d, read })); } }, 400);
    }
    const from = v.state.selection.from;
    let i = -1;
    for (let k = 0; k < out.length && out[k].pos <= from; k++) i = k;
    setAt(i);
  }, []);
  const headsRaf = useRef(0);
  const readHeads = useCallback(() => {
    if (headsRaf.current) return;
    headsRaf.current = requestAnimationFrame(() => { headsRaf.current = 0; readHeadsNow(); });
  }, [readHeadsNow]);
  const syncActive = useCallback(() => {
    const fid = viewFile.current.get(activeRef.current);
    const f = fid ? loaded.current.get(fid) || null : null;
    setCur(f);
    setName(f?.name || "");
    setStateTag(fid && dirty.current.has(fid) ? "dirty" : "saved");
    readHeads();
  }, [readHeads]);
  const activate = useCallback((key: string) => {
    inSpeech.current = false;
    if (!key || activeRef.current === key) { readHeads(); return; }
    activeRef.current = key;
    setActiveKey(key);
    view.current = views.current.get(key) || null;
    syncActive();
  }, [syncActive, readHeads]);

  // ---- saving: every changed file, whichever page it was changed in ----------------
  const refreshTheirs = useCallback(async () => { try { setTheirs(await listDocs(owner)); } catch { /* no store yet */ } }, [owner]);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const flush = useCallback((loud = false) => {
    if (saveT.current) { clearTimeout(saveT.current); saveT.current = null; }
    chain.current = chain.current.then(async () => {
      const ids = [...dirty.current];
      const afid = viewFile.current.get(activeRef.current);
      if (afid && ids.includes(afid)) setStateTag("saving");
      let theirsChanged = false;
      for (const fid of ids) {
        dirty.current.delete(fid);
        const k = keyShowing(fid);
        const v = k ? views.current.get(k) : null;
        const base = loaded.current.get(fid);
        if (!v || !base) continue;
        const doc = v.state.doc;
        try {
          if (isTheirs(fid)) {
            // a doc of theirs is kept where the viewer keeps it — rehighlighted, but never in your library
            const meta = theirMeta.current.get(fid);
            if (!meta) continue;
            const next: ViewDoc = { ...meta, name: base.name, kind: "html", html: toHtml(doc), blob: undefined, at: Date.now() };
            await keepDoc(owner, next);
            theirMeta.current.set(fid, next);
            loaded.current.set(fid, { ...base, updated: next.at });
            theirsChanged = true;
            continue;
          }
          const sh = shares.current.get(fid);
          const next: CutFile = { ...base, doc: doc.toJSON(), html: toHtml(doc), cards: C.briefs(doc), words: countWords(doc), updated: Date.now(), ...(sh ? { y: sh.snapshot() } : {}) };
          await putFile(owner, next);
          loaded.current.set(fid, next);
          setFiles((l) => [stripDoc(next), ...l.filter((x) => x.id !== fid)]);
          bus.current?.post({ kind: "cutter-changed", id: fid });
          if (viewFile.current.get(activeRef.current) === fid) setCur(next);
        } catch (e) {
          dirty.current.add(fid);
          toast("Could not save: " + (e as Error).message);
        }
      }
      if (theirsChanged) void refreshTheirs();
      const a = viewFile.current.get(activeRef.current);
      setStateTag(a && dirty.current.has(a) ? "dirty" : "saved");
      if (loud) toast(a && isTheirs(a) ? "Saved — their doc stays out of your library" : "Saved — and in the library search");
    });
    return chain.current;
  }, [owner, toast, setFiles, refreshTheirs]);
  const markDirty = useCallback((fid: string) => {
    dirty.current.add(fid);
    if (viewFile.current.get(activeRef.current) === fid) setStateTag("dirty");
    if (saveT.current) clearTimeout(saveT.current);
    saveT.current = setTimeout(() => { void flush(); }, 700);
  }, [flush]);
  useEffect(() => {
    const out = () => { if (dirty.current.size) void flush(); };
    window.addEventListener("pagehide", out);
    return () => { window.removeEventListener("pagehide", out); out(); };
  }, [flush]);

  // ---- a read page follows the card being edited, and takes you to a card clicked in it ----
  const follow = useCallback((key: string) => {
    const v = views.current.get(key);
    if (!v || isRead(key)) return;
    const fid = viewFile.current.get(key);
    const c = C.cardAround(v.state);
    const $f = v.state.selection.$from;
    const pos = c?.tag ? c.tag.pos : $f.depth ? $f.before(1) : 0;
    for (const p of panesRef.current) {
      if (!p.read || !p.follow || p.key === key || viewFile.current.get(p.key) !== fid) continue;
      if (lastFollow.current.get(p.key) === pos) continue;
      lastFollow.current.set(p.key, pos);
      const w = views.current.get(p.key);
      const dom = w?.nodeDOM(pos) as HTMLElement | null;
      const sc = w && scrollerOf(w);
      if (dom && sc && dom.offsetParent) sc.scrollTo({ top: dom.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 20, behavior: "smooth" });
    }
  }, []);

  const goPos = useCallback((v: EditorView, pos: number) => {
    const at = Math.min(pos + 1, v.state.doc.content.size);
    try { v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, at))); } catch { /* a node with no text in it */ }
    v.focus();
    const dom = v.nodeDOM(pos) as HTMLElement | null;
    const sc = scrollerOf(v);
    if (dom && sc && dom.getBoundingClientRect) {
      sc.scrollTo({ top: dom.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 24 });
      dom.classList.remove("rm-flash"); void dom.offsetWidth; dom.classList.add("rm-flash");
    }
  }, []);

  /** A place in a page shown — scrolled to, flashed — without the cursor or the keyboard going there. */
  const showPos = useCallback((v: EditorView, pos: number) => {
    requestAnimationFrame(() => {
      const dom = v.nodeDOM(Math.min(pos, v.state.doc.content.size)) as HTMLElement | null;
      const sc = scrollerOf(v);
      if (!dom || !sc || !dom.getBoundingClientRect) return;
      sc.scrollTo({ top: dom.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 70, behavior: "smooth" });
      dom.classList.remove("rm-flash"); void dom.offsetWidth; dom.classList.add("rm-flash");
    });
  }, []);

  const jumpFromRead = useCallback((readKey: string, pos: number) => {
    const w = views.current.get(readKey);
    const fid = viewFile.current.get(readKey);
    if (!w || !fid) return;
    const c = C.cardAround(w.state, pos);
    const $p = w.state.doc.resolve(Math.min(pos, w.state.doc.content.size));
    const at = c?.tag ? c.tag.pos : $p.depth ? $p.before(1) : 0;
    const edit = [activeRef.current, ...panesRef.current.map((p) => p.key)]
      .find((k) => k && !isRead(k) && viewFile.current.get(k) === fid);
    const v = edit ? views.current.get(edit) : null;
    if (!v || !edit) return;
    activate(edit);
    lastFollow.current.set(readKey, at);
    goPos(v, at);
  }, [activate, goPos]);

  // ---- every change: in its own page, in every other page of the same file, saved ----
  const onTr = useCallback((key: string, tr: Transaction) => {
    const v = views.current.get(key);
    if (!v) return;
    v.updateState(v.state.apply(tr));
    if (tr.docChanged) {
      const fid = viewFile.current.get(key);
      if (!(fid && shares.current.has(fid))) for (const [k, w] of views.current) {
        if (k === key || viewFile.current.get(k) !== fid) continue;
        try {
          const t = w.state.tr;
          for (const st of tr.steps) t.step(st);
          t.setMeta("addToHistory", false);
          w.updateState(w.state.apply(t));
        } catch {
          w.updateState(makeState(v.state.doc, isRead(k)));
        }
      }
      if (fid) markDirty(fid);
      if (tickT.current) clearTimeout(tickT.current);
      tickT.current = setTimeout(() => setTick((n) => n + 1), 250);
    }
    if (key === activeRef.current && (tr.docChanged || tr.selectionSet)) readHeads();
    if (tr.docChanged || tr.selectionSet) follow(key);
  }, [makeState, markDirty, readHeads, follow]);

  /** A doc of theirs as a record a page can hold: drawn into the editor's own HTML, once. */
  const theirRecord = useCallback(async (fid: string): Promise<CutFile | null> => {
    const d = await getDoc(owner, fid.slice(THEIRS.length));
    if (!d) return null;
    theirMeta.current.set(fid, d);
    if (d.kind === "pdf") {
      if (d.blob) setPdfs((m) => (m[fid] ? m : { ...m, [fid]: URL.createObjectURL(d.blob!) }));
      return { id: fid, name: d.name, doc: null, html: "<p></p>", cards: [], words: 0, created: d.at, updated: d.at };
    }
    let html = "";
    if (d.kind === "docx" && d.blob) html = await docxToHtml(d.blob);
    else if (d.kind === "text") html = textToHtml(d.html || "");
    else html = sanitize(d.html || "");
    return { id: fid, name: d.name, doc: null, html, cards: [], words: 0, created: d.at, updated: d.at };
  }, [owner]);

  /** A shared file's live document, opened once however many pages show it. */
  const ensureShare = useCallback((f: CutFile): Promise<Shared | null> => {
    const fid = f.id;
    const had = shares.current.get(fid);
    if (had) return Promise.resolve(had);
    let p = sharing.current.get(fid);
    if (p) return p;
    p = openShare(f.share!, {
      name: me || "Partner",
      title: () => loaded.current.get(fid)?.name || f.name,
      seed: () => { try { return docOf(loaded.current.get(fid) || f); } catch { return null; } },
      local: f.y || null,
      onChange: () => setShareTick((n) => n + 1),
      onTitle: (t) => shareFns.current.peerRenamed(fid, t),
      onGone: () => shareFns.current.unshare(fid, "gone"),
    }).then(async (sh) => {
      // opened from a link before anything of it has arrived: a moment for it to
      if (!sh.frag.length) await new Promise<void>((res) => {
        const done = () => { clearTimeout(t); sh.ydoc.off("update", on); res(); };
        const on = () => { if (sh.frag.length) done(); };
        const t = setTimeout(done, 3000);
        sh.ydoc.on("update", on);
      });
      if (!sh.frag.length) prosemirrorToYXmlFragment(fromHtml("<p></p>"), sh.frag);
      shares.current.set(fid, sh);
      setShareTick((n) => n + 1);
      return sh;
    }).catch((e) => {
      if (e instanceof NotShared) shareFns.current.unshare(fid, "gone");
      else toast("The shared doc could not be reached: " + String((e as Error)?.message || e));
      return null;
    }).finally(() => { sharing.current.delete(fid); });
    sharing.current.set(fid, p);
    return p;
  }, [me, toast]);
  /** Nobody's page shows it any more: out of its room (it is saved, here and there, first). */
  const releaseShare = useCallback((fid: string) => {
    const sh = shares.current.get(fid);
    if (!sh || keyShowing(fid)) return;
    shares.current.delete(fid);
    sh.close();
    setShareTick((n) => n + 1);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Put a file in a page: from another page that has it open (one document), or from the store. */
  const loadInto = useCallback(async (key: string, fid: string, then?: (v: EditorView) => void) => {
    const v = views.current.get(key);
    if (!v) return;
    const was = viewFile.current.get(key);
    if (was && was !== fid && dirty.current.has(was) && !keyShowing(was, key)) await flush();
    let doc: PMNode | null = null;
    const other = keyShowing(fid, key);
    if (other) doc = views.current.get(other)!.state.doc;
    let rec = loaded.current.get(fid);
    let brightened = false;
    if (!doc || !rec) {
      const f = isTheirs(fid) ? await theirRecord(fid) : await getFile(owner, fid);
      if (!f) { toast("That one is gone"); return; }
      if (!rec) { rec = f; loaded.current.set(fid, f); }
      if (!doc) {
        doc = docOf(f);
        const bright = rec.share ? null : brightenGreens(doc);
        if (bright) { doc = bright; brightened = true; }
      }
    }
    // a shared file opens onto the shared document: what is on the page is what everyone in it has
    if (rec.share && !isTheirs(fid)) await ensureShare(rec);
    if (!views.current.has(key)) return;
    v.updateState(makeState(doc, isRead(key), fid));
    viewFile.current.set(key, fid);
    if (was && was !== fid) releaseShare(was);
    lastFollow.current.delete(key);
    if (brightened) markDirty(fid);                           // the dark green, put right, is saved
    if (key === activeRef.current) {
      syncActive();
      try { localStorage.setItem(scoped("cutter.last", owner), fid); } catch { /* private */ }
    }
    setTick((n) => n + 1);
    if (then) requestAnimationFrame(() => then(v));
  }, [owner, flush, makeState, syncActive, theirRecord, toast, markDirty, ensureShare, releaseShare]);

  const fns = useRef({ onTr, loadInto, activate, jumpFromRead, releaseShare });
  fns.current = { onTr, loadInto, activate, jumpFromRead, releaseShare };
  const mountFor = useCallback((key: string) => {
    let cb = refCbs.current.get(key);
    if (cb) return cb;
    cb = (el: HTMLDivElement | null) => {
      if (el) {
        if (views.current.has(key)) return;
        const v = new EditorView({ mount: el }, {
          state: EditorState.create({ schema }),
          attributes: { class: "ct-sheet" },
          dispatchTransaction: (tr) => fns.current.onTr(key, tr),
          handleClick: (_view, pos) => { if (isRead(key)) { fns.current.jumpFromRead(key, pos); return true; } return false; },
          handleDOMEvents: {
            focus: () => { fns.current.activate(key); return false; },
            dblclick: () => {
              setTimeout(() => {
                const w = views.current.get(key);
                if (!w) return;
                try { (w as any).domObserver?.flush?.(); } catch { /* read on its own soon enough */ }
                const s = C.trimmed(w.state);
                if (s) w.dispatch(w.state.tr.setSelection(s));
              }, 0);
              return false;
            },
          },
        });
        views.current.set(key, v);
        if (key === activeRef.current) view.current = v;
        const p = paneOf(key);
        if (p) void fns.current.loadInto(key, p.fileId);
      } else {
        const v = views.current.get(key);
        if (v) { v.destroy(); views.current.delete(key); }
        const had = viewFile.current.get(key);
        viewFile.current.delete(key);
        if (had) fns.current.releaseShare(had);
        lastFollow.current.delete(key);
        // forgotten only once its page is gone: forgetting it while the page lives made the next
        // draw hand React a new ref, which tore the editor down and built it again — every draw
        if (!paneOf(key)) refCbs.current.delete(key);
        if (view.current === v) view.current = null;
      }
    };
    refCbs.current.set(key, cb);
    return cb;
  }, []);

  // ---- pages ---------------------------------------------------------------
  const setPaneFile = useCallback(async (key: string, fid: string, then?: (v: EditorView) => void) => {
    setPanes(panesRef.current.map((p) => (p.key === key ? { ...p, fileId: fid } : p)));
    await loadInto(key, fid, then);
  }, [setPanes, loadInto]);

  const setPaneRead = useCallback((key: string, read: boolean) => {
    setPanes(panesRef.current.map((p) => (p.key === key ? { ...p, read } : p)));
    const v = views.current.get(key);
    if (v) v.dispatch(v.state.tr.setMeta(verbKey, read));
    lastFollow.current.delete(key);
    if (!read && v) { activate(key); v.focus(); }
    setTick((n) => n + 1);
  }, [setPanes, activate]);

  const firstEdit = (except?: string) => panesRef.current.find((p) => !p.read && p.key !== except)?.key || panesRef.current.find((p) => p.key !== except)?.key || "";

  const closePane = useCallback(async (key: string) => {
    if (panesRef.current.length < 2) return;
    await flush();
    const i = panesRef.current.findIndex((p) => p.key === key);
    const next = panesRef.current.filter((p) => p.key !== key);
    setPanes(next);
    setWidths((w) => { const n = w.filter((_, k) => k !== i); return n.length ? n : [1]; });
    if (activeRef.current === key) {
      const k = firstEdit(key);
      activeRef.current = "";
      requestAnimationFrame(() => { activate(k); views.current.get(k)?.focus(); });
    }
  }, [flush, setPanes, activate]);

  const addPane = useCallback((p: Omit<Pane, "key">, after = activeRef.current) => {
    if (panesRef.current.length >= MAX_PANES) { toast("Three pages at most — close one first"); return null; }
    const key = newKey();
    const i = panesRef.current.findIndex((x) => x.key === after);
    const next = [...panesRef.current];
    next.splice(i < 0 ? next.length : i + 1, 0, { key, ...p });
    setPanes(next);
    setWidths(next.map(() => 1));
    return key;
  }, [setPanes, toast]);

  // ---- files ------------------------------------------------------------------
  const newFile = useCallback(async (fileName: string, html = "<h4></h4><p></p>", share?: string) => {
    const doc = fromHtml(html);
    const f: CutFile = {
      id: newFileId(), name: fileName, doc: doc.toJSON(), html: toHtml(doc),
      cards: C.briefs(doc), words: countWords(doc), created: Date.now(), updated: Date.now(),
      ...(share ? { share } : {}),
    };
    await putFile(owner, f);
    loaded.current.set(f.id, f);
    setFiles((l) => [stripDoc(f), ...l]);
    bus.current?.post({ kind: "cutter-changed", id: f.id });
    return f;
  }, [owner, setFiles]);

  const open = useCallback(async (id: string, then?: (v: EditorView) => void) => {
    if (modeRef.current === "speech") { modeRef.current = "split"; setModeState("split"); inSpeech.current = false; }
    const key = activeRef.current || panesRef.current[0]?.key;
    if (!key) return;
    await setPaneFile(key, id, then);
  }, [setPaneFile]);

  const create = useCallback(async (fileName: string, html?: string) => {
    const f = await newFile(fileName, html);
    const key = activeRef.current || panesRef.current[0]?.key;
    if (key && isRead(key)) setPaneRead(key, false);
    await open(f.id, (v) => { v.focus(); v.dispatch(v.state.tr.setSelection(TextSelection.atStart(v.state.doc))); });
    return f;
  }, [newFile, open, setPaneRead]);

  const LAYOUT_KEY = scoped("cutter.layout", owner);
  useEffect(() => {
    let gone = false;
    bus.current = openBus(owner, () => {});
    void refreshTheirs();
    (async () => {
      let l = await listFiles(owner);
      if (gone) return;
      if (!l.length) { await newFile("My first file"); l = await listFiles(owner); }
      setFiles(l);
      const ids = new Set(l.map((f) => f.id));
      let saved: { panes?: { fileId: string; read?: boolean; follow?: boolean }[]; widths?: number[]; side?: boolean; active?: number } | null = null;
      try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null"); } catch { /* first time */ }
      let ps: Pane[] = (saved?.panes || []).filter((p) => ids.has(p.fileId)).slice(0, MAX_PANES)
        .map((p) => ({ key: newKey(), fileId: p.fileId, read: !!p.read, follow: p.follow !== false }));
      if (!ps.length) {
        let last = "";
        try { last = localStorage.getItem(scoped("cutter.last", owner)) || ""; } catch { /* private */ }
        ps = [{ key: newKey(), fileId: ids.has(last) ? last : l[0].id, read: false, follow: true }];
      }
      const ai = Math.min(Math.max(0, saved?.active || 0), ps.length - 1);
      const act = ps[ai].read ? (ps.find((p) => !p.read) || ps[ai]) : ps[ai];
      activeRef.current = act.key;
      setActiveKey(act.key);
      if (saved?.widths && saved.widths.length === ps.length) setWidths(saved.widths); else setWidths(ps.map(() => 1));
      if (typeof saved?.side === "boolean") setSide(saved.side);
      setPanes(ps);
    })();
    return () => { gone = true; bus.current?.close(); bus.current = null; };
  }, [owner]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!panes.length) return;
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({
        // a doc of theirs is not part of the layout kept for next time: their doc from round 3 isn't round 5's
        panes: panes.filter((p) => !isTheirs(p.fileId)).map((p) => ({ fileId: p.fileId, read: p.read, follow: p.follow })),
        widths, side, active: Math.max(0, panes.findIndex((p) => p.key === activeKey)),
      }));
    } catch { /* private */ }
  }, [panes, widths, side, activeKey, LAYOUT_KEY]);

  // a shared file's link: the file is opened — made a file of yours first, if this browser has not had it before
  const linked = useRef(false);
  useEffect(() => {
    if (!sharedLink || linked.current || !panes.length) return;
    linked.current = true;
    (async () => {
      try {
        let f = filesRef.current.find((x) => x.share === sharedLink) || null;
        if (!f) {
          const info = await peekShare(sharedLink);
          const made = await newFile(info.title || "Shared doc", "<p></p>", sharedLink);
          f = stripDoc(made);
          toast(`“${made.name}”${info.owner ? ", shared by " + info.owner : ""} — it is in your files now, and you are in it together`);
        }
        if (modeRef.current === "read") { modeRef.current = "edit"; setModeState("edit"); }
        await open(f.id, (v) => v.focus());
      } catch (e) {
        toast(e instanceof NotShared ? "That link's doc is not shared any more" : "The shared doc would not open: " + String((e as Error)?.message || e));
      }
      try { const u = new URL(location.href); u.searchParams.delete("doc"); window.history.replaceState(null, "", u.pathname + u.search); } catch { /* the address keeps it */ }
    })();
  }, [sharedLink, panes.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const rename = useCallback(async (n: string) => {
    const fid = viewFile.current.get(activeRef.current);
    const f = fid ? loaded.current.get(fid) : null;
    const clean = n.replace(/\s+/g, " ").trim();
    if (!f || !fid || !clean || clean === f.name) { setName(f?.name || ""); return; }
    loaded.current.set(fid, { ...f, name: clean });
    setName(clean);
    shares.current.get(fid)?.rename(clean);
    if (isTheirs(fid)) setTheirs((l) => l.map((x) => (THEIRS + x.id === fid ? { ...x, name: clean } : x)));
    else setFiles((l) => l.map((x) => (x.id === fid ? { ...x, name: clean } : x)));
    dirty.current.add(fid);
    await flush();
  }, [flush, setFiles]);

  const [renaming, setRenaming] = useState<string | null>(null);
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  const renameFile = useCallback(async (id: string, n: string) => {
    setRenaming(null);
    const clean = n.replace(/\s+/g, " ").trim();
    if (!clean) return;
    if (keyShowing(id)) {
      const f = loaded.current.get(id);
      if (!f || f.name === clean) return;
      loaded.current.set(id, { ...f, name: clean });
      shares.current.get(id)?.rename(clean);
      setFiles((l) => l.map((x) => (x.id === id ? { ...x, name: clean } : x)));
      if (viewFile.current.get(activeRef.current) === id) setName(clean);
      dirty.current.add(id);
      await flush();
      return;
    }
    const f = await getFile(owner, id);
    if (!f || f.name === clean) return;
    const next = { ...f, name: clean, updated: Date.now() };
    await putFile(owner, next);
    loaded.current.delete(id);
    setFiles((l) => l.map((x) => (x.id === id ? { ...x, name: clean, updated: next.updated } : x)));
    bus.current?.post({ kind: "cutter-changed", id });
  }, [owner, flush, setFiles]);

  const remove = useCallback(async (id: string) => {
    const f = filesRef.current.find((x) => x.id === id);
    if (!f || !window.confirm(`Delete “${f.name}”? Its cards leave the library too.`)) return;
    dirty.current.delete(id);
    const sh = shares.current.get(id);
    if (sh) { shares.current.delete(id); sh.close(); }
    await dropFile(owner, id);
    loaded.current.delete(id);
    bus.current?.post({ kind: "cutter-changed", id });
    const rest = filesRef.current.filter((x) => x.id !== id);
    setFiles(rest);
    let fallback = rest[0]?.id;
    if (!fallback) fallback = (await newFile("Untitled file")).id;
    for (const p of panesRef.current) if (p.fileId === id) await setPaneFile(p.key, fallback);
    toast(`Deleted “${f.name}”`);
  }, [owner, newFile, setPaneFile, toast, setFiles]);

  // ---- sharing a file: a link, and everyone with it in the same document --------------
  const copyLink = useCallback(async (id: string) => {
    try { await navigator.clipboard.writeText(shareLink(id)); toast("Link copied — whoever opens it is in the file with you"); }
    catch { toast("The browser would not copy it — the link is in the Share menu to copy by hand"); }
  }, [toast]);
  const startShare = useCallback(async (fid: string) => {
    const k = keyShowing(fid);
    const v = k ? views.current.get(k) : null;
    const base = loaded.current.get(fid);
    if (!v || !base || isTheirs(fid)) return;
    if (base.share) { void copyLink(base.share); return; }
    setBusy(true);
    try {
      await flush();
      const id = await createShare(base.name);
      const doc = v.state.doc;
      const sh = await openShare(id, {
        name: me || "Partner", first: true,
        title: () => loaded.current.get(fid)?.name || base.name,
        seed: () => doc,
        onChange: () => setShareTick((n) => n + 1),
        onTitle: (t) => shareFns.current.peerRenamed(fid, t),
        onGone: () => shareFns.current.unshare(fid, "gone"),
      });
      shares.current.set(fid, sh);
      const next: CutFile = { ...(loaded.current.get(fid) || base), share: id, y: sh.snapshot() };
      loaded.current.set(fid, next);
      await putFile(owner, next);
      setFiles((l) => l.map((x) => (x.id === fid ? { ...x, share: id } : x)));
      if (viewFile.current.get(activeRef.current) === fid) setCur(next);
      // every page showing it, onto the shared document
      for (const [k2, f2] of viewFile.current) { if (f2 !== fid) continue; const w = views.current.get(k2); if (w) w.updateState(makeState(doc, isRead(k2), fid)); }
      setShareTick((n) => n + 1);
      await copyLink(id);
    } catch (e) {
      toast("It could not be shared: " + String((e as Error)?.message || e));
    } finally { setBusy(false); }
  }, [owner, me, flush, makeState, copyLink, setFiles, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A shared file made a file of your own again: its owner stopping the sharing, you leaving it, or it having been stopped. */
  const unshare = useCallback(async (fid: string, why: "gone" | "stop" | "leave") => {
    const rec = loaded.current.get(fid) || (await getFile(owner, fid)) || null;
    if (!rec?.share) return;
    if (why === "stop") { try { await stopShare(rec.share); } catch (e) { toast("It could not be stopped: " + String((e as Error)?.message || e)); return; } }
    const sh = shares.current.get(fid);
    const k = keyShowing(fid);
    const doc = k ? views.current.get(k)!.state.doc : null;
    if (sh) { shares.current.delete(fid); sh.close(); }
    const { share: _s, y: _y, ...rest } = rec;
    const next: CutFile = doc ? { ...rest, doc: doc.toJSON(), html: toHtml(doc), cards: C.briefs(doc), words: countWords(doc), updated: Date.now() } : rest;
    loaded.current.set(fid, next);
    await putFile(owner, next);
    setFiles((l) => l.map((x) => { if (x.id !== fid) return x; const { share: _x, ...m } = x; return m; }));
    if (viewFile.current.get(activeRef.current) === fid) setCur(next);
    // the pages showing it: the same words, in a document of their own again
    if (doc) for (const [k2, f2] of viewFile.current) { if (f2 !== fid) continue; const w = views.current.get(k2); if (w) w.updateState(makeState(doc, isRead(k2))); }
    setShareTick((n) => n + 1);
    toast(why === "stop" ? `“${rec.name}” is not shared any more — everyone keeps the copy they had`
      : why === "leave" ? `You left “${rec.name}” — it is a file of your own now`
        : `“${rec.name}” is not shared any more — this is your own copy of it`);
  }, [owner, makeState, setFiles, toast]); // eslint-disable-line react-hooks/exhaustive-deps
  const peerRenamed = useCallback((fid: string, t: string) => {
    const f = loaded.current.get(fid);
    const clean = t.replace(/\s+/g, " ").trim();
    if (!f || !clean || clean === f.name) return;
    loaded.current.set(fid, { ...f, name: clean });
    setFiles((l) => l.map((x) => (x.id === fid ? { ...x, name: clean } : x)));
    if (viewFile.current.get(activeRef.current) === fid) setName(clean);
    markDirty(fid);
  }, [setFiles, markDirty]);
  shareFns.current = { peerRenamed, unshare: (fid, why) => { void unshare(fid, why); } };
  // leaving the tool leaves every shared file's room
  useEffect(() => () => { for (const sh of shares.current.values()) sh.close(); shares.current.clear(); }, []);

  // ---- docs of theirs ------------------------------------------------------------
  /** Keep a doc of theirs and open it in the page being worked in. */
  const openTheirs = useCallback(async (d: ViewDoc) => {
    await keepDoc(owner, d);
    void refreshTheirs();
    loaded.current.delete(THEIRS + d.id);
    await open(THEIRS + d.id, (v) => { v.focus(); v.dispatch(v.state.tr.setSelection(TextSelection.atStart(v.state.doc))); });
    // their doc is opened to be answered: the speech doc goes beside it
    if (d.kind !== "pdf" && modeRef.current !== "split") {
      modeRef.current = "split"; setModeState("split"); inSpeech.current = false;
      requestAnimationFrame(() => (window as any).EV?.renderDoc?.());
      toast(`Their doc beside your speech doc — ${keyLabel(keyFor(keysRef.current, "answer")) || "Answer"} on a tag of theirs starts its answer`);
    }
  }, [owner, refreshTheirs, open, toast]);

  const forgetTheirs = useCallback(async (m: ViewMeta) => {
    const fid = THEIRS + m.id;
    await dropDoc(owner, m.id);
    loaded.current.delete(fid);
    dirty.current.delete(fid);
    void refreshTheirs();
    const fallback = filesRef.current[0]?.id;
    if (fallback) for (const p of panesRef.current) if (p.fileId === fid) await setPaneFile(p.key, fallback);
  }, [owner, refreshTheirs, setPaneFile]);

  /** A doc of theirs, copied into a file of your own — and so into your library. */
  const keepAsMine = useCallback(async (fid: string) => {
    const k = keyShowing(fid);
    const doc = k ? views.current.get(k)!.state.doc : null;
    const rec = loaded.current.get(fid);
    if (!doc || !rec) return;
    const f = await newFile(rec.name, toHtml(doc));
    toast(`“${f.name}” is a file of yours now — and in the library search`);
    await open(f.id, (v) => v.focus());
  }, [newFile, open, toast]);

  const listSd = useCallback(async (raw: string) => {
    const code = raw.trim().replace(/^https?:\/\/[^/]+\//i, "").replace(/\/.*$/, "");
    if (!code) return;
    setSdState({ code, files: null, err: "", loading: true });
    try {
      const r = await fetch(`/api/tools/speechdrop?room=${encodeURIComponent(code)}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `SpeechDrop said ${r.status}`);
      setSdState({ code, files: (j.files as SdFile[]).slice().reverse(), err: "", loading: false });
      try { localStorage.setItem(scoped("magic.sd", owner), code); } catch { /* private */ }
    } catch (e: any) {
      setSdState({ code, files: null, err: String(e?.message || e), loading: false });
    }
  }, [owner]);
  const openSd = useCallback(async (f: SdFile) => {
    if (!sdState) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/tools/speechdrop?room=${encodeURIComponent(sdState.code)}&i=${f.i}`, { cache: "no-store" });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `SpeechDrop said ${r.status}`); }
      const blob = await r.blob();
      const kind = kindOf(f.name, blob.type);
      const base = { id: `sd-${sdState.code}-${f.i}`, name: f.name.replace(/\.(docx|html?|txt|pdf)$/i, ""), kind, source: "speechdrop" as const, by: `SpeechDrop ${sdState.code}`, at: f.ctime || Date.now() };
      await openTheirs(kind === "docx" || kind === "pdf" ? { ...base, blob } : { ...base, html: await blob.text() });
    } catch (e: any) {
      toast(String(e?.message || e));
    } finally { setBusy(false); }
  }, [sdState, openTheirs, toast]);
  useEffect(() => {
    let code = sd || "";
    if (!code) { try { code = localStorage.getItem(scoped("magic.sd", owner)) || ""; } catch { /* private */ } }
    if (code) { setSdCode(code); if (sd) { setTab("round"); void listSd(code); } }
  }, [sd, owner]); // eslint-disable-line react-hooks/exhaustive-deps

  const openTheirFile = useCallback(async (file: File) => {
    const kind = kindOf(file.name, file.type);
    const base = { id: newDocId(), name: file.name.replace(/\.(docx|html?|txt|pdf)$/i, ""), kind, source: "file" as const, at: Date.now() };
    await openTheirs(kind === "docx" || kind === "pdf" ? { ...base, blob: file } : { ...base, html: await file.text() });
  }, [openTheirs]);
  const onTheirPaste = useCallback(async (e: React.ClipboardEvent) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (!html && !text.trim()) { toast("Nothing on the clipboard to read"); return; }
    const first = (text || "").split("\n").map((l) => l.trim()).find(Boolean) || "Pasted doc";
    setPasting(false);
    await openTheirs({ id: newDocId(), name: first.slice(0, 60), kind: html ? "html" : "text", source: "paste", at: Date.now(), html: html || text });
  }, [openTheirs, toast]);

  // ---- layouts ----------------------------------------------------------------
  const layout = useCallback(async (id: string) => {
    setMenu(null);
    const a = paneOf(activeRef.current) || panesRef.current[0];
    if (!a) return;
    const base: Pane = { ...a, read: false };
    let next: Pane[];
    if (id === "one") next = [base];
    else if (id === "read") next = [base, { key: newKey(), fileId: a.fileId, read: true, follow: true }];
    else if (id === "two") next = [base, { key: newKey(), fileId: a.fileId, read: false, follow: true }];
    else if (id === "other") {
      const o = filesRef.current.find((f) => f.id !== a.fileId);
      if (!o) { toast("Make or open another file first — or try Write beside the cards"); return; }
      next = [base, { key: newKey(), fileId: o.id, read: false, follow: true }];
    } else {
      const f = await newFile(`Extensions — ${loaded.current.get(a.fileId)?.name || "cards"}`, "<h3></h3><h4></h4>");
      next = [base, { key: newKey(), fileId: f.id, read: false, follow: true }];
    }
    await flush();
    if (a.read) { const v = views.current.get(a.key); if (v) v.dispatch(v.state.tr.setMeta(verbKey, false)); }
    setPanes(next);
    setWidths(next.map(() => 1));
    if (id === "write") requestAnimationFrame(() => {
      const k = next[1].key, v = views.current.get(k);
      if (v) { activate(k); v.focus(); v.dispatch(v.state.tr.setSelection(TextSelection.atStart(v.state.doc))); }
    });
    else views.current.get(a.key)?.focus();
  }, [flush, newFile, setPanes, activate, toast]);

  const readBeside = useCallback(() => {
    const a = paneOf(activeRef.current);
    if (!a) return;
    const there = panesRef.current.find((p) => p.read && p.key !== a.key && p.fileId === a.fileId);
    if (there) { void closePane(there.key); return; }
    if (a.read) { setPaneRead(a.key, false); }
    if (panesRef.current.length < MAX_PANES) { addPane({ fileId: a.fileId, read: true, follow: true }); return; }
    const last = [...panesRef.current].reverse().find((p) => p.key !== a.key)!;
    void setPaneFile(last.key, a.fileId).then(() => setPaneRead(last.key, true));
  }, [addPane, closePane, setPaneRead, setPaneFile]);

  const nextPane = useCallback(() => {
    const edits = panesRef.current.filter((p) => !p.read);
    if (modeRef.current === "speech") return;
    if (modeRef.current === "split" && speechView.current) {
      // the speech doc is the last page in the round
      const i = inSpeech.current ? -1 : edits.findIndex((p) => p.key === activeRef.current);
      if (i === edits.length - 1) { inSpeech.current = true; speechView.current.focus(); readHeads(); return; }
      const k = edits[i + 1]?.key || edits[0]?.key;
      if (k) { activate(k); views.current.get(k)?.focus(); }
      return;
    }
    if (edits.length < 2) return;
    const i = edits.findIndex((p) => p.key === activeRef.current);
    const k = edits[(i + 1) % edits.length].key;
    activate(k);
    views.current.get(k)?.focus();
  }, [activate, readHeads]);

  // ---- modes: the file, the file and the speech doc, reading ----------------------------
  const speechDoc = () => {
    const v = speechView.current;
    if (v) return v.state.doc;
    const body = root.current?.querySelector("#docbody .ProseMirror");
    return body ? fromHtml(body.innerHTML) : null;
  };
  const readFrom = useRef<Mode>("edit");                   // where Read mode was opened from, to go back to
  const setMode = useCallback((m: Mode) => {
    if (m === "read") {
      const prefer = modeRef.current === "speech" || (modeRef.current === "split" && inSpeech.current) ? "speech" : readSrc;
      readFrom.current = modeRef.current;
      const d = prefer === "speech" ? speechDoc() : view.current?.state.doc || null;
      setReadSrc(prefer);
      setReadDoc(d);
    }
    modeRef.current = m;
    setModeState(m);
    if (m === "speech") inSpeech.current = true;
    else if (m !== "split") inSpeech.current = false;
    requestAnimationFrame(() => {
      if (m === "split" || m === "speech") (window as any).EV?.renderDoc?.();
      if (m === "speech") speechView.current?.focus();
      else if (m !== "read") view.current?.focus();
      readHeads();
    });
  }, [readSrc, readHeads]); // eslint-disable-line react-hooks/exhaustive-deps
  const chooseReadSrc = useCallback((s: "speech" | "file") => {
    setReadSrc(s);
    setReadDoc(s === "speech" ? speechDoc() : view.current?.state.doc || null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** From Read mode, a tag clicked: back to editing it. */
  const editAt = useCallback((pos: number) => {
    const speech = readSrc === "speech";
    setMode(speech ? (readFrom.current === "speech" ? "speech" : "split") : "edit");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const v = speech ? speechView.current : view.current;
      if (!v) return;
      if (speech) inSpeech.current = true;
      goPos(v, pos);
    }));
  }, [readSrc, setMode, goPos]);

  // ---- answering their case -------------------------------------------------------
  /** The heading answers go under, in the speech doc: found, or put at its end. */
  const ensureHead = useCallback((head: string) => {
    const s = speechView.current;
    if (!s) return -1;
    let pos = headPos(s.state.doc, head);
    if (pos < 0) {
      const d = s.state.doc;
      const blank = d.childCount === 1 && !d.firstChild!.content.size;
      const h = schema.nodes.heading.create({ level: 3 }, schema.text(head));
      pos = blank ? 0 : d.content.size;
      s.dispatch(blank ? s.state.tr.replaceWith(0, d.content.size, h) : s.state.tr.insert(pos, h));
    }
    showPos(s, pos);
    return pos;
  }, [showPos]);
  /** Cards put under the heading being answered — at the end of what is already under it. */
  const putUnder = useCallback((nodes: PMNode[], said: string) => {
    const s = speechView.current, a = answerRef.current;
    if (!s || !a || !nodes.length) return false;
    let pos = headPos(s.state.doc, a.head);
    if (pos < 0) pos = ensureHead(a.head);
    const sec = C.sections(s.state.doc).find((x) => x.pos === pos);
    if (!sec) return false;
    // already under it: said, not put in twice
    const tag = nodes.find((n) => n.type === schema.nodes.heading)?.textContent.trim().toLowerCase();
    let there = false;
    if (tag) s.state.doc.nodesBetween(sec.pos, sec.end, (n, p) => { if (p > sec.pos && n.type === schema.nodes.heading && n.textContent.trim().toLowerCase() === tag) there = true; return false; });
    if (there) { toast(`Already under “${a.head.slice(0, 40)}”: ${said.slice(0, 50)}`); return true; }
    s.dispatch(s.state.tr.insert(sec.end, PMFragment.from(nodes)));
    showPos(s, sec.end);
    setSentPulse((n) => n + 1);
    // and to Flow, if it is open: the tags of what just went in, ready to flow
    const tags = nodes.filter((n) => n.type === schema.nodes.heading).map((n) => n.textContent.trim()).filter(Boolean);
    bus.current?.post({ kind: "sent", title: a.head, trigger: "", tags });
    toast(`Under “${a.head.slice(0, 40)}”: ${said.slice(0, 60)}`);
    return true;
  }, [ensureHead, showPos, toast]);

  /**
   * Answer this. In a page (their case, most often): what is selected, or the
   * heading the cursor is under, is what is being answered — it gets a heading
   * in the speech doc ("AT: …"), the search looks for what answers it, and
   * Enter there puts a card under that heading. Pressed again from the search,
   * it is their next tag. In the speech doc, it says: cards go under this heading.
   */
  const answer = useCallback(() => {
    const s = speechView.current;
    if (s && s.hasFocus()) {
      const from = s.state.selection.from;
      let near = "", block = "";
      s.state.doc.forEach((n, p) => {
        if (n.type !== schema.nodes.heading || p > from || !n.textContent.trim()) return;
        near = n.textContent.trim();
        if (n.attrs.level < 4) block = near;
      });
      const head = block || near;
      if (!head) { toast("Put the cursor under a heading of the speech doc — cards you send will land under it"); return; }
      setAnswering({ claim: "", head });
      toast(`Cards you send now land under “${head.slice(0, 50)}”`);
      return;
    }
    const v = view.current;
    if (!v) return;
    const st = v.state, inFile = v.hasFocus();
    let claim = "";
    if (inFile && !st.selection.empty) claim = st.doc.textBetween(st.selection.from, st.selection.to, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    else {
      const hs: { pos: number; text: string; level: number }[] = [];
      st.doc.forEach((n, p) => { if (n.type === schema.nodes.heading && n.textContent.trim()) hs.push({ pos: p, text: n.textContent.trim(), level: n.attrs.level }); });
      if (!hs.length) { toast("No headings here to answer — select the words you are answering, then press it again"); return; }
      let i = -1;
      hs.forEach((h, k) => { if (h.pos <= st.selection.from) i = k; });
      // from the page: the heading the cursor is under. From the search, again: their next tag.
      let k = inFile || !answerRef.current?.claim ? Math.max(i, 0) : i + 1;
      if (!inFile && hs.some((h) => h.level === 4)) while (k < hs.length && hs[k].level !== 4) k++;
      if (k >= hs.length) { toast("That was their last tag"); return; }
      claim = hs[k].text;
      try { v.dispatch(st.tr.setSelection(TextSelection.create(st.doc, Math.min(hs[k].pos + 1, st.doc.content.size)))); } catch { /* an empty heading */ }
      showPos(v, hs[k].pos);
    }
    if (!claim) return;
    const head = "AT: " + headOf(claim);
    const go = () => {
      ensureHead(head);
      setTab("search");
      const q = root.current?.querySelector("#q") as HTMLInputElement | null;
      if (q) q.value = headOf(claim);
      setAnswering({ claim, head });
      requestAnimationFrame(() => { q?.focus(); q?.select(); });
    };
    if (modeRef.current !== "split") {
      modeRef.current = "split"; setModeState("split"); inSpeech.current = false;
      requestAnimationFrame(() => { (window as any).EV?.renderDoc?.(); requestAnimationFrame(go); });
    } else go();
  }, [ensureHead, showPos, setAnswering, setTab, toast]);

  // ---- sending a card to the speech doc ---------------------------------------
  const sendCard = useCallback(async () => {
    if (modeRef.current === "speech") { toast("Send is from a file — SPLIT puts one beside the speech doc"); return; }
    if (inSpeech.current && modeRef.current === "split") { toast("That is the speech doc — put the cursor in a card of a file to send it"); return; }
    const v = view.current;
    const EV = (window as any).EV;
    if (!v) return;
    if (!EV?.parseHtml || !EV?.sendParsed) { toast("The speech doc is still starting — a moment"); return; }
    const st = v.state, d = st.doc;
    const fid = viewFile.current.get(activeRef.current) || "";
    const fileName = loaded.current.get(fid)?.name || "a file";
    const $f = st.selection.$from;
    const top = $f.depth ? d.child($f.index(0)) : null;
    let from: number, to: number, whole = false;
    if (top && top.type === schema.nodes.heading && top.attrs.level < 4) {
      const sec = C.sections(d).find((s) => s.pos === $f.before(1));
      if (!sec) return;
      from = sec.pos; to = sec.end; whole = true;
    } else {
      const c = C.cardAround(st);
      if (!c?.tag) { toast("Put the cursor in a card (or on a block heading, to send the block)"); return; }
      from = c.tag.pos; to = c.end;
    }
    // answering: the card goes under what it answers, not to the end
    if (answerRef.current) {
      const nodes: PMNode[] = [];
      d.cut(from, to).forEach((n) => { if (!(n.type === schema.nodes.heading && n.attrs.level < 4)) nodes.push(n); });
      const said = nodes.find((n) => n.type === schema.nodes.heading)?.textContent || fileName;
      if (nodes.length && putUnder(nodes, said)) return;
    }
    // the block it is under names it in the speech doc, as a block from the library would be
    let block = "";
    if (!whole) d.forEach((n, p) => { if (p < from && n.type === schema.nodes.heading && n.attrs.level === 3) block = n.textContent.trim(); });
    const body = toHtml(d.cut(from, to));
    const html = (whole ? "" : `<h3>${esc(block || fileName)}</h3>`) + body;
    try {
      const parsed = EV.parseHtml(html, {});
      const blocks = (parsed.blocks || []).filter((b: any) => (b.args || []).length || (b.pre || []).length);
      if (!blocks.length) { toast("That card came out empty"); return; }
      for (const b of blocks) {
        await EV.sendParsed({ ...b, id: `rm:${fid}:${b.title}` }, whole ? null : 0, "from " + fileName);
      }
      setSentPulse((n) => n + 1);
    } catch (e: any) {
      toast("It did not send: " + String(e?.message || e));
    }
  }, [toast, putUnder]);

  // the library search's sends, too: the Split button says where they went
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const on = () => setSentPulse((n) => n + 1);
    el.addEventListener("evi:sent", on);
    return () => el.removeEventListener("evi:sent", on);
  }, []);

  // ---- a card from the search, somewhere other than the speech doc ---------------------
  const openCard = useCallback(async (d: { how: string; html: string; title: string; block: string; whole: boolean; from: string; file?: string; by?: string }) => {
    // one of your own files' cards, opened: the file itself, at the card
    if (d.how === "page" && d.file && filesRef.current.some((f) => f.id === d.file)) {
      const want = (d.whole ? d.block : d.title).replace(/\s+/g, " ").trim().toLowerCase();
      await open(d.file, (v) => {
        let pos = -1;
        v.state.doc.forEach((n, p) => { if (pos < 0 && n.type === schema.nodes.heading && n.textContent.replace(/\s+/g, " ").trim().toLowerCase() === want) pos = p; });
        if (pos >= 0) goPos(v, pos); else v.focus();
      });
      if (modeRef.current === "read") { modeRef.current = "edit"; setModeState("edit"); }
      return;
    }
    if (d.how === "answer") {
      const nodes: PMNode[] = [];
      fromHtml(d.html).forEach((n) => { if (!(n.type === schema.nodes.heading && n.attrs.level < 4)) nodes.push(n); });
      while (nodes.length && !nodes[nodes.length - 1].content.size && nodes[nodes.length - 1].type === schema.nodes.paragraph) nodes.pop();
      if (!nodes.length) { toast("That card came out empty"); return; }
      if (!putUnder(nodes, d.title)) toast("Pick what it answers first — the cursor on a tag of theirs, then Answer");
      return;
    }
    if (d.how === "page") {
      // a page of its own, kept with the round's docs and out of the library: to read, rehighlight, send from
      const rec: ViewDoc = { id: newDocId(), name: d.title.slice(0, 80) || "Card", kind: "html", source: d.from === "caselist" ? "caselist" : "library", by: d.by, at: Date.now(), html: d.html };
      await keepDoc(owner, rec);
      void refreshTheirs();
      if (modeRef.current === "read" || modeRef.current === "speech") { const m = modeRef.current === "speech" ? "split" : "edit"; modeRef.current = m; setModeState(m); inSpeech.current = false; }
      const fid = THEIRS + rec.id;
      const key = panesRef.current.length < MAX_PANES ? addPane({ fileId: fid, read: false, follow: true }) : null;
      if (key) requestAnimationFrame(() => requestAnimationFrame(() => { activate(key); views.current.get(key)?.focus(); }));
      else await open(fid, (v) => v.focus());
      toast(`“${rec.name.slice(0, 50)}” opened as a page — Keep as mine makes it a file of yours`);
      return;
    }
    // into whatever has the cursor — a file, or the speech doc — after the card it is in
    const v = target();
    if (!v || !v.editable || (v !== speechView.current && isRead(activeRef.current))) { toast("Put the cursor in a file you are editing first"); return; }
    const doc = fromHtml(d.html);
    const nodes: PMNode[] = [];
    // one card goes in under whatever block the cursor is in; a whole block brings its heading
    doc.forEach((n) => { if (d.whole || !(n.type === schema.nodes.heading && n.attrs.level < 4)) nodes.push(n); });
    while (nodes.length && !nodes[nodes.length - 1].content.size && nodes[nodes.length - 1].type === schema.nodes.paragraph) nodes.pop();
    if (!nodes.length) { toast("That card came out empty"); return; }
    const st = v.state, $f = st.selection.$from;
    const c = C.cardAround(st);
    const here = $f.depth ? $f.parent : null;
    // an empty line is where it was asked for; otherwise after the card the cursor is in
    const at = here && !here.content.size && here.type === schema.nodes.paragraph ? $f.before(1) : c?.tag ? c.end : $f.depth ? $f.after(1) : st.doc.content.size;
    const tr = st.tr.insert(at, PMFragment.from(nodes));
    tr.setSelection(TextSelection.create(tr.doc, Math.min(at + 1, tr.doc.content.size)));
    v.dispatch(tr.scrollIntoView());
    requestAnimationFrame(() => goPos(v, at));
    toast(`In ${v === speechView.current ? "the speech doc" : "the file"}: ${d.title.slice(0, 60)}`);
  }, [owner, open, addPane, activate, goPos, refreshTheirs, toast, putUnder]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const on = (e: Event) => { void openCard((e as CustomEvent).detail); };
    el.addEventListener("evi:open", on);
    return () => el.removeEventListener("evi:open", on);
  }, [openCard]);

  /** Tags only, on or off, in this editor. */
  const toggleTags = useCallback((v: EditorView | null) => {
    if (!v) return;
    const on = !isFolded(v.state);
    foldTags(v, on);
    if (v === speechView.current) setSpeechTags(on);
    setTick((n) => n + 1);
    toast(on ? "Tags only — the › after a tag opens it · " + (keyLabel(keyFor(keysRef.current, "tags-only")) || "the same button") + " shows everything again" : "Every card shown");
  }, [setSpeechTags, toast]);
  // the speech doc made again (a room joined, the Read tab left): folded the way it was
  useEffect(() => {
    const s = speechView.current;
    if (s && isFolded(s.state) !== speechTags) foldTags(s, speechTags);
  }, [speechTags]);

  // ---- the commands ---------------------------------------------------------
  const toggleVerb = useCallback(() => {
    const k = activeRef.current;
    if (k) setPaneRead(k, !isRead(k));
  }, [setPaneRead]);

  const focusLibrary = useCallback(() => {
    setTab("search");
    requestAnimationFrame(() => { const el = root.current?.querySelector("#q") as HTMLInputElement | null; el?.focus(); el?.select(); });
  }, [setTab]);

  const K = (id: string) => keyLabel(keyFor(keys, id));
  const run = useCallback((id: string) => {
    if (id === "verbatim") { toggleVerb(); return; }
    if (id === "read-beside") { readBeside(); return; }
    if (id === "next-pane") { nextPane(); return; }
    if (id === "sidebar") {
      // in Focus the side is a drawer: the key slides it out and back
      if (layoutMode === "focus") { setSide(true); setDrawer((d) => !d); return; }
      setSide((s) => !s); return;
    }
    if (id === "command") {
      // Spotlight's key: cards and commands in the middle of the screen. Elsewhere: the search, with commands after a >
      focusLibrary();
      if (layoutMode === "spotlight") setSpot(true);
      return;
    }
    if (id === "tab-next" || id === "tab-prev") {
      if (layoutMode !== "deck") { toast("Tabs are the Deck layout's — " + (K("layout") || "Colours") + " to get there"); return; }
      deckStep(id === "tab-next" ? 1 : -1);
      return;
    }
    if (id === "layout") {
      const i = LAYOUT_MODES.findIndex((l) => l.id === layoutMode);
      const next = LAYOUT_MODES[(i + 1) % LAYOUT_MODES.length];
      setLayoutMode(next.id);
      toast("Layout: " + next.name + " — " + next.sub);
      return;
    }
    if (id === "save") { void flush(true); return; }
    if (id === "find") { setTab("files"); requestAnimationFrame(() => { qIn.current?.focus(); qIn.current?.select(); }); return; }
    if (id === "library") { if (layoutMode === "focus") setDrawer(true); if (layoutMode === "spotlight") setSpot(true); focusLibrary(); return; }
    if (id === "new-file") { void create("Untitled file"); return; }
    if (id === "mode-split") { setMode(modeRef.current === "split" ? "edit" : "split"); return; }
    if (id === "mode-speech") { setMode(modeRef.current === "speech" ? "split" : "speech"); return; }
    if (id === "mode-read") { setMode(modeRef.current === "read" ? "edit" : "read"); return; }
    if (id === "timer") { setTimer((t) => ({ ...t, open: !t.open })); return; }
    if (id === "ribbon") { setMenu(null); setRibMin((r) => !r); return; }
    if (id === "tags-only") { toggleTags(target()); return; }
    if (id === "spelling") {
      const i = SPELL_MODES.findIndex((m) => m.id === spellRef.current);
      const n = SPELL_MODES[(i + 1) % SPELL_MODES.length];
      setSpell(n.id);
      toast(`Spelling: ${n.name.toLowerCase()}`);
      return;
    }
    if (id === "send") { void sendCard(); return; }
    if (id === "answer") { answer(); return; }
    if (id === "hl-next") {
      const i = C.HIGHLIGHTS.findIndex((h) => h.color === hlRef.current);
      const n = C.HIGHLIGHTS[(i + 1) % C.HIGHLIGHTS.length];
      setHl(n.color);
      toast(`Highlighter: ${n.name}`);
      return;
    }
    if (modeRef.current === "read" && IN_DOC.has(id)) { toast("Read mode — Esc to edit"); return; }
    const v = target();
    if (!v) return;
    const speech = v === speechView.current;
    if (!speech && isRead(activeRef.current) && IN_DOC.has(id) && !IN_READ.has(id)) { toast(`A read page — ${keyLabel(keyFor(keysRef.current, "verbatim")) || "Verbatimise"} to edit it`); return; }
    if (speech && !v.editable) { toast("The speech doc is showing its Read tab — switch it back to Send doc to edit"); return; }
    const exec = (cmd: (s: EditorState, d?: EditorView["dispatch"]) => boolean) => { cmd(v.state, v.dispatch); v.focus(); };
    switch (id) {
      case "undo": { if (!undo(v.state, v.dispatch)) { try { undoCommand(v.state, v.dispatch); } catch { /* nothing to undo */ } } v.focus(); return; }
      case "redo": { if (!redo(v.state, v.dispatch)) { try { redoCommand(v.state, v.dispatch); } catch { /* nothing to redo */ } } v.focus(); return; }
      case "pocket": return exec(C.setLevel(1));
      case "hat": return exec(C.setLevel(2));
      case "block": return exec(C.setLevel(3));
      case "tag": return exec(C.setLevel(4));
      case "cite": return exec(C.cite);
      case "underline": {
        try { (v as any).domObserver?.flush?.(); } catch { /* read on its own soon enough */ }
        return exec(C.cut);
      }
      case "emphasis": return exec(C.emphasis);
      case "highlight": return exec(C.highlight(hlRef.current));
      case "clear": return exec(C.clear);
      case "shrink": return exec(C.shrink);
      case "condense": return exec(C.condense);
      case "condense-omitted": {
        const r = C.condenseOmitted(v.state);
        if (typeof r === "string") toast(r); else v.dispatch(r);
        v.focus();
        return;
      }
      case "new-card": return exec(C.newCard);
      case "move-up": return exec(C.moveBy(-1));
      case "move-down": return exec(C.moveBy(1));
      case "new-extension": return exec(X.newExtension(speech ? "" : curRef.current?.name || ""));
      case "analytic": return exec(X.analytic);
      case "page-break": return exec(X.pageBreak);
      case "reference": {
        if (!R.referenceCard(hlRef.current)(v.state)) { toast("Put the cursor in a card (or select some of one) to keep it for reference"); return; }
        return exec(R.referenceCard(hlRef.current));
      }
      case "insert-reference": setRefPick({ q: "", sel: 0 }); return;
      case "reformat": {
        const whole = v.state.selection.empty;
        const r = reformat(v.state, hlRef.current, citeRef.current);
        if (!r.tr.docChanged) { toast(whole ? "Every card here is formatted already" : "What's selected is formatted already"); v.focus(); return; }
        v.dispatch(r.tr);
        v.focus();
        const said = [
          r.tags && `${r.tags} tag${r.tags === 1 ? "" : "s"} made tag${r.tags === 1 ? "" : "s"} again`,
          r.recoloured && "highlighting one colour",
          r.boxed && "emphasis boxed",
          r.plain && "pasted fonts and colours off",
          r.sized && "sizes set (11pt read, 8pt shrunk)",
          r.spaces && `${r.spaces} stray space${r.spaces === 1 ? "" : "s"} unmarked`,
          r.doubles && `${r.doubles} double space${r.doubles === 1 ? "" : "s"} made single`,
          r.cites && `${r.cites} cite${r.cites === 1 ? "" : "s"} rewritten`,
        ].filter(Boolean).join(", ");
        toast(`Reformatted${whole ? (speech ? " the speech doc" : " the file") : ""}: ${said}`);
        return;
      }
      case "clean-up": {
        const { tr, spaces, doubles } = C.cleanUp(v.state);
        if (!tr.docChanged) { toast(v.state.selection.empty ? "Nothing to clean up here" : "Nothing to clean up in what's selected"); v.focus(); return; }
        v.dispatch(tr);
        v.focus();
        const said = [spaces && `${spaces} space${spaces === 1 ? "" : "s"} unmarked`, doubles && `${doubles} double space${doubles === 1 ? "" : "s"} made single`].filter(Boolean).join(", ");
        toast(`Cleaned up: ${said}`);
        return;
      }
      case "paste": {
        if (!navigator.clipboard?.readText) { toast("This browser will not read the clipboard — use Ctrl+Shift+V"); return; }
        navigator.clipboard.readText().then((t) => {
          if (!t) return;
          v.dispatch(v.state.tr.replaceSelection(C.plainSlice(t)).scrollIntoView());
          v.focus();
        }).catch(() => toast("Paste as text needs the clipboard — allow it, or use Ctrl+Shift+V"));
        return;
      }
    }
  }, [flush, create, toast, toggleVerb, readBeside, nextPane, setTab, setMode, sendCard, focusLibrary, answer, toggleTags, layoutMode, deckTabs, mode, cur, keys]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Deck: tabs for the pages opened this session, and the speech doc ----------------------------
  useEffect(() => {
    if (!cur) return;
    setDeckTabs((t) => (t.some((x) => x.id === cur.id) ? t.map((x) => (x.id === cur.id && x.name !== cur.name ? { ...x, name: cur.name } : x)) : [...t, { id: cur.id, name: cur.name }]));
  }, [cur?.id, cur?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  // one page at a time: the deck shows a file or the speech doc, not both
  useEffect(() => { if (layoutMode === "deck" && mode === "split") setMode("edit"); }, [layoutMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const deckOpen = (id: string) => {
    if (id === "speech") { setMode("speech"); return; }
    if (mode !== "edit") setMode("edit");
    if (cur?.id !== id) void open(id, (v) => v.focus()); else requestAnimationFrame(() => view.current?.focus());
  };
  const deckNow = mode === "speech" ? "speech" : cur?.id || "";
  const deckStep = (d: number) => {
    const ids = [...deckTabs.map((t) => t.id), "speech"];
    const i = ids.indexOf(deckNow);
    deckOpen(ids[(i + d + ids.length) % ids.length]);
  };
  const deckClose = (id: string) => {
    const i = deckTabs.findIndex((t) => t.id === id);
    const rest = deckTabs.filter((t) => t.id !== id);
    setDeckTabs(rest);
    if (deckNow === id) deckOpen(rest.length ? rest[Math.min(i, rest.length - 1)].id : "speech");
  };

  // ---- Flow-board: three columns, each of their tags wired to the heading that answers it --------------
  const wires = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (layoutMode !== "board") return;
    // their doc beside the speech doc is the point of it
    if (mode === "edit") setMode("split");
  }, [layoutMode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (layoutMode !== "board" || mode !== "split") return;
    const work = workBox.current;
    if (!work) return;
    let raf = 0;
    const clean = (t: string) => t.replace(/⋮⋮/g, "").replace(/\s+/g, " ").trim();
    const draw = () => {
      raf = 0;
      const svg = wires.current;
      if (!svg) return;
      const W = work.getBoundingClientRect();
      const pane = (work.querySelector(".rm-pane.active") || work.querySelector(".rm-pane")) as HTMLElement | null;
      const box = pane?.querySelector(".rm-scroll") as HTMLElement | null;
      const pm = work.querySelector("#docbody .ProseMirror");
      const sbox = work.querySelector("#docbody") as HTMLElement | null;
      if (!pane || !box || !pm || !sbox) { svg.innerHTML = ""; return; }
      // the speech doc's headings, and which have cards under them
      const heads = new Map<string, { el: Element; has: boolean }>();
      let curH: { el: Element; has: boolean } | null = null;
      for (const el of Array.from(pm.children)) {
        if (/^H[1-3]$/.test(el.tagName)) { curH = { el, has: false }; heads.set(clean(el.textContent || "").toLowerCase(), curH); }
        else if (el.tagName === "H4" && curH) curH.has = true;
      }
      const P = box.getBoundingClientRect(), S = sbox.getBoundingClientRect();
      const x1 = P.right - W.left - 7, x2 = S.left - W.left + 7;
      let out = "";
      pane.querySelectorAll(".ct-sheet h4").forEach((h) => {
        const t = clean(h.textContent || "");
        if (!t) return;
        const hit = heads.get(("AT: " + headOf(t)).toLowerCase());
        const r = h.getBoundingClientRect();
        const y = r.top + Math.min(r.height, 22) / 2;
        if (y < P.top + 4 || y > P.bottom - 4) return;            // their tag is scrolled away
        const y1 = y - W.top;
        if (!hit) {
          out += `<circle cx="${x1}" cy="${y1}" r="3.5" class="w-none"/>`;
          return;
        }
        const hr = hit.el.getBoundingClientRect();
        const off = hr.top + hr.height / 2 < S.top ? -1 : hr.top + hr.height / 2 > S.bottom ? 1 : 0;
        const y2 = Math.max(S.top + 10, Math.min(S.bottom - 10, hr.top + hr.height / 2)) - W.top;
        const cls = hit.has ? "w-done" : "w-open";
        const mid = (x1 + x2) / 2;
        out += `<path d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}" class="${cls}${off ? " w-off" : ""}"/>`;
        out += `<circle cx="${x1}" cy="${y1}" r="5" class="${cls}"/>`;
        if (hit.has) out += `<path d="M${x1 - 2.4} ${y1} l1.7 1.8 l3.1 -3.4" class="w-tick"/>`;
        out += off ? `<path d="M${x2 - 4} ${y2 + (off < 0 ? 4 : -4)} l4 ${off < 0 ? -6 : 6} l4 ${off < 0 ? 6 : -6}" class="w-arr ${cls}"/>` : `<circle cx="${x2}" cy="${y2}" r="3" class="${cls}"/>`;
      });
      svg.setAttribute("viewBox", `0 0 ${W.width} ${W.height}`);
      svg.innerHTML = out;
    };
    const later = () => { if (!raf) raf = requestAnimationFrame(draw); };
    work.addEventListener("scroll", later, true);
    const ro = new ResizeObserver(later);
    ro.observe(work);
    // the docs change as they are written in
    const iv = window.setInterval(later, 450);
    later();
    return () => { work.removeEventListener("scroll", later, true); ro.disconnect(); clearInterval(iv); cancelAnimationFrame(raf); };
  }, [layoutMode, mode, panes.length]);

  // ---- Spotlight: the search floated over the pages, gone again on Esc or a click away ----------------
  useEffect(() => { if (layoutMode !== "spotlight") setSpot(false); }, [layoutMode]);
  useEffect(() => {
    if (layoutMode !== "spotlight") return;
    const q = root.current?.querySelector("#q");
    const on = () => setSpot(true);
    q?.addEventListener("focus", on);
    return () => q?.removeEventListener("focus", on);
  }, [layoutMode]);
  useEffect(() => {
    if (!spot) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!t.closest?.(".tp-search, .rm-menu, .evi .veil, .rm-spothint")) setSpot(false);
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [spot]);

  // ---- commands, over the search's results -----------------------------------------------------------
  useEffect(() => {
    const q = root.current?.querySelector("#q") as HTMLInputElement | null;
    if (!q) return;
    const on = () => { setCmdQ(q.value); setCmdSel(0); };
    q.addEventListener("input", on);
    return () => q.removeEventListener("input", on);
  }, [uiReady]);
  /** Everything there is to do, by name: the keyed actions, the modes, the layouts, the colours. */
  const commands = (() => {
    const out: { id: string; label: string; key: string; go: () => void }[] = [];
    ACTIONS.forEach((a) => { if (a.id !== "command") out.push({ id: a.id, label: a.label, key: K(a.id), go: () => run(a.id) }); });
    ([["edit", "Just the file"], ["split", "Speech doc beside"], ["speech", "Just the speech doc"], ["read", "Read mode"]] as const)
      .forEach(([m, l]) => out.push({ id: "mode:" + m, label: "Mode: " + l, key: "", go: () => setMode(m) }));
    LAYOUT_MODES.forEach((l) => out.push({ id: "layout:" + l.id, label: "Layout: " + l.name, key: "", go: () => setLayoutMode(l.id) }));
    PALETTES.forEach((p) => out.push({ id: "pal:" + p.id, label: "Colours: " + p.name, key: "", go: () => setPalette(p.id) }));
    return out;
  })();
  const cmdMode = cmdQ.startsWith(">");
  const cmdHits = (() => {
    const raw = (cmdMode ? cmdQ.slice(1) : cmdQ).trim().toLowerCase();
    if (!cmdMode && (layoutMode !== "spotlight" || raw.length < 2)) return [];
    const words = raw.split(/\s+/).filter(Boolean);
    const scored = commands.map((c) => {
      const l = c.label.toLowerCase(), lw = l.split(/[^a-z0-9]+/);
      if (!words.every((w) => l.includes(w))) return null;
      const s = words.reduce((n, w) => n + (lw.some((x) => x.startsWith(w)) ? 2 : 1), 0) + (l.startsWith(words[0] || "") ? 2 : 0);
      return { c, s };
    }).filter(Boolean) as { c: (typeof commands)[number]; s: number }[];
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, cmdMode ? 9 : 3).map((x) => x.c);
  })();
  const runCommand = (c: (typeof commands)[number]) => {
    const q = root.current?.querySelector("#q") as HTMLInputElement | null;
    if (q) { q.value = ""; q.dispatchEvent(new Event("input", { bubbles: true })); }
    setSpot(false);
    // the page gets the cursor back first: most commands work on it
    const v = target();
    v?.focus();
    requestAnimationFrame(() => c.go());
  };
  const onCmdKey = (e: React.KeyboardEvent) => {
    if (!cmdMode || !(e.target as HTMLElement).matches?.("#q")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); setCmdSel((n) => Math.min(cmdHits.length - 1, n + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); setCmdSel((n) => Math.max(0, n - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); const c = cmdHits[cmdSel]; if (c) runCommand(c); }
  };

  const runRef = useRef(run);
  runRef.current = run;

  // every key, before the page does anything with it
  useEffect(() => {
    const inDoc = () => {
      const v = view.current, s = speechView.current;
      return (!!v && v.hasFocus()) || (!!s && s.hasFocus()) || (document.activeElement === document.body && !!curRef.current);
    };
    const onKey = (e: KeyboardEvent) => {
      if (listeningRef.current) return;
      if (document.querySelector(".evi .veil.on")) return;                // one of the library's dialogs is open
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      // / with nothing being typed in: the library search, wherever it is
      if (e.key === "/" && !typing && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); focusLibrary(); return; }
      if (e.key === "Escape" && modeRef.current === "read") { e.preventDefault(); setMode("edit"); return; }
      // Esc in the search with nothing typed: back to the page (their case, while answering it)
      if (e.key === "Escape" && t && t.id === "q" && !(t as HTMLInputElement).value) {
        e.preventDefault(); e.stopPropagation();
        setSpot(false);
        (answerRef.current?.claim ? view.current : target())?.focus();
        return;
      }
      const spec = comboOf(e);
      if (!spec) return;
      const id = actionFor(keysRef.current, spec);
      if (!id) return;
      if (IN_DOC.has(id) && !inDoc()) return;
      e.preventDefault();
      e.stopPropagation();
      run(id);
    };
    window.addEventListener("keydown", onKey, true);
    const offChords = watchChords((spec, e) => {
      if (listeningRef.current) return;
      const id = actionFor(keysRef.current, spec);
      if (!id) return;
      if (IN_DOC.has(id) && !inDoc()) return;
      e.preventDefault();
      run(id);
    });
    return () => { window.removeEventListener("keydown", onKey, true); offChords(); };
  }, [run, focusLibrary, setMode]);

  // ---- the Keys panel ---------------------------------------
  useEffect(() => {
    if (!listening) return;
    const take = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setListening(null); setKeyNote(""); return; }
      if (e.key === "Backspace" || e.key === "Delete") {
        const { next } = bind(keysRef.current, listening, null);
        setKeys(next); saveKeys(owner, next); setListening(null);
        setKeyNote(`${ACTION.get(listening)?.label} has no key now`);
        return;
      }
      const spec = comboOf(e);
      if (spec) give(spec);
    };
    const give = (spec: string) => {
      const no = refuse(spec);
      if (no) { setKeyNote(no); return; }
      const { next, moved } = bind(keysRef.current, listening, spec);
      setKeys(next); saveKeys(owner, next); setListening(null);
      setKeyNote(`${ACTION.get(listening)?.label}: ${keyLabel(spec)}` + (moved ? ` — ${ACTION.get(moved)?.label} had it, and has no key now` : "") + (caveat(spec) ? `. ${caveat(spec)}.` : ""));
    };
    window.addEventListener("keydown", take, true);
    const offChords = watchChords((spec, e) => { e.preventDefault(); give(spec); });
    return () => { window.removeEventListener("keydown", take, true); offChords(); };
  }, [listening, owner]);
  useEffect(() => {
    if (!keysOpen || listening) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setKeysOpen(false); view.current?.focus(); } };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [keysOpen, listening]);
  // a menu closes on Esc or a click elsewhere
  useEffect(() => {
    if (!menu) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMenu(null); target()?.focus(); } };
    const away = (e: PointerEvent) => { if (!(e.target as Element).closest?.(".rm-menu, .rm-menubtn")) setMenu(null); };
    window.addEventListener("keydown", esc, true);
    window.addEventListener("pointerdown", away, true);
    return () => { window.removeEventListener("keydown", esc, true); window.removeEventListener("pointerdown", away, true); };
  }, [menu]);
  const openMenu = (id: string, e: React.MouseEvent<HTMLElement>, anchor?: HTMLElement | null) => {
    if (menu?.id === id) { setMenu(null); return; }
    const r = (anchor || e.currentTarget).getBoundingClientRect();
    const w = id === "palette" ? 480 : id === "pages" || id === "share" ? 330 : id.startsWith("g:") ? 360 : 240;
    const inRib = !!(anchor || e.currentTarget).closest(".rm-rib");
    // from the dock a menu opens upwards
    if (inRib && layoutMode === "dock") { setMenu({ id, x: Math.min(window.innerWidth - w - 8, Math.max(8, r.left)), y: 0, up: window.innerHeight - r.top + 6 }); return; }
    setMenu({ id, x: Math.min(window.innerWidth - w - 8, Math.max(8, r.left)), y: r.bottom + 6 });
  };

  /** Where a menu sits: under its button, or — opened from the dock — over it, kept on screen. */
  const menuAt = (m: { x: number; y: number; up?: number }): React.CSSProperties =>
    typeof m.up === "number" ? { left: m.x, bottom: m.up, maxHeight: `calc(100vh - ${m.up + 8}px)`, overflowY: "auto" }
      : { left: m.x, top: m.y };

  // ---- searching every file ------------------------------------------------------
  const indexFor = useRef<{ files: CutMeta[] | null; ix: { s: unknown; cards: unknown[][]; where: { file: number; i: number }[] } | null }>({ files: null, ix: null });
  const indexOf = useCallback((files: CutMeta[]) => {
    if (indexFor.current.files === files && indexFor.current.ix) return indexFor.current.ix;
    const blocks: string[] = [], bi = new Map<string, number>();
    const cards: unknown[][] = [], where: { file: number; i: number }[] = [];
    files.forEach((f, fi) => (f.cards || []).forEach((c) => {
      let b = -1;
      if (c.block) { b = bi.get(c.block) ?? -1; if (b < 0) { b = blocks.length; blocks.push(c.block); bi.set(c.block, b); } }
      cards.push([fi, c.tag, c.cite, 0, b < 0 ? undefined : b, c.read]);
      where.push({ file: fi, i: c.i });
    }));
    const ix = { s: buildSearch(cards, blocks), cards, where };
    indexFor.current = { files, ix };
    return ix;
  }, []);
  const results = useMemo(() => {
    const w = q.trim();
    if (w.length < 2) return null;
    const index = indexOf(files);
    const low = w.toLowerCase();
    const named = files.filter((f) => f.name.toLowerCase().includes(low));
    const { hits } = searchCards(index.s, w, (i: number) => String(index.cards[i][1] || ""));
    const cards = (hits as { i: number }[]).slice(0, 60).map((h) => {
      const c = index.cards[h.i], at = index.where[h.i], f = files[at.file];
      return { key: f.id + ":" + at.i, file: f, i: at.i, tag: String(c[1] || "(no tag)"), cite: String(c[2] || ""), block: f.cards.find((x) => x.i === at.i)?.block || "" };
    });
    return { named, cards };
  }, [q, files, indexOf]);

  const refHits = useMemo(() => {
    if (!refPick) return [];
    const w = refPick.q.trim();
    if (w.length < 2) return [];
    const index = indexOf(files);
    const { hits } = searchCards(index.s, w, (i: number) => String(index.cards[i][1] || ""));
    return (hits as { i: number }[]).slice(0, 12).map((h) => {
      const c = index.cards[h.i], at = index.where[h.i], f = files[at.file];
      return { key: f.id + ":" + at.i, file: f, i: at.i, tag: String(c[1] || "(no tag)"), cite: String(c[2] || "") };
    });
  }, [refPick, indexOf, files]);
  useEffect(() => { if (refPick) requestAnimationFrame(() => refIn.current?.focus()); }, [refPick !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const putReference = useCallback(async (hit: { file: CutMeta; i: number }) => {
    setRefPick(null);
    const v = target();
    if (!v) return;
    let doc: PMNode | null = null;
    const k = keyShowing(hit.file.id);
    if (k) doc = views.current.get(k)!.state.doc;
    else { const f = await getFile(owner, hit.file.id); if (f) doc = docOf(f); }
    const nodes = doc ? R.referenceNodes(doc, hit.i) : null;
    if (!nodes) { toast("That card has moved — search for it again"); v.focus(); return; }
    R.insertReference(nodes)(v.state, v.dispatch);
    v.focus();
    toast(`For reference: ${nodes[0].textContent.slice(0, 60)}`);
  }, [owner, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTag = useCallback((v: EditorView, n: number) => {
    let k = -1, pos = -1;
    v.state.doc.forEach((node, p) => { if (pos < 0 && node.type === schema.nodes.heading && node.attrs.level === 4 && ++k === n) pos = p; });
    if (pos < 0) return;
    goPos(v, pos);
  }, [goPos]);

  // ---- dragging in the outline ---------------------------------------------------
  const [drag, setDrag] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const dropTarget = (from: number, i: number): number | null => {
    const v = target();
    if (!v) return null;
    const secs = C.sections(v.state.doc);
    const me = secs.find((s) => s.pos === heads[from]?.pos);
    if (!me) return null;
    const t = i < heads.length ? heads[i].pos : v.state.doc.content.size;
    return t >= me.pos && t <= me.end ? null : t;
  };
  const onRowDrag = (e: React.DragEvent, i: number) => {
    if (drag === null) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const a = e.clientY > r.top + r.height / 2 ? i + 1 : i;
    const ok = dropTarget(drag, a) !== null;
    e.dataTransfer.dropEffect = ok ? "move" : "none";
    setDropAt(ok ? a : null);
  };
  const dropRow = () => {
    const v = target();
    if (v && drag !== null && dropAt !== null) {
      const t = dropTarget(drag, dropAt);
      const tr = t === null ? null : C.moveSection(v.state, heads[drag].pos, t);
      if (tr) {
        v.dispatch(tr);
        const pos = v.state.selection.$from.before(1);
        requestAnimationFrame(() => goPos(v, pos));
      }
    }
    setDrag(null); setDropAt(null);
  };

  /** A heading taken out of the outline: it, and everything under it. The speech doc's list of what was sent follows. */
  const removeSection = (pos: number) => {
    const v = target();
    if (!v || !v.editable) return;
    const sec = C.sections(v.state.doc).find((x) => x.pos === pos);
    if (!sec) return;
    v.dispatch(v.state.tr.delete(sec.pos, sec.end).scrollIntoView());
    toast("Deleted — Ctrl+Z brings it back");
  };

  // ---- the lines between pages, and between the pages and the speech doc, drag -----------------
  const dragSplit = (e: React.PointerEvent<HTMLDivElement>, i: number) => {
    e.preventDefault();
    const el = e.currentTarget, box = panesBox.current;
    if (!box) return;
    el.setPointerCapture(e.pointerId);
    const total = box.getBoundingClientRect().width;
    const start = e.clientX, w0 = [...widths], sum = w0.reduce((a, b) => a + b, 0);
    const pair = w0[i] + w0[i + 1];
    const min = (240 / total) * sum;
    const move = (ev: PointerEvent) => {
      const d = ((ev.clientX - start) / total) * sum;
      const a = Math.min(pair - min, Math.max(min, w0[i] + d));
      const next = [...w0]; next[i] = a; next[i + 1] = pair - a;
      setWidths(next);
    };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const dragSide = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget, body = el.parentElement;
    if (!body) return;
    el.setPointerCapture(e.pointerId);
    const br = body.getBoundingClientRect();
    // Mirror has the side on the right: it widens as the edge goes left
    const mirror = root.current?.dataset.layout === "mirror";
    const move = (ev: PointerEvent) => setSideW(Math.round(Math.min(Math.min(760, window.innerWidth - 360), Math.max(220, mirror ? br.right - ev.clientX : ev.clientX - br.left))));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const dragSpeech = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget, box = workBox.current;
    if (!box) return;
    el.setPointerCapture(e.pointerId);
    const r = box.getBoundingClientRect();
    const lay = root.current?.dataset.layout;
    // Stack: the speech doc is under the file, and the edge moves up and down; Mirror: it is on the left
    const clamp = (x: number) => Math.min(.75, Math.max(.25, x));
    const move = (ev: PointerEvent) => {
      if (lay === "stack") setSpeechH(clamp((r.bottom - ev.clientY) / r.height));
      else setSpeechW(clamp(lay === "mirror" ? (ev.clientX - r.left) / r.width : (r.right - ev.clientX) / r.width));
    };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  // ---- opening and downloading -------------------------------------------------
  const openFile = useCallback(async (file: File) => {
    setBusy(true);
    try {
      const n = file.name.toLowerCase();
      let html: string;
      if (n.endsWith(".pdf")) { await openTheirFile(file); toast("A PDF opens to read — it can't be cut"); return; }
      if (n.endsWith(".docx")) html = await docxToHtml(file);
      else if (n.endsWith(".html") || n.endsWith(".htm")) html = sanitize(await file.text());
      else html = (await file.text()).split(/\r?\n/).map((l) => `<p>${esc(l)}</p>`).join("");
      await create(file.name.replace(/\.(docx|html?|txt)$/i, ""), html);
      toast(`Opened “${file.name}” as a file of your own — in the library search too`);
    } catch (e) {
      toast("Could not open that: " + (e as Error).message);
    } finally { setBusy(false); }
  }, [create, toast, openTheirFile]);

  const download = useCallback(async (id: string) => {
    try {
      const k = keyShowing(id);
      let html: string, fileName: string;
      if (k) { html = toHtml(views.current.get(k)!.state.doc); fileName = loaded.current.get(id)?.name || "cards"; }
      else { const f = await getFile(owner, id); if (!f) return; html = f.html; fileName = f.name; }
      const [{ elementsFromHtml }, { downloadDocx }] = await Promise.all([import("@/lib/evidence/engine") as Promise<any>, import("@/lib/evidence/docx")]);
      await downloadDocx(elementsFromHtml(html), fileName);
    } catch (e) { toast("Could not make the .docx: " + (e as Error).message); }
  }, [owner, toast]);

  // ---- Evidence's engine: the library search and the speech doc, booted on this whole tool ----
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let off: (() => void) | undefined;
    let dead = false;
    import("@/lib/evidence/engine").then((m: any) => {
      if (dead) return;
      off = m.boot(el, { owner, me, room, magic: true });
    });
    return () => { dead = true; if (off) off(); };
  }, [owner, me, room]);
  // the speech doc's width, for its page to fit
  useEffect(() => {
    const el = speechBox.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (el.clientWidth) setSpeechWidth(el.clientWidth - (speechOutline ? 236 : 26)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [speechOutline]);
  // the cursor going into the speech doc: the ribbon, the outline and the status line follow it there
  // spelling, changed: every page told, and the speech doc (all of it is checked, or none — it isn't ours to decorate)
  useEffect(() => {
    for (const v of views.current.values()) v.dispatch(v.state.tr.setMeta(spellKey, spell));
    const sv = speechView.current;
    if (sv) sv.dispatch(sv.state.tr.setMeta(spellKey, spell).setMeta("addToHistory", false));
  }, [spell]);
  /** What makes the speech doc edit as a page does: a page's Enter, a page's spelling. */
  const speechPlugins = useCallback(() => [
    keymap({ Enter: X.enterKeepingAnalytics }),
    spellPlugin(spellRef.current),
    placePlugin(),
    gripPlugin(),
    foldPlugin(speechTagsRef.current),
  ], []);
  // a card sent from the search (or Alt+Enter in a file) goes where the speech doc's cursor is
  useEffect(() => {
    const placer = (d: { html: string; whole: boolean }) => {
      const s = speechView.current;
      if (!s || !s.editable) return null;
      const nodes: PMNode[] = [];
      fromHtml(d.html).forEach((n) => nodes.push(n));
      const r = placeCard(s.state, nodes, d.whole);
      if (!r) return null;
      s.dispatch(r.tr.scrollIntoView());
      setSentPulse((n) => n + 1);
      return { html: toHtml(s.state.doc), where: r.where };
    };
    let tries = 0;
    const t = setInterval(() => {
      const EV = (window as any).EV;
      if (EV?.setPlacer) { EV.setPlacer(placer); clearInterval(t); } else if (++tries > 100) clearInterval(t);
    }, 100);
    return () => { clearInterval(t); (window as any).EV?.setPlacer?.(null); };
  }, []);
  const onSpeechView = useCallback((v: EditorView | null) => {
    speechView.current = v;
    if (!v) { inSpeech.current = false; return; }
    v.dom.addEventListener("focus", () => { inSpeech.current = true; readHeads(); });
  }, [readHeads]);
  const speechT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSpeechChange = useCallback(() => {
    if (!inSpeech.current) return;
    if (speechT.current) clearTimeout(speechT.current);
    speechT.current = setTimeout(readHeads, 120);
  }, [readHeads]);

  // ---- the timer -----------------------------------------------------------------
  useEffect(() => {
    if (timer.since === null) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [timer.since]);
  const ran = timer.ran + (timer.since !== null ? (Date.now() - timer.since) / 1000 : 0);
  const left = timer.limit - ran;

  // ---- drawing --------------------------------------------------------------
  const tip = (id: string, label?: string) => `${label || ACTION.get(id)?.label || id}${K(id) ? " · " + K(id) : ""}`;
  const groups = useMemo(() => Array.from(new Set(ACTIONS.map((a) => a.group))), []);
  const activePane = panes.find((p) => p.key === activeKey) || null;
  const activeRead = !!activePane?.read;
  const many = panes.length > 1;
  const curTheirs = !!cur && isTheirs(cur.id);
  // their case, as a list of what has been answered: a tag of theirs with cards under its heading in the speech doc
  const answered = (() => {
    const set = new Set<string>();
    const sv = speechView.current;
    if (!sv || !curTheirs || headsOf !== "page") return set;
    let head = "";
    sv.state.doc.forEach((n) => {
      if (n.type !== schema.nodes.heading) return;
      if (n.attrs.level < 4) head = n.textContent.trim().toLowerCase();
      else if (head) set.add(head);
    });
    return set;
  })();
  const curShare = cur?.share && !curTheirs ? shares.current.get(cur.id) || null : null;
  const theirFor = (fid: string) => theirMeta.current.get(fid);
  // The outline as a tree. Each heading knows whether it has anything under it (a fold mark) and whether
  // it is open: by hand, or else by the depth buttons. A row shows when everything over it is open.
  // Indented from the biggest heading the doc has, so a file with no pocket starts at the edge.
  const olWhose = (headsOf === "speech" ? "speech" : cur?.id || "") + "|";
  const olTop = heads.length ? Math.min(...heads.map((h) => h.level)) : 1;
  const olTree = (() => {
    const seen = new Map<string, number>();
    const out: { h: Head; i: number; key: string; kids: boolean; open: boolean; show: boolean; parent: number }[] = [];
    const stack: number[] = [];                       // indices into out of the open path
    heads.forEach((h, i) => {
      const base = h.level + ":" + h.text;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      const key = olWhose + base + ":" + n;
      while (stack.length && out[stack[stack.length - 1]].h.level >= h.level) stack.pop();
      const parent = stack.length ? stack[stack.length - 1] : -1;
      const kids = i + 1 < heads.length && heads[i + 1].level > h.level;
      const open = key in olFold ? olFold[key] : h.level < depth;
      const show = parent < 0 || (out[parent].show && out[parent].open);
      out.push({ h, i, key, kids, open, show, parent });
      stack.push(out.length - 1);
    });
    return out;
  })();
  const olQ = olFilter.trim().toLowerCase();
  const olRows = olQ ? olTree.filter((r) => r.h.text.toLowerCase().includes(olQ)) : olTree.filter((r) => r.show);
  // the heading the cursor is in — or, folded away, the nearest one over it that shows
  const olAt = (() => {
    let k = at >= 0 && at < olTree.length ? at : -1;
    if (olQ) return k;
    while (k >= 0 && !olTree[k].show) k = olTree[k].parent;
    return k;
  })();
  const olToggle = (key: string, open: boolean) => setOlFold((f) => ({ ...f, [key]: !open }));
  // where the cursor is: pocket › hat › block › tag
  const crumb = (() => {
    if (at < 0) return "";
    const path: string[] = [];
    let lvl = 9;
    for (let i = at; i >= 0 && lvl > 1; i--) if (heads[i].level < lvl) { path.unshift(heads[i].text); lvl = heads[i].level; }
    return path.join(" › ");
  })();
  const cardNo = (() => { let n = 0; for (let i = 0; i <= at && i < heads.length; i++) if (heads[i].level === 4) n++; return n; })();
  void tick;

  // a ribbon button: made once per set of keys, so the ribbon is not rebuilt on every keystroke
  const B = useMemo(() => function RibbonButton({ id, cls, children, label }: { id: string; cls?: string; children: React.ReactNode; label?: string }) {
    const k = keyLabel(keyFor(keys, id));
    const name = label || ACTION.get(id)?.label || id;
    return (
      <button type="button" className={"rm-b" + (cls ? " " + cls : "")} data-tip={name + (k ? " · " + k : "")} aria-label={name}
        onMouseDown={(e) => e.preventDefault()} onClick={() => runRef.current(id)}>{children}</button>
    );
  }, [keys]);

  // the ribbon's groups: each folds into one button whose popover holds the same buttons
  // folded, a group keeps its most-used buttons in one row, and a ▾ for the rest
  const ribbon: { id: string; name: string; sub: string; cols: string; body: React.ReactNode; mini: React.ReactNode }[] = [
    { id: "file", name: "File", sub: "open, new, download, keys", cols: "c2", body: <>
      <button type="button" className="rm-b rm-i" data-tip="Open a .docx, web page or text as a file of yours" aria-label="Open a file" onClick={() => fileIn.current?.click()} disabled={busy}>{I.folder}</button>
      <B id="new-file" cls="rm-i" label="New file">{I.newfile}</B>
      <button type="button" className="rm-b rm-i" data-tip="Download this file as a .docx" aria-label="Download as .docx" onClick={() => { const fid = viewFile.current.get(activeRef.current); if (fid && !isTheirs(fid)) void download(fid); else toast("Their docs download from where they came from — or keep it as yours first"); }}>{I.down}</button>
      <button type="button" className={"rm-b rm-i" + (keysOpen ? " on" : "")} data-tip="Keys, and the cite format" aria-label="Keys" onClick={() => { setMenu(null); setKeysOpen((o) => !o); setKeyNote(""); }}>{I.keys}</button>
    </>,
    mini: <>
      <button type="button" className="rm-b rm-i" data-tip="Open a .docx, web page or text as a file of yours" aria-label="Open a file" onClick={() => fileIn.current?.click()} disabled={busy}>{I.folder}</button>
      <B id="new-file" cls="rm-i" label="New file">{I.newfile}</B>
    </> },
    { id: "styles", name: "Styles", sub: "pocket, hat, block, tag, analytic, cite", cols: "c3", body: <>
      <B id="pocket"><span className="s-pocket">Pocket</span></B>
      <B id="hat"><span className="s-hat">Hat</span></B>
      <B id="block"><span className="s-block">Block</span></B>
      <B id="tag"><span className="s-tag">Tag</span></B>
      <B id="analytic"><span className="s-ana">Analytic</span></B>
      <B id="cite"><span className="s-cite">Cite</span></B>
    </>,
    mini: <>
      <B id="tag"><span className="s-tag">Tag</span></B>
      <B id="block"><span className="s-block">Block</span></B>
      <B id="cite"><span className="s-cite">Cite</span></B>
    </> },
    { id: "cut", name: "Cut", sub: "cut, emphasis, shrink, highlight, clear, condense, condense ¶ none omitted", cols: "c3", body: <>
      <B id="underline"><span className="s-u">Cut</span></B>
      <B id="emphasis"><span className="s-emph">Emphasis</span></B>
      <B id="shrink"><span className="s-big">A</span><span className="s-small">a</span></B>
      <span className="rm-split2">
        <B id="highlight"><span className="rm-sw" /><span>Highlight</span></B>
        <button type="button" className="rm-b rm-menubtn rm-car" data-tip="Highlighter colour" aria-label="Highlighter colour" aria-expanded={menu?.id === "hl"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("hl", e)}>▾</button>
      </span>
      <B id="clear">Clear</B>
      <span className="rm-split2">
        <B id="condense" cls="rm-i">{I.condense}</B>
        <B id="condense-omitted" cls="rm-i">{I.pilcrow}</B>
      </span>
    </>,
    mini: <>
      <B id="underline"><span className="s-u">Cut</span></B>
      <B id="emphasis"><span className="s-emph">Emphasis</span></B>
      <B id="highlight"><span className="rm-sw" /><span className="lbl">Highlight</span></B>
    </> },
    { id: "card", name: "Card", sub: "new card, send, reference, clean up, reformat, extension", cols: "c3", body: <>
      <B id="new-card" cls="rm-i">{I.plus}</B>
      <span className="rm-split2">
        <B id="send" cls="send"><span className="rm-sendic">{I.send}</span><span>Send</span></B>
        <B id="answer" cls="rm-i">{I.answer}</B>
      </span>
      <B id="reference"><span className="s-ref">Reference</span></B>
      <B id="clean-up">Clean up</B>
      <B id="reformat"><span className="s-reformat">Reformat</span></B>
      <B id="new-extension"><span className="s-tag">Extension</span></B>
    </>,
    mini: <>
      <B id="send" cls="send"><span className="rm-sendic">{I.send}</span><span className="lbl">Send</span></B>
      <B id="reformat"><span className="s-reformat">Reformat</span></B>
    </> },
    { id: "move", name: "Move", sub: "move up and down, undo, redo", cols: "c2", body: <>
      <B id="move-up" cls="rm-i">{I.up}</B>
      <B id="undo" cls="rm-i" label="Undo · Ctrl+Z">{I.undo}</B>
      <B id="move-down" cls="rm-i">{I.dn}</B>
      <B id="redo" cls="rm-i" label="Redo · Ctrl+Y">{I.redo}</B>
    </>,
    mini: <>
      <B id="undo" cls="rm-i" label="Undo · Ctrl+Z">{I.undo}</B>
      <B id="redo" cls="rm-i" label="Redo · Ctrl+Y">{I.redo}</B>
    </> },
    { id: "view", name: "View", sub: "pages, and more", cols: "c1", body: <>
      <button type="button" className={"rm-b rm-menubtn" + (menu?.id === "pages" || many ? " on" : "")} data-tip="Pages — the read view beside you, two places in a file, another file beside" aria-expanded={menu?.id === "pages"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("pages", e)}>{I.pages}<span>Pages</span><span className="rm-carr">▾</span></button>
      <button type="button" className="rm-b rm-menubtn" data-tip="More — the library, pop-outs, this file" aria-expanded={menu?.id === "more"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("more", e)}>More<span className="rm-carr">▾</span></button>
    </>,
    mini: <>
      <button type="button" className={"rm-b rm-menubtn" + (menu?.id === "pages" || many ? " on" : "")} data-tip="Pages — the read view beside you, two places in a file, another file beside" aria-expanded={menu?.id === "pages"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("pages", e)}>{I.pages}<span className="lbl">Pages</span><span className="rm-carr">▾</span></button>
    </> },
  ];
  const openGroup = menu?.id.startsWith("g:") ? ribbon.find((g) => "g:" + g.id === menu.id) || null : null;

  return (
    <div className={"rm" + (side ? "" : " side-hidden") + (full ? " full" : "") + (ribSmall ? " ribmin" : "") + (menu ? " menuopen" : "") + (drawer ? " drawer" : "")} ref={root} data-mode={mode} data-palette={palette} data-layout={layoutMode} data-tab={tab} data-heads={headsOf} data-spot={spot ? "open" : undefined}
      style={{ ["--rm-hl" as string]: hl, ["--rm-speech" as string]: `${Math.round(speechW * 1000) / 10}%`, ["--rm-speech-h" as string]: `${Math.round(speechH * 1000) / 10}%`, ["--rm-side" as string]: `${sideW}px` }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); void openFile(f); } }}>

      {/* ------------------------------------------------------------ the ribbon */}
      <div className="rm-rib" role="toolbar" aria-label="Round Magic">
        <div className="rm-brand">
          <Link className="rm-back" href="/tools" title="Back to the tools" aria-label="Back to the tools">←</Link>
          <span className="rm-logo" aria-label="Round Magic">ROUND<br />MAGIC</span>
        </div>
        {ribbon.map((g) => {
          const shut = ribSmall || folded.includes(g.id);
          if (shut) return (
            <div key={g.id} className="rm-g rm-gmini">
              {g.mini}
              <button type="button" className={"rm-b rm-menubtn rm-gcar" + (menu?.id === "g:" + g.id ? " on" : "")} data-tip={`All of ${g.name}: ${g.sub}`} aria-label={`All of ${g.name}`}
                aria-expanded={menu?.id === "g:" + g.id} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("g:" + g.id, e, e.currentTarget.parentElement)}>▾</button>
            </div>
          );
          return (
            <div key={g.id} className={"rm-g " + g.cols}>
              {g.body}
              <button type="button" className="rm-gfold" onMouseDown={(e) => e.preventDefault()} onClick={() => setFolded((f) => [...f.filter((x) => x !== g.id), g.id])}
                aria-label={`Fold ${g.name}`} title={`Fold ${g.name} into one button`}>{I.fold}</button>
            </div>
          );
        })}

        <div className="rm-spacer" />
        <div className="rm-titlebox">
          <div className="rm-trow">
            {mode === "speech" && <span className="rm-title rm-titlefix" title="The speech doc — SPLIT or EDIT for your files">Speech doc</span>}
            {curTheirs && mode !== "speech" && <span className="rm-badge" title="A doc of theirs — kept apart from your library">THEIRS</span>}
            <input className="rm-title" hidden={mode === "speech"} value={name} onChange={(e) => setName(e.target.value)} aria-label="File name" spellCheck={false}
              onBlur={(e) => void rename(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); view.current?.focus(); } if (e.key === "Escape") { setName(cur?.name || ""); view.current?.focus(); } }} />
            <span className="rm-meta">{state === "saved" ? "SAVED" : state === "saving" ? "SAVING…" : "EDITING"} · {docStat.cards} CARD{docStat.cards === 1 ? "" : "S"}</span>
          </div>
          <div className="rm-trow end">
            <div className="rm-modes" role="group" aria-label="View">
              <button type="button" aria-pressed={mode === "edit"} onClick={() => setMode("edit")} data-tip={"Just the file"}>EDIT</button>
              <button type="button" aria-pressed={mode === "split"} onClick={() => setMode("split")} data-tip={tip("mode-split", "The speech doc beside")} className={sentPulse && mode !== "split" && mode !== "speech" ? "pulse" : ""} key={"s" + sentPulse}>SPLIT</button>
              <button type="button" aria-pressed={mode === "speech"} onClick={() => setMode("speech")} data-tip={tip("mode-speech", "Just the speech doc")}>SPEECH</button>
              <button type="button" aria-pressed={mode === "read"} onClick={() => setMode("read")} data-tip={tip("mode-read", "Read it, timed")}>READ</button>
            </div>
            <button type="button" className={"rm-b rm-share rm-menubtn" + (cur?.share && !curTheirs ? " on" : "")} aria-expanded={menu?.id === "share"}
              data-tip={cur?.share ? "Shared — the link, and who is in it" : "Share this file: a link your partner opens to edit it with you"} aria-label="Share this file"
              onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("share", e)}>
              {I.share}<span>{cur?.share && !curTheirs ? (curShare?.mates.length ? `Shared · ${curShare.mates.length + 1}` : "Shared") : "Share"}</span>
            </button>
            <button type="button" className="rm-b rm-room" data-act="room" data-tip="Room — share the speech doc with your partner">
              <span className="dot" id="roomdot" /><span id="roomstate">Room</span>
            </button>
            <button type="button" className={"rm-b rm-i" + (timer.open ? " on" : "")} data-tip={tip("timer", "Speech timer")} aria-label="Speech timer" aria-pressed={timer.open} onClick={() => run("timer")}>{I.timer}</button>
            <button type="button" className={"rm-b rm-i rm-menubtn" + (menu?.id === "palette" ? " on" : "")} data-tip={"Colours and layout" + (K("layout") ? " · " + K("layout") + " next layout" : "")} aria-label="Colours and layout" aria-expanded={menu?.id === "palette"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("palette", e)}>
              <span className="rm-palsw" aria-hidden="true"><i /><i /></span>
            </button>
            <button type="button" className={"rm-b rm-i" + (full ? " on" : "")} data-tip={full ? "Leave full screen" : "Full screen — every key is yours"} aria-label="Full screen" onClick={toggleFull}>{I.full}</button>
            <button type="button" className="rm-b rm-i" data-tip={tip("ribbon", ribMin ? "Unfold the ribbon" : "Fold the ribbon to one line")} aria-label={ribMin ? "Unfold the ribbon" : "Fold the ribbon"} aria-pressed={ribMin} onClick={() => run("ribbon")}>{ribMin ? I.unfold : I.fold}</button>
          </div>
        </div>
        <input ref={fileIn} type="file" accept=".docx,.html,.htm,.txt,.pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void openFile(f); }} />
        <input ref={theirIn} type="file" accept=".docx,.pdf,.html,.htm,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void openTheirFile(f); }} />
      </div>

      <div className="rm-body">
        {/* ------------------------------------------------------------ the side */}
        <aside className="rm-side" aria-label="Sidebar">
          <div className="rm-shead" role="tablist">
            <button type="button" role="tab" className="rm-tabbtn" aria-selected={tab === "outline"} onClick={() => setTab("outline")}>OUTLINE</button>
            <button type="button" role="tab" className="rm-tabbtn" aria-selected={tab === "files"} onClick={() => setTab("files")}>FILES</button>
            <button type="button" role="tab" className="rm-tabbtn tb-search" aria-selected={tab === "search"} onClick={focusLibrary} title={tip("library")}>SEARCH</button>
            <button type="button" role="tab" className="rm-tabbtn" aria-selected={tab === "round"} onClick={() => setTab("round")}>ROUND</button>
            <span className="rm-grow" />
            <button type="button" className={"rm-sico" + (sideW > 420 ? " on" : "")} onClick={() => setSideW((w) => (w > 420 ? SIDE_W : SIDE_WIDE))} aria-label={sideW > 420 ? "Narrower" : "Wider"} title={sideW > 420 ? "Narrower — or drag the edge" : "Wider — or drag the edge"}>{I.wide}</button>
            <button type="button" className="rm-sico" onClick={() => setSide(false)} aria-label="Hide the side" title={tip("sidebar", "Hide the side")}>{I.x}</button>
          </div>

          {/* outline: of whatever the cursor is in */}
          <div className="rm-tabpane tp-outline" hidden={tab !== "outline"}>
            <div className="rm-depth" role="group" aria-label="Outline depth">
              {[1, 2, 3, 4].map((n) => (
                <button key={n} type="button" aria-pressed={depth === n} onClick={() => { setDepth(n); setOlFold({}); }} title={["Pockets", "Hats", "Blocks", "Tags"][n - 1]}>{n}</button>
              ))}
              <span className="rm-olof">{headsOf === "speech" ? "SPEECH DOC" : "THIS FILE"}</span>
            </div>
            <label className="rm-sfilter">{I.search}<input value={olFilter} onChange={(e) => setOlFilter(e.target.value)} placeholder="Filter headings" aria-label="Filter headings" spellCheck={false} /></label>
            <nav className={"rm-slist" + (drag !== null ? " dragging" : "")} aria-label="Outline"
              onDragOver={(e) => { if (drag !== null && e.target === e.currentTarget) { e.preventDefault(); const ok = dropTarget(drag, heads.length) !== null; setDropAt(ok ? heads.length : null); } }}
              onDrop={(e) => { e.preventDefault(); dropRow(); }}>
              {olRows.length ? olRows.map(({ h, i, key, kids, open }) => (
                <button key={i} type="button" draggable
                  className={`rm-ol k${h.level} r${h.level - olTop}` + (i === olAt ? " on" : "") + (drag === i ? " lifted" : "") + (dropAt === i ? " drop" : "") + (dropAt === heads.length && i === heads.length - 1 ? " drop-after" : "")}
                  style={{ ["--d" as string]: h.level - olTop }}
                  title={h.text}
                  aria-expanded={kids && !olQ ? open : undefined}
                  onClick={() => { const v = target(); if (v) goPos(v, h.pos); }}
                  onDoubleClick={() => { if (kids) olToggle(key, open); }}
                  onKeyDown={(e) => {
                    if (!kids || olQ) return;
                    if (e.key === "ArrowRight" && !open) { e.preventDefault(); olToggle(key, open); }
                    if (e.key === "ArrowLeft" && open) { e.preventDefault(); olToggle(key, open); }
                  }}
                  onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", h.text); }}
                  onDragOver={(e) => onRowDrag(e, i)}
                  onDragEnd={() => { setDrag(null); setDropAt(null); }}>
                  <span className={"tw" + (kids && !olQ ? (open ? " open" : " shut") : "")} aria-hidden="true"
                    onClick={kids && !olQ ? (e) => { e.stopPropagation(); olToggle(key, open); } : undefined}>
                    {kids && !olQ && <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 2l3 3-3 3" /></svg>}
                  </span>
                  <span className="lab">{h.text}</span>
                  {answered.has(("AT: " + headOf(h.text)).toLowerCase()) && <span className="ok" title="Answered: there are cards under its heading in the speech doc">✓</span>}
                  <span className="x" role="button" aria-label={`Delete “${h.text}” and everything under it`} title="Delete this, and everything under it — Ctrl+Z brings it back"
                    onClick={(e) => { e.stopPropagation(); removeSection(h.pos); }}>×</span>
                </button>
              )) : <p className="rm-sempty">{heads.length ? "No heading here says that." : `No headings yet. ${K("tag")} makes a line a tag, ${K("block")} a block.`}</p>}
            </nav>
            <div className="rm-sfoot">{headsOf === "speech" ? "The speech doc, as a list: " : ""}Drag a heading to move it, and everything under it; × takes it out. {K("move-up")} / {K("move-down")} move the one you&apos;re in.</div>
          </div>

          {/* your files */}
          <div className="rm-tabpane tp-files" hidden={tab !== "files"}>
            <label className="rm-sfilter">{I.search}
              <input ref={qIn} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search every file${K("find") ? " · " + K("find") : ""}`} spellCheck={false} aria-label="Search every file"
                onKeyDown={(e) => {
                  if (e.key === "Escape") { e.preventDefault(); if (q) setQ(""); else view.current?.focus(); }
                  if (e.key === "Enter" && results) {
                    e.preventDefault();
                    const c = results.cards[0], f = results.named[0];
                    if (c) void open(c.file.id, (v) => goTag(v, c.i)); else if (f) void open(f.id, (v) => v.focus());
                  }
                }} />
            </label>
            <div className="rm-fileacts">
              <button type="button" onClick={() => void create("Untitled file")} title={tip("new-file", "New file")}>+ NEW FILE</button>
              <button type="button" onClick={() => fileIn.current?.click()} disabled={busy}>{busy ? "OPENING…" : "OPEN .DOCX"}</button>
            </div>
            <div className="rm-slist">
              {results ? (
                <>
                  {results.named.map((f) => (
                    <button key={"f" + f.id} type="button" className="rm-frow" aria-current={cur?.id === f.id} onClick={() => void open(f.id, (v) => v.focus())}>
                      <b>{f.name}</b><small>FILE · {f.cards.length} CARDS</small>
                    </button>
                  ))}
                  {results.cards.map((c) => (
                    <button key={c.key} type="button" className="rm-hit" onClick={() => void open(c.file.id, (v) => goTag(v, c.i))}>
                      <b>{c.tag}</b>
                      {c.cite && <span>{c.cite}</span>}
                      <small>{c.block ? c.block + " · " : ""}{c.file.name}</small>
                    </button>
                  ))}
                  {!results.named.length && !results.cards.length && <p className="rm-sempty">Nothing in your files says that. SEARCH looks in the whole library and the caselist.</p>}
                </>
              ) : (
                files.map((f) => (
                  <div key={f.id} className={"rm-frow" + (renaming === f.id ? " renaming" : "")} aria-current={cur?.id === f.id}>
                    {renaming === f.id ? (
                      <input className="rm-rename" defaultValue={f.name} autoFocus spellCheck={false} aria-label={`New name for ${f.name}`}
                        onFocus={(e) => e.currentTarget.select()}
                        onBlur={(e) => void renameFile(f.id, e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
                          if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
                        }} />
                    ) : (
                      <button type="button" className="rm-fopen"
                        onClick={() => { if (cur?.id !== f.id) void open(f.id, (v) => { if (!renamingRef.current) v.focus(); }); }}
                        onDoubleClick={(e) => { e.preventDefault(); setRenaming(f.id); }} title="Open · double-click to rename">
                        <b>{f.name}</b>
                        <small>{f.cards.length} CARD{f.cards.length === 1 ? "" : "S"} · {when(f.updated).toUpperCase()}{f.share && <i className="rm-shared"> · SHARED</i>}</small>
                      </button>
                    )}
                    {renaming !== f.id && (
                      <span className="rm-facts">
                        <button type="button" onClick={() => setRenaming(f.id)} aria-label={`Rename ${f.name}`} title="Rename">✎</button>
                        <button type="button" onClick={() => void download(f.id)} aria-label={`Download ${f.name} as a .docx`} title="Download as a .docx">↓</button>
                        <button type="button" className="del" onClick={() => void remove(f.id)} aria-label={`Delete ${f.name}`} title="Delete">×</button>
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="rm-sfoot">Every file is in the library search too, kept up to date as you cut.</div>
          </div>

          {/* the library: Evidence's search, drawn by its engine */}
          <div className={"rm-tabpane tp-search" + (cmdMode ? " cmdmode" : "")} hidden={tab !== "search"} onKeyDownCapture={onCmdKey}>
            {answering && (
              <div className="rm-ansbar">
                <div className="row">
                  <span className="lab">{answering.claim ? "ANSWERING" : "SENDING UNDER"}</span>
                  <span className="rm-grow" />
                  {answering.claim && <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => run("answer")} title={tip("answer", "Their next tag")}>NEXT ›</button>}
                  <button type="button" onClick={() => setAnswering(null)} aria-label="Stop answering" title="Stop: the search looks for what you type, and cards go to the end of the speech doc">×</button>
                </div>
                <b title={answering.claim || answering.head}>{answering.claim || answering.head}</b>
                <small><kbd>Enter</kbd> puts a card under <i>{answering.head}</i> in the speech doc{answering.claim ? " · the cards that answer it come first" : ""}</small>
              </div>
            )}
            <div className="evi rm-evsearch">
              <div className="srcsw mono" id="srcsw" role="group" aria-label="Search in">
                <button type="button" data-src="lib" className="on" aria-pressed="true">Library</button>
                <button type="button" data-src="cl" aria-pressed="false">Caselist</button>
              </div>
              <div className="searchwrap">
                <span className="slash">/</span>
                <input id="q" type="text" placeholder="search the library" autoComplete="off" spellCheck={false} />
                <span className="searchmeta mono" id="searchmeta" />
              </div>
              {cmdHits.length > 0 && (
                <div className="rm-cmds" role="listbox" aria-label="Commands">
                  {!cmdMode && <div className="rm-cmdh">COMMANDS <span>type &gt; for all of them</span></div>}
                  {cmdHits.map((c, n) => (
                    <button key={c.id} type="button" role="option" aria-selected={cmdMode && n === cmdSel} className="rm-cmd"
                      onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(c)}>
                      <span>{c.label}</span>{c.key && <kbd>{c.key}</kbd>}
                    </button>
                  ))}
                </div>
              )}
              {cmdMode && !cmdHits.length && <p className="rm-sempty">No command called that.</p>}
              <div className="binbar" id="binbar" hidden />
              <div id="results" />
            </div>
            <div className="rm-sfoot rm-sfoot1" title={"Click a card to send it; click a block to open it. ↑↓ move, → opens a block, ← folds it." + (!answering && K("answer") ? " " + K("answer") + " on a tag of theirs starts answering it." : "")}>
              <b>Click</b> or <b>Enter</b> {answering ? "puts it under what you're answering" : "sends a card"} · <b>Shift+Enter</b> into your file · <b>Ctrl+Enter</b> opens it
            </div>
          </div>

          {/* the round: their docs, SpeechDrop, your partner */}
          <div className="rm-tabpane tp-round" hidden={tab !== "round"}>
            <div className="rm-rsec">
              <div className="rm-cap">SPEECHDROP</div>
              <form className="rm-sdform" onSubmit={(e) => { e.preventDefault(); void listSd(sdCode); }}>
                <input value={sdCode} onChange={(e) => setSdCode(e.target.value)} placeholder="Room code or link" spellCheck={false} aria-label="SpeechDrop room" />
                <button type="submit" disabled={!sdCode.trim() || !!sdState?.loading}>{sdState?.loading ? "…" : "LOOK"}</button>
              </form>
              {sdState?.err && <p className="rm-sempty bad">{sdState.err}</p>}
              {sdState?.files && (
                <div className="rm-sdlist">
                  {sdState.files.length ? sdState.files.map((f) => (
                    <button key={f.i} type="button" className="rm-hit" onClick={() => void openSd(f)} disabled={busy}>
                      <b>{f.name}</b><small>{f.ctime ? when(f.ctime).toUpperCase() : ""} · OPENS AS THEIRS</small>
                    </button>
                  )) : <p className="rm-sempty">Nothing in room {sdState.code} yet.</p>}
                  <button type="button" className="rm-linkbtn" onClick={() => void listSd(sdState.code)}>↻ Look again</button>
                </div>
              )}
            </div>
            <div className="rm-rsec">
              <div className="rm-cap">THEIR DOCS</div>
              <div className="rm-fileacts">
                <button type="button" onClick={() => theirIn.current?.click()}>OPEN THEIRS</button>
                <button type="button" onClick={() => setPasting((p) => !p)} aria-pressed={pasting}>PASTE A DOC</button>
              </div>
              {pasting && (
                <div className="rm-paste" contentEditable suppressContentEditableWarning onPaste={onTheirPaste} tabIndex={0}
                  ref={(el) => { if (el) el.focus(); }} onKeyDown={(e) => { if (e.key === "Escape") setPasting(false); else if (!(e.ctrlKey || e.metaKey)) e.preventDefault(); }}>
                  Ctrl+V a Google Doc or web page here
                </div>
              )}
              <div className="rm-slist flat">
                {theirs.map((m) => (
                  <div key={m.id} className="rm-frow" aria-current={cur?.id === THEIRS + m.id}>
                    <button type="button" className="rm-fopen" onClick={() => void open(THEIRS + m.id, (v) => v.focus())}>
                      <b>{m.name}</b>
                      <small>{(SOURCE[m.source] || m.source).toUpperCase()}{m.by ? " · " + m.by.toUpperCase() : ""} · {when(m.at).toUpperCase()}</small>
                    </button>
                    <span className="rm-facts">
                      <button type="button" className="del" onClick={() => void forgetTheirs(m)} aria-label={`Forget ${m.name}`} title="Forget it">×</button>
                    </span>
                  </div>
                ))}
                {!theirs.length && <p className="rm-sempty">Their speech docs open here — off SpeechDrop, from a .docx or PDF, or pasted. Each opens in the editor to rehighlight and send from, and never goes in your library.</p>}
              </div>
            </div>
            <div className="rm-rsec">
              <div className="rm-cap">YOUR PARTNER</div>
              <p className="rm-sempty">Room, top right, puts you and your partner in one speech doc: you both write it, and every card either of you sends lands in it.</p>
            </div>
          </div>
        </aside>

        {focusLayout && <div className="rm-hot" aria-hidden="true" onPointerEnter={() => { setSide(true); setDrawer(true); }} />}
        {side && <div className="rm-sgrab" role="separator" aria-orientation="vertical" aria-label="Resize the side" onPointerDown={dragSide}
          onDoubleClick={() => setSideW((w) => (w > 420 ? SIDE_W : SIDE_WIDE))} title="Drag to widen the side · double-click: wide or narrow" />}
        {/* ------------------------------------------------------------ the work */}
        <div className="rm-main" onPointerDown={() => { if (drawer) setDrawer(false); }}>
          {!side && !focusLayout && <button type="button" className="rm-showside" onClick={() => setSide(true)} aria-label="Show the side" title={tip("sidebar", "Show the side")}>{I.menu}</button>}
          {layoutMode === "deck" && (
            <div className="rm-deck" role="tablist" aria-label="Open pages">
              {deckTabs.map((t) => (
                <div key={t.id} className={"rm-dtab" + (deckNow === t.id ? " on" : "") + (isTheirs(t.id) ? " theirs" : "")} role="tab" aria-selected={deckNow === t.id}
                  onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); deckClose(t.id); } }} onClick={() => deckOpen(t.id)} title={t.name}>
                  {isTheirs(t.id) && <i>THEIRS</i>}<span>{t.name || "Untitled"}</span>
                  <button type="button" aria-label={`Close ${t.name}`} title="Close the tab (the file stays in Files)" onClick={(e) => { e.stopPropagation(); deckClose(t.id); }}>×</button>
                </div>
              ))}
              <div key={"speech" + sentPulse} className={"rm-dtab speech" + (deckNow === "speech" ? " on" : "") + (sentPulse ? " got" : "")} role="tab" aria-selected={deckNow === "speech"} onClick={() => deckOpen("speech")} title="The speech doc">
                <b>★</b><span>Speech doc</span>
              </div>
              <button type="button" className="rm-dnew" onClick={() => setTab("files")} title="Open another file — it gets a tab" aria-label="Open another file">+</button>
              <span className="rm-grow" />
              <span className="rm-dkeys">{K("tab-prev") && K("tab-next") ? `${K("tab-prev")} / ${K("tab-next")}` : ""}</span>
            </div>
          )}
          {layoutMode === "spotlight" && !spot && (
            <button type="button" className="rm-spothint" onClick={() => run("command")}>
              <b>{K("command") || "/"}</b> cards and commands · <b>&gt;</b> for every command
            </button>
          )}
          <div className="rm-work" ref={workBox}>
            {layoutMode === "board" && mode === "split" && <svg className="rm-wires" ref={wires} aria-hidden="true" />}
            <div className="rm-panes" ref={panesBox}>
              {panes.map((p, i) => {
                const v = views.current.get(p.key);
                const words = p.read && v ? readWords(v.state.doc) : 0;
                const theirsHere = isTheirs(p.fileId);
                const meta = theirsHere ? theirFor(p.fileId) : null;
                const live = shares.current.get(p.fileId) || null;
                const showHead = many || p.read || theirsHere || mode === "split" || !!live;
                const pdf = pdfs[p.fileId];
                return (
                  <Fragment key={p.key}>
                  {i > 0 && <div className="rm-psplit" role="separator" aria-orientation="vertical" aria-label="Resize the pages"
                    onPointerDown={(e) => dragSplit(e, i - 1)} onDoubleClick={() => setWidths(panes.map(() => 1))} title="Drag to resize · double-click for equal widths" />}
                  <section className={"rm-pane" + (p.key === activeKey && many ? " active" : "") + (p.read ? " read" : "") + (theirsHere ? " theirs" : "")}
                    style={{ flex: `${widths[i] ?? 1} 1 0` }}
                    onPointerDown={() => { if (!p.read) activate(p.key); }}>
                    {showHead && (
                      <div className="rm-phead">
                        <span className={theirsHere ? "rm-acc2" : "rm-acc"}>{theirsHere ? (meta?.source === "library" || meta?.source === "caselist" ? "CARD" : "THEIRS") : p.read ? "READ" : "FILE"}</span>
                        <select className="rm-psel" value={p.fileId} onChange={(e) => void setPaneFile(p.key, e.target.value)} aria-label="What this page shows">
                          <optgroup label="Your files">{files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</optgroup>
                          {!!theirs.length && <optgroup label="Their docs">{theirs.map((m) => <option key={m.id} value={THEIRS + m.id}>{m.name}</option>)}</optgroup>}
                        </select>
                        {meta && <span className="rm-pmeta">{(SOURCE[meta.source] || meta.source).toUpperCase()}{meta.by ? " · " + meta.by.toUpperCase() : ""}</span>}
                        {live && (
                          <span className="rm-mates" title={live.mates.length ? "In it with you: " + live.mates.map((m) => m.name).join(", ") : live.status === "error" ? "Not connected — your edits are kept and go when it is" : "Shared — nobody else is in it right now"}>
                            <span className={"rm-live " + live.status} />
                            {live.mates.slice(0, 4).map((m) => <i key={m.client} style={{ background: m.color }}>{(m.name[0] || "?").toUpperCase()}</i>)}
                            {!live.mates.length && <em>SHARED</em>}
                          </span>
                        )}
                        {!pdf && (
                          <span className="rm-pmode" role="group" aria-label="Edit or read">
                            <button type="button" aria-pressed={!p.read} onClick={() => setPaneRead(p.key, false)}>EDIT</button>
                            <button type="button" aria-pressed={p.read} onClick={() => setPaneRead(p.key, true)}>VERBATIM</button>
                          </span>
                        )}
                        {!pdf && !p.read && (() => {
                          const on = !!v && isFolded(v.state);
                          return <button type="button" className={"rm-pbtn" + (on ? " on" : "")} aria-pressed={on} onMouseDown={(e) => e.preventDefault()}
                            onClick={() => { activate(p.key); toggleTags(views.current.get(p.key) || null); }} title={tip("tags-only", "Tags only: every card folded to its tag")}>TAGS</button>;
                        })()}
                        {p.read && <span className="rm-pmeta">{words} WORDS{words ? ` · ${readTime(words).toUpperCase()}` : ""}</span>}
                        {p.read && many && (
                          <button type="button" className={"rm-pbtn" + (p.follow ? " on" : "")} aria-pressed={p.follow}
                            onClick={() => setPanes(panesRef.current.map((x) => (x.key === p.key ? { ...x, follow: !x.follow } : x)))}
                            title="Following: this page keeps the card you're editing in view">{p.follow ? "● FOLLOWING" : "FOLLOW"}</button>
                        )}
                        <span className="rm-grow" />
                        {theirsHere && !pdf && !p.read && meta?.source !== "library" && meta?.source !== "caselist" && (
                          <button type="button" className="rm-pbtn acc" onMouseDown={(e) => e.preventDefault()}
                            onClick={() => { activate(p.key); views.current.get(p.key)?.focus(); run("answer"); }}
                            title={tip("answer", "Answer the tag the cursor is in (or what's selected): a heading for it in your speech doc, and the search looking for what answers it")}>ANSWER</button>
                        )}
                        {theirsHere && !pdf && <button type="button" className="rm-pbtn" onClick={() => void keepAsMine(p.fileId)} title="Copy it into a file of yours — and so into your library">KEEP AS MINE</button>}
                        {panes.length < MAX_PANES && (
                          <button type="button" className="rm-pbtn sq" onClick={() => addPane({ fileId: p.fileId, read: false, follow: true }, p.key)} title="Another page of this beside it" aria-label="Split this page">＋</button>
                        )}
                        {many && <button type="button" className="rm-pbtn sq" onClick={() => void closePane(p.key)} title="Close this page" aria-label="Close this page">×</button>}
                      </div>
                    )}
                    {p.key === activeKey && selCount && (
                      <div className="rm-selcount" role="status" aria-live="polite">
                        {selCount.words} WORD{selCount.words === 1 ? "" : "S"} · {selCount.read} TO READ{selCount.read ? ` · ${readTime(selCount.read).toUpperCase()}` : ""}
                      </div>
                    )}
                    {pdf && <iframe className="rm-pdf" src={pdf} title={loaded.current.get(p.fileId)?.name || "PDF"} />}
                    <div className="rm-scroll" hidden={!!pdf}>
                      <div className={"rm-col" + (p.read ? " verb" : "")}>
                        <div ref={mountFor(p.key)} />
                      </div>
                    </div>
                  </section>
                  </Fragment>
                );
              })}
            </div>

            <div className="rm-ssplit" role="separator" aria-orientation="vertical" aria-label="Resize the speech doc" onPointerDown={dragSpeech}
              onDoubleClick={() => { if (layoutMode === "stack") setSpeechH(.42); else setSpeechW(.46); }} title="Drag to resize · double-click to reset" />
            {/* the speech doc: Evidence's send doc, its editor, its outline */}
            <section className={"evi withdoc rm-speech" + (headsOf === "speech" && mode === "split" ? " active" : "")} ref={speechBox} aria-label="Speech doc">
              <div className="rm-phead speech">
                <span className="rm-acc">SPEECH</span>
                <b>Speech doc</b>
                <span className="rm-pmeta" id="sendCount" title="Blocks sent to it" />
                {answering && (
                  <button type="button" className="rm-pbtn on rm-under" onClick={() => setAnswering(null)}
                    title={`Cards you send land under “${answering.head}” — click to send to the end again`}>↳ {answering.head} ×</button>
                )}
                <span className="rm-grow" />
                <button type="button" className={"rm-pbtn" + (speechTags ? " on" : "")} aria-pressed={speechTags} onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggleTags(speechView.current)} title={tip("tags-only", "Tags only: every card folded to its tag, to see the doc as an outline and reorder it")}>TAGS ONLY</button>
                <button type="button" className={"rm-pbtn" + (side && tab === "outline" && headsOf === "speech" ? " on" : "")}
                  onClick={() => { inSpeech.current = true; setTab("outline"); speechView.current?.focus(); readHeads(); }}
                  title="Its outline, in the side: click a heading to go there, drag one to move it and everything under it">OUTLINE</button>
                <button type="button" className={"rm-pbtn rm-menubtn" + (menu?.id === "speech" ? " on" : "")} aria-expanded={menu?.id === "speech"}
                  onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("speech", e)} title="Format, copy, download, SpeechDrop, clear">DOC ▾</button>
                <button type="button" className="rm-pbtn" onClick={() => setMode(mode === "speech" ? "split" : "speech")} title={tip("mode-speech", mode === "speech" ? "A file beside it again" : "Just the speech doc")}>{mode === "speech" ? "FILE BESIDE" : "SPEECH ONLY"}</button>
                <button type="button" className="rm-pbtn sq" onClick={() => setMode("edit")} title="Close the speech doc — just the file" aria-label="Close the speech doc">×</button>
              </div>
              <div className="pane docpane rm-docpane">
                {/* the engine keeps a list of what was sent and draws it here; Round Magic's outline is the list now */}
                <div className="pane right docside shut" hidden>
                  <b id="doclabel" />
                  <div className="tabs mono">
                    <button data-tab="send" className="on">Send doc</button>
                    <button data-tab="read">Read doc</button>
                  </div>
                  <div className="sideacts" id="sideacts" />
                  <div id="sidebody" />
                </div>
                <div className="docmain">
                  <DocEditor host={root} width={Math.max(300, speechWidth)} owner={owner} onView={onSpeechView} onChange={onSpeechChange} compact plugins={speechPlugins} api={speechApi} />
                </div>
              </div>
            </section>
          </div>

          {mode === "read" && (
            <MagicRead doc={readDoc} source={readSrc} setSource={chooseReadSrc} hasSpeech={!!speechView.current || !!root.current?.querySelector("#docbody .ProseMirror")}
              wpm={wpm} setWpm={setWpm} hideDim={hideDim} setHideDim={setHideDim} onEdit={editAt} onExit={() => setMode("edit")} />
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------ the status line */}
      <footer className="rm-status">
        <span className="rm-crumb">{headsOf === "speech" ? "SPEECH DOC" : (cur?.name || "").toUpperCase()}{crumb ? " › " + crumb.toUpperCase() : ""}</span>
        <span className="rm-grow" />
        {docStat.cards > 0 && <span>CARD {Math.max(cardNo, 0)} / {docStat.cards}</span>}
        <span>{docStat.read.toLocaleString()} WORDS TO READ · <b className="rm-accent">{clock((docStat.read / Math.max(60, wpm)) * 60)}</b> AT {wpm}</span>
        <span className="evi rm-libstat" title="Your library"><span className="stat" id="stat" /></span>
      </footer>

      {/* ------------------------------------------------------------ the timer */}
      {timer.open && (
        <div className="rm-timer" role="region" aria-label="Speech timer">
          <div className="rm-trowt"><span className={"rm-clk" + (left < 0 ? " over" : left < 30 ? " near" : "")}>{left < 0 ? "+" : ""}{clock(Math.abs(left))}</span><span className="rm-lim">/ {clock(timer.limit)}</span></div>
          <div className="rm-tbar"><i style={{ width: `${Math.min(100, (ran / timer.limit) * 100)}%` }} /></div>
          <div className="rm-tbtns">
            <button type="button" className="pri" onClick={() => setTimer((t) => (t.since === null ? { ...t, since: Date.now() } : { ...t, ran: t.ran + (Date.now() - t.since) / 1000, since: null }))}>{timer.since === null ? (timer.ran ? "RESUME" : "START") : "PAUSE"}</button>
            <button type="button" onClick={() => setTimer((t) => ({ ...t, ran: 0, since: null }))}>RESET</button>
          </div>
          <select value={timer.limit} onChange={(e) => setTimer((t) => ({ ...t, limit: Number(e.target.value), ran: 0, since: null }))} aria-label="Speech length">
            {CLOCKS.map((c) => <option key={c.s} value={c.s}>{c.label}</option>)}
          </select>
          <button type="button" className="rm-tx" onClick={() => setTimer((t) => ({ ...t, open: false }))} aria-label="Close the timer">{I.x}</button>
        </div>
      )}

      {/* ------------------------------------------------------------ menus */}
      {openGroup && menu && (
        <div className="rm-menu rm-gpop" style={menuAt(menu)} role="menu">
          <h4><span>{openGroup.name.toUpperCase()}</span>
            {!ribMin && <button type="button" className="rm-linkbtn" onClick={() => { setFolded((f) => f.filter((x) => x !== openGroup.id)); setMenu(null); }}>UNFOLD INTO THE RIBBON</button>}
          </h4>
          <div className={"rm-g " + openGroup.cols}>{openGroup.body}</div>
        </div>
      )}
      {menu?.id === "palette" && (
        <div className="rm-menu wide pal" style={menuAt(menu)} role="menu">
          <h4>LAYOUT{K("layout") ? <span className="rm-h4k">{K("layout")} steps through them</span> : null}</h4>
          <div className="rm-lays">
            {LAYOUT_MODES.map((l) => (
              <button key={l.id} type="button" role="menuitemradio" aria-checked={layoutMode === l.id} className="rm-lay" onClick={() => setLayoutMode(l.id)} title={l.name + " — " + l.sub}>
                <svg viewBox="0 0 60 38" width="60" height="38" aria-hidden="true">
                  {l.pic.map(([x, y, w, h, k], n) => <rect key={n} x={x} y={y} width={w} height={h} className={"lp-" + k} />)}
                </svg>
                <b>{l.name}</b>
              </button>
            ))}
          </div>
          <div className="rm-laysub">{(LAYOUT_MODES.find((l) => l.id === layoutMode) || LAYOUT_MODES[0]).sub}</div>
          <h4>COLOURS</h4>
          <div className="rm-pals">
            {PALETTES.map((p) => (
              // the menu stays open: try one after another, and see each on the whole tool
              <button key={p.id} type="button" role="menuitemradio" aria-checked={palette === p.id} className="rm-mb lay" onClick={() => setPalette(p.id)}>
                <span className="rm-palpic" aria-hidden="true" style={{ background: p.chrome }}><i style={{ background: p.side }} /><i style={{ background: "#fff" }} /><b style={{ background: p.acc }} /></span>
                <span className="rm-lt"><b>{p.name}</b><small>{p.sub}</small></span>
                {palette === p.id && <span className="k">✓</span>}
              </button>
            ))}
          </div>
          <div className="rm-mnote">The page stays white, the way a cut file is read. Kept in this browser.</div>
        </div>
      )}
      {menu?.id === "share" && (
        <div className="rm-menu wide rm-sharemenu" style={menuAt(menu)} role="dialog" aria-label="Share">
          <h4>THIS FILE</h4>
          {!cur || curTheirs ? (
            <div className="rm-mnote">{cur ? "A doc of theirs is kept apart from your files — Keep as mine makes it one, and then it can be shared." : "Open a file to share it."}</div>
          ) : !cur.share ? (
            <>
              <div className="rm-mnote top">Share “{cur.name}” and it has a link. Whoever is signed in and opens the link is in the file with you: you both type in it at once, see each other&apos;s cursor, and it is there for each of you whether or not the other is.</div>
              <button type="button" className="rm-mb pri" disabled={busy} onClick={() => { void startShare(cur.id); }}>{busy ? "Sharing…" : "Share it, and copy the link"}</button>
            </>
          ) : (
            <>
              <label className="rm-linkrow">
                <input readOnly value={shareLink(cur.share)} onFocus={(e) => e.currentTarget.select()} aria-label="The link" spellCheck={false} />
                <button type="button" onClick={() => void copyLink(cur.share!)}>COPY</button>
              </label>
              <div className="rm-who">
                <span><i style={{ background: "var(--acc)" }}>{(me?.[0] || "Y").toUpperCase()}</i>You</span>
                {(curShare?.mates || []).map((m) => <span key={m.client}><i style={{ background: m.color }}>{(m.name[0] || "?").toUpperCase()}</i>{m.name}</span>)}
                {!curShare?.mates.length && <em>{curShare?.status === "error" ? "Not connected right now" : "Nobody else is in it right now"}</em>}
              </div>
              <div className="rm-mnote">Anyone signed in with the link can open and edit it. It saves by itself, for everyone.</div>
              {curShare?.mine
                ? <button type="button" className="rm-mb" onClick={() => { setMenu(null); if (window.confirm(`Stop sharing “${cur.name}”? The link stops working; everyone keeps the copy they have.`)) void unshare(cur.id, "stop"); }}>Stop sharing</button>
                : <button type="button" className="rm-mb" onClick={() => { setMenu(null); void unshare(cur.id, "leave"); }}>Leave it — keep a copy of my own</button>}
            </>
          )}
          <div className="rm-sep" />
          <h4>THE SPEECH DOC</h4>
          <button type="button" className="rm-mb" data-act="room" onClick={() => setMenu(null)}>Room — one speech doc for you and your partner…</button>
        </div>
      )}
      {menu?.id === "speech" && (
        <div className="rm-menu" style={menuAt(menu)} role="menu">
          <h4>THE SPEECH DOC</h4>
          <button type="button" className="rm-mb" data-act="format" onClick={() => setMenu(null)} title="Title it, drop the analytics, renumber, take out the white space">Format for sending…</button>
          <button type="button" className="rm-mb" data-act="copySend" onClick={() => setMenu(null)}>Copy it</button>
          <button type="button" className="rm-mb" onClick={() => { setMenu(null); speechApi.current?.saveDocx(); }}>Download as .docx</button>
          <button type="button" className="rm-mb" onClick={() => { setMenu(null); speechApi.current?.speechDrop(); }}>Send to SpeechDrop…</button>
          <div className="rm-sep" />
          <button type="button" className="rm-mb" data-act="docReset" onClick={() => setMenu(null)} title="Throw away what was written in it and build it again from the cards sent">Rebuild from the cards sent</button>
          <button type="button" className="rm-mb" data-act="clearSend" onClick={() => setMenu(null)}>Clear it</button>
          <div className="rm-mnote">It edits like any page: every ribbon button and key works in it — Reformat, Clean up, Condense, the headings, move up and down.</div>
        </div>
      )}
      {menu?.id === "hl" && (
        <div className="rm-menu" style={menuAt(menu)} role="menu">
          <h4>HIGHLIGHTER</h4>
          <div className="rm-swrow">
            {C.HIGHLIGHTS.map((h) => (
              <button key={h.color} type="button" style={{ background: h.color }} aria-pressed={hl === h.color} title={h.name} aria-label={h.name}
                onMouseDown={(e) => e.preventDefault()} onClick={() => { setHl(h.color); setMenu(null); target()?.focus(); }} />
            ))}
          </div>
          <div className="rm-mnote">{K("hl-next") && <>{K("hl-next")} steps through them. </>}Grey is for cards kept for reference.</div>
        </div>
      )}
      {menu?.id === "pages" && (
        <div className="rm-menu wide" style={menuAt(menu)} role="menu">
          <h4>PAGES</h4>
          {LAYOUTS.map((l) => {
            const k = "key" in l ? K(l.key) : "";
            return (
              <button key={l.id} type="button" role="menuitem" className="rm-mb lay" onClick={() => void layout(l.id)}>
                <span className="rm-pic" aria-hidden="true">{l.cols.map((c, n) => <i key={n} className={"c-" + c} />)}</span>
                <span className="rm-lt"><b>{l.name}</b><small>{l.sub}</small></span>
                {k && <span className="k">{k}</span>}
              </button>
            );
          })}
          <div className="rm-sep" />
          <button type="button" className="rm-mb" onClick={() => { setMenu(null); toggleVerb(); }}>{activeRead ? "Edit this page" : "Verbatimise this page"}<span className="k">{K("verbatim")}</span></button>
          <button type="button" className="rm-mb" onClick={() => { setMenu(null); setRefPick({ q: "", sel: 0 }); }}>Reference a card…<span className="k">{K("insert-reference")}</span></button>
        </div>
      )}
      {menu?.id === "more" && (
        <div className="rm-menu" style={menuAt(menu)} role="menu">
          <h4>LIBRARY</h4>
          <button type="button" className="rm-mb" data-act="import" onClick={() => setMenu(null)}>Import an evidence file…</button>
          <button type="button" className="rm-mb" data-act="case" onClick={() => setMenu(null)}>Your case…</button>
          <button type="button" className="rm-mb" data-act="export" onClick={() => setMenu(null)}>Export the library</button>
          <button type="button" className="rm-mb" data-act="settings" onClick={() => setMenu(null)}>Library settings</button>
          <div className="rm-sep" />
          <h4>POP OUT — A WINDOW THAT STAYS ON TOP</h4>
          <button type="button" className="rm-mb" onClick={() => { setMenu(null); if (!popOut("send")) toast("The browser blocked the window — allow pop-ups for this site"); }}>The speech doc</button>
          {curTheirs && cur && <button type="button" className="rm-mb" onClick={() => { setMenu(null); void flush().then(() => { if (!popOut("doc", { doc: cur.id.slice(THEIRS.length) })) toast("The browser blocked the window — allow pop-ups for this site"); }); }}>Their doc, “{cur.name}”</button>}
          <div className="rm-sep" />
          <h4>SPELLING{K("spelling") ? " · " + K("spelling") : ""}</h4>
          {SPELL_MODES.map((m) => (
            <button key={m.id} type="button" role="menuitemradio" aria-checked={spell === m.id} className="rm-mb" onClick={() => { setSpell(m.id); setMenu(null); }} title={m.sub}>
              {m.name}{spell === m.id && <span className="k">✓</span>}
            </button>
          ))}
          <div className="rm-mnote">Right-click a red underline for what it should be, or to add the word to the dictionary.</div>
          <div className="rm-sep" />
          <h4>THIS FILE</h4>
          <button type="button" className="rm-mb" onClick={() => { setMenu(null); run("clean-up"); }}>Clean up<span className="k">{K("clean-up")}</span></button>
          <button type="button" className="rm-mb" onClick={() => { setMenu(null); run("paste"); }}>Paste as text</button>
          <button type="button" className="rm-mb" onClick={() => { setMenu(null); run("page-break"); }}>Page break<span className="k">{K("page-break")}</span></button>
          <button type="button" className="rm-mb" onClick={() => { setMenu(null); void flush(true); }}>Save now<span className="k">{K("save")}</span></button>
        </div>
      )}

      {refPick && (
        <div className="rm-scrim top" onPointerDown={(e) => { if (e.target === e.currentTarget) { setRefPick(null); target()?.focus(); } }}>
          <div className="rm-refpick" role="dialog" aria-label="Reference a card">
            <input ref={refIn} value={refPick.q} placeholder="Find the card to reference — tag, cite, words…" spellCheck={false} aria-label="Find the card to reference"
              onChange={(e) => setRefPick({ q: e.target.value, sel: 0 })}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); setRefPick(null); target()?.focus(); }
                if (e.key === "ArrowDown") { e.preventDefault(); setRefPick((r) => r && { ...r, sel: Math.min(refHits.length - 1, r.sel + 1) }); }
                if (e.key === "ArrowUp") { e.preventDefault(); setRefPick((r) => r && { ...r, sel: Math.max(0, r.sel - 1) }); }
                if (e.key === "Enter") { e.preventDefault(); const h = refHits[refPick.sel]; if (h) void putReference(h); }
              }} />
            <ul>
              {refHits.map((h, n) => (
                <li key={h.key} className={n === refPick.sel ? "on" : ""} onPointerMove={() => { if (n !== refPick.sel) setRefPick({ ...refPick, sel: n }); }} onClick={() => void putReference(h)}>
                  <b>{h.tag}</b>
                  <small>{h.cite ? h.cite.slice(0, 70) + " · " : ""}{h.file.name}</small>
                </li>
              ))}
              {refPick.q.trim().length >= 2 && !refHits.length && <li className="none">No card in your files says that</li>}
              {refPick.q.trim().length < 2 && <li className="none">It goes in under the line you&apos;re on, with &lt;&lt;FOR REFERENCE---its author&gt;&gt; and its highlighting grey</li>}
            </ul>
          </div>
        </div>
      )}

      {keysOpen && (
        <div className="rm-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget && !listening) { setKeysOpen(false); view.current?.focus(); } }}>
          <div className="rm-modal" role="dialog" aria-label="Keys">
            <div className="rm-mhead">
              <h2>Keys</h2>
              <p>Click a key, then press the new one (two modifiers alone work too, like Ctrl+Alt: press them together and let go). Backspace leaves it with none; Esc keeps it. A key that does nothing may belong to an extension — Chrome gives it to the extension first, except in full screen.</p>
            </div>
            <label className="rm-citefmt">
              <span><b>Cite format</b><small>How Reformat writes the cites it rewrites. %author% %y% is the short cite (bold); %title%, %date%, %url%, %quals%, %publication%, %accessed% are the rest. A part a cite doesn&apos;t have is left out.</small></span>
              <input value={citeFormat} placeholder={DEFAULT_CITE_FORMAT} spellCheck={false}
                onChange={(e) => { setCiteFormat(e.target.value); try { localStorage.setItem(scoped("cutter.citefmt", owner), e.target.value); } catch { /* private */ } }} />
            </label>
            {keyNote && <p className="rm-keynote">{keyNote}</p>}
            <div className="rm-ktab">
              {groups.map((g) => (
                <section key={g}>
                  <h3>{g.toUpperCase()}</h3>
                  {ACTIONS.filter((a) => a.group === g).map((a) => (
                    <div key={a.id} className="rm-krow" title={a.hint}>
                      <span><b>{a.label}</b>{caveat(keyFor(keys, a.id)) && <small className="warn">{caveat(keyFor(keys, a.id))}</small>}</span>
                      <button type="button" className={"rm-kc" + (listening === a.id ? " wait" : "") + (a.id in keys ? " moved" : "")}
                        onClick={() => { setListening((l) => (l === a.id ? null : a.id)); setKeyNote(""); }}>
                        {listening === a.id ? "Press a key…" : K(a.id) || "none"}
                      </button>
                    </div>
                  ))}
                </section>
              ))}
            </div>
            <div className="rm-mfoot">
              <button type="button" onClick={() => { setKeys({}); saveKeys(owner, {}); setKeyNote("Every key is back to the defaults"); }}>RESET ALL</button>
              <button type="button" className="pri" onClick={() => { setKeysOpen(false); setListening(null); view.current?.focus(); }}>DONE</button>
            </div>
          </div>
        </div>
      )}

      {toastMsg && <div className="rm-toast" key={toastMsg.n} role="status">{toastMsg.t}</div>}

      {/* the library's own dialogs, its toast, and where it builds what it copies */}
      <div className="evi rm-evx">
        <div className="veil" id="veil"><div className="card" id="card" /></div>
        <div className="toast" id="toast" />
        <div id="clipstage" contentEditable suppressContentEditableWarning />
      </div>
    </div>
  );
}

function stripDoc(f: CutFile): CutMeta {
  const { doc: _d, html: _h, ...m } = f;
  return m;
}

