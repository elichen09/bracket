"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { DOMParser as PMParser, DOMSerializer, type Node as PMNode } from "prosemirror-model";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { undoCommand, redoCommand } from "y-prosemirror";
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
import { buildSearch, searchCards } from "@/lib/caselist/search.js";
import { openBus, type Bus } from "@/lib/toolsBus";
import { scoped } from "@/lib/owner";
import { useFullscreen } from "./FullBtn";
import { popOut } from "./PopBtn";
import DocEditor from "./DocEditor";
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
const countWords = (doc: PMNode) => (doc.textContent.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A doc of theirs, in a page: its id in the Doc viewer's store, marked so it is never mistaken for a file of yours. */
const THEIRS = "v:";
const isTheirs = (id: string) => id.startsWith(THEIRS);
const SOURCE: Record<string, string> = { room: "Partner", speechdrop: "SpeechDrop", file: "Opened", paste: "Pasted" };
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
type Mode = "edit" | "split" | "read";
type Tab = "outline" | "files" | "search" | "round";
interface SdFile { i: number; name: string; ctime: number }

const MAX_PANES = 3;
let paneSeq = 0;
const newKey = () => "p" + (++paneSeq) + "_" + Date.now().toString(36);

/** What only makes sense with the cursor in a document. */
const IN_DOC = new Set(["pocket", "hat", "block", "tag", "cite", "underline", "emphasis", "highlight", "clear", "shrink", "condense", "paste", "new-card", "move-up", "move-down", "new-extension", "analytic", "page-break", "clean-up", "reference", "insert-reference", "reformat", "send"]);
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
] as const;
type PaletteId = (typeof PALETTES)[number]["id"];
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
  timer: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2M9 2h6" /></svg>,
  full: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>,
  pages: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M12 4v16" /></svg>,
  search: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>,
  x: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  menu: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>,
  fold: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>,
  unfold: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>,
  wide: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M3 12h18" /></svg>,
};

export default function RoundMagic({ owner, me, room, sd }: { owner?: string; me?: string; room?: string; sd?: string }) {
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
  const refCbs = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const lastFollow = useRef(new Map<string, number>());
  /** The page being worked in. */
  const view = useRef<EditorView | null>(null);
  /** The speech doc's editor (DocEditor's), and whether it, not a page, has the cursor. */
  const speechView = useRef<EditorView | null>(null);
  const inSpeech = useRef(false);
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
  const [speechOutline, setSpeechOutline] = useState(false);
  const [speechWidth, setSpeechWidth] = useState(700);
  const [sentPulse, setSentPulse] = useState(0);
  const [readSrc, setReadSrc] = useState<"speech" | "file">("file");
  const [readDoc, setReadDoc] = useState<PMNode | null>(null);
  const [wpm, setWpm] = useState(230);
  const [hideDim, setHideDim] = useState(false);
  const [depth, setDepth] = useState(4);
  const [olFilter, setOlFilter] = useState("");
  const [menu, setMenu] = useState<null | { id: string; x: number; y: number }>(null);
  // the ribbon: folded to one line, or with some of its groups folded into a button each
  const [ribMin, setRibMin] = useState(false);
  const [folded, setFolded] = useState<string[]>([]);
  const [palette, setPalette] = useState<PaletteId>("graphite");
  const [sideW, setSideW] = useState(SIDE_W);

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
        if (u.mode === "split") { modeRef.current = "split"; setModeState("split"); }
        if (["outline", "files", "search", "round"].includes(u.tab)) setTabState(u.tab);
        if (typeof u.speechW === "number") setSpeechW(Math.min(.75, Math.max(.25, u.speechW)));
        if (typeof u.wpm === "number") setWpm(u.wpm);
        if (typeof u.hideDim === "boolean") setHideDim(u.hideDim);
        if (typeof u.speechOutline === "boolean") setSpeechOutline(u.speechOutline);
        if (typeof u.depth === "number") setDepth(u.depth);
        if (typeof u.limit === "number") setTimer((t) => ({ ...t, limit: u.limit }));
        if (typeof u.ribMin === "boolean") setRibMin(u.ribMin);
        if (Array.isArray(u.folded)) setFolded(u.folded.filter((x: unknown) => typeof x === "string"));
        if (PALETTES.some((p) => p.id === u.palette)) setPalette(u.palette);
        if (typeof u.sideW === "number") setSideW(Math.min(760, Math.max(220, u.sideW)));
      }
    } catch { /* first time */ }
  }, [owner]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem(scoped("cutter.hl", owner), hl); } catch { /* private */ } }, [hl, owner]);
  useEffect(() => {
    try { localStorage.setItem(UI_KEY, JSON.stringify({ mode: mode === "read" ? "edit" : mode, tab, speechW, wpm, hideDim, speechOutline, depth, limit: timer.limit, ribMin, folded, palette, sideW })); } catch { /* private */ }
  }, [mode, tab, speechW, wpm, hideDim, speechOutline, depth, timer.limit, ribMin, folded, palette, sideW, UI_KEY]);

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
  const target = () => (inSpeech.current && speechView.current && modeRef.current === "split" ? speechView.current : view.current);

  const makeState = useCallback((doc: PMNode, read: boolean) => EditorState.create({
    doc,
    plugins: [
      history(),
      keymap({
        "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo,
        "Mod-b": toggleMark(schema.marks.strong), "Mod-i": toggleMark(schema.marks.em), "Mod-u": toggleMark(schema.marks.underline),
        Enter: X.enterKeepingAnalytics,
      }),
      keymap(baseKeymap),
      verbatimPlugin(read),
    ],
  }), []);

  // ---- the outline and the status line follow whatever has the cursor --------------------
  const readHeads = useCallback(() => {
    const v = target();
    if (!v) return;
    setHeadsOf(v === speechView.current ? "speech" : "page");
    const { from: sf, to: st, empty } = v.state.selection;
    const c = empty ? null : countIn(v.state.doc, sf, st);
    setSelCount(c && c.words ? c : null);
    const out: Head[] = [];
    let cards = 0;
    v.state.doc.forEach((n, pos) => { if (n.type === schema.nodes.heading) { out.push({ level: n.attrs.level, text: n.textContent.trim() || "(empty)", pos }); if (n.attrs.level === 4) cards++; } });
    setHeads(out);
    setDocStat({ read: readWords(v.state.doc), cards });
    const from = v.state.selection.from;
    let i = -1;
    out.forEach((h, k) => { if (h.pos <= from) i = k; });
    setAt(i);
  }, []);
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
          const next: CutFile = { ...base, doc: doc.toJSON(), html: toHtml(doc), cards: C.briefs(doc), words: countWords(doc), updated: Date.now() };
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
      for (const [k, w] of views.current) {
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
    if (!doc || !rec) {
      const f = isTheirs(fid) ? await theirRecord(fid) : await getFile(owner, fid);
      if (!f) { toast("That one is gone"); return; }
      if (!rec) { rec = f; loaded.current.set(fid, f); }
      if (!doc) doc = docOf(f);
    }
    if (!views.current.has(key)) return;
    v.updateState(makeState(doc, isRead(key)));
    viewFile.current.set(key, fid);
    lastFollow.current.delete(key);
    if (key === activeRef.current) {
      syncActive();
      try { localStorage.setItem(scoped("cutter.last", owner), fid); } catch { /* private */ }
    }
    setTick((n) => n + 1);
    if (then) requestAnimationFrame(() => then(v));
  }, [owner, flush, makeState, syncActive, theirRecord, toast]);

  const fns = useRef({ onTr, loadInto, activate, jumpFromRead });
  fns.current = { onTr, loadInto, activate, jumpFromRead };
  const mountFor = useCallback((key: string) => {
    let cb = refCbs.current.get(key);
    if (cb) return cb;
    cb = (el: HTMLDivElement | null) => {
      if (el) {
        if (views.current.has(key)) return;
        const v = new EditorView({ mount: el }, {
          state: EditorState.create({ schema }),
          attributes: { class: "ct-sheet", spellcheck: "false" },
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
        viewFile.current.delete(key);
        lastFollow.current.delete(key);
        refCbs.current.delete(key);
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
  const newFile = useCallback(async (fileName: string, html = "<h4></h4><p></p>") => {
    const doc = fromHtml(html);
    const f: CutFile = {
      id: newFileId(), name: fileName, doc: doc.toJSON(), html: toHtml(doc),
      cards: C.briefs(doc), words: countWords(doc), created: Date.now(), updated: Date.now(),
    };
    await putFile(owner, f);
    loaded.current.set(f.id, f);
    setFiles((l) => [stripDoc(f), ...l]);
    bus.current?.post({ kind: "cutter-changed", id: f.id });
    return f;
  }, [owner, setFiles]);

  const open = useCallback(async (id: string, then?: (v: EditorView) => void) => {
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

  const rename = useCallback(async (n: string) => {
    const fid = viewFile.current.get(activeRef.current);
    const f = fid ? loaded.current.get(fid) : null;
    const clean = n.replace(/\s+/g, " ").trim();
    if (!f || !fid || !clean || clean === f.name) { setName(f?.name || ""); return; }
    loaded.current.set(fid, { ...f, name: clean });
    setName(clean);
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

  // ---- docs of theirs ------------------------------------------------------------
  /** Keep a doc of theirs and open it in the page being worked in. */
  const openTheirs = useCallback(async (d: ViewDoc) => {
    await keepDoc(owner, d);
    void refreshTheirs();
    loaded.current.delete(THEIRS + d.id);
    await open(THEIRS + d.id, (v) => { v.focus(); v.dispatch(v.state.tr.setSelection(TextSelection.atStart(v.state.doc))); });
    if (modeRef.current === "read") { modeRef.current = "edit"; setModeState("edit"); }
  }, [owner, refreshTheirs, open]);

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
  const setMode = useCallback((m: Mode) => {
    if (m === "read") {
      const prefer = modeRef.current === "split" && inSpeech.current ? "speech" : readSrc;
      const d = prefer === "speech" ? speechDoc() : view.current?.state.doc || null;
      setReadSrc(prefer);
      setReadDoc(d);
    }
    modeRef.current = m;
    setModeState(m);
    if (m !== "split") inSpeech.current = false;
    requestAnimationFrame(() => {
      if (m === "split") (window as any).EV?.renderDoc?.();
      if (m !== "read") view.current?.focus();
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
    setMode(speech ? "split" : "edit");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const v = speech ? speechView.current : view.current;
      if (!v) return;
      if (speech) inSpeech.current = true;
      goPos(v, pos);
    }));
  }, [readSrc, setMode, goPos]);

  // ---- sending a card to the speech doc ---------------------------------------
  const sendCard = useCallback(async () => {
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
  }, [toast]);

  // the library search's sends, too: the Split button says where they went
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const on = () => setSentPulse((n) => n + 1);
    el.addEventListener("evi:sent", on);
    return () => el.removeEventListener("evi:sent", on);
  }, []);

  // ---- the commands ---------------------------------------------------------
  const toggleVerb = useCallback(() => {
    const k = activeRef.current;
    if (k) setPaneRead(k, !isRead(k));
  }, [setPaneRead]);

  const focusLibrary = useCallback(() => {
    setTab("search");
    requestAnimationFrame(() => { const el = root.current?.querySelector("#q") as HTMLInputElement | null; el?.focus(); el?.select(); });
  }, [setTab]);

  const run = useCallback((id: string) => {
    if (id === "verbatim") { toggleVerb(); return; }
    if (id === "read-beside") { readBeside(); return; }
    if (id === "next-pane") { nextPane(); return; }
    if (id === "sidebar") { setSide((s) => !s); return; }
    if (id === "save") { void flush(true); return; }
    if (id === "find") { setTab("files"); requestAnimationFrame(() => { qIn.current?.focus(); qIn.current?.select(); }); return; }
    if (id === "library") { focusLibrary(); return; }
    if (id === "new-file") { void create("Untitled file"); return; }
    if (id === "mode-split") { setMode(modeRef.current === "split" ? "edit" : "split"); return; }
    if (id === "mode-read") { setMode(modeRef.current === "read" ? "edit" : "read"); return; }
    if (id === "timer") { setTimer((t) => ({ ...t, open: !t.open })); return; }
    if (id === "ribbon") { setMenu(null); setRibMin((r) => !r); return; }
    if (id === "send") { void sendCard(); return; }
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
  }, [flush, create, toast, toggleVerb, readBeside, nextPane, setTab, setMode, sendCard, focusLibrary]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const w = id === "pages" || id === "palette" ? 330 : id.startsWith("g:") ? 360 : 240;
    setMenu({ id, x: Math.min(window.innerWidth - w - 8, Math.max(8, r.left)), y: r.bottom + 6 });
  };

  // ---- searching every file ------------------------------------------------------
  const index = useMemo(() => {
    const blocks: string[] = [], bi = new Map<string, number>();
    const cards: unknown[][] = [], where: { file: number; i: number }[] = [];
    files.forEach((f, fi) => (f.cards || []).forEach((c) => {
      let b = -1;
      if (c.block) { b = bi.get(c.block) ?? -1; if (b < 0) { b = blocks.length; blocks.push(c.block); bi.set(c.block, b); } }
      cards.push([fi, c.tag, c.cite, 0, b < 0 ? undefined : b, c.read]);
      where.push({ file: fi, i: c.i });
    }));
    return { s: buildSearch(cards, blocks), cards, where };
  }, [files]);
  const results = useMemo(() => {
    const w = q.trim();
    if (w.length < 2) return null;
    const low = w.toLowerCase();
    const named = files.filter((f) => f.name.toLowerCase().includes(low));
    const { hits } = searchCards(index.s, w, (i: number) => String(index.cards[i][1] || ""));
    const cards = (hits as { i: number }[]).slice(0, 60).map((h) => {
      const c = index.cards[h.i], at = index.where[h.i], f = files[at.file];
      return { key: f.id + ":" + at.i, file: f, i: at.i, tag: String(c[1] || "(no tag)"), cite: String(c[2] || ""), block: f.cards.find((x) => x.i === at.i)?.block || "" };
    });
    return { named, cards };
  }, [q, files, index]);

  const refHits = useMemo(() => {
    if (!refPick) return [];
    const w = refPick.q.trim();
    if (w.length < 2) return [];
    const { hits } = searchCards(index.s, w, (i: number) => String(index.cards[i][1] || ""));
    return (hits as { i: number }[]).slice(0, 12).map((h) => {
      const c = index.cards[h.i], at = index.where[h.i], f = files[at.file];
      return { key: f.id + ":" + at.i, file: f, i: at.i, tag: String(c[1] || "(no tag)"), cite: String(c[2] || "") };
    });
  }, [refPick, index, files]);
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
    const left = body.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => setSideW(Math.round(Math.min(Math.min(760, window.innerWidth - 360), Math.max(220, ev.clientX - left))));
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
    const move = (ev: PointerEvent) => setSpeechW(Math.min(.75, Math.max(.25, (r.right - ev.clientX) / r.width)));
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
  const K = (id: string) => keyLabel(keyFor(keys, id));
  const tip = (id: string, label?: string) => `${label || ACTION.get(id)?.label || id}${K(id) ? " · " + K(id) : ""}`;
  const groups = useMemo(() => Array.from(new Set(ACTIONS.map((a) => a.group))), []);
  const activePane = panes.find((p) => p.key === activeKey) || null;
  const activeRead = !!activePane?.read;
  const many = panes.length > 1;
  const curTheirs = !!cur && isTheirs(cur.id);
  const theirFor = (fid: string) => theirMeta.current.get(fid);
  const olRows = heads.map((h, i) => ({ h, i })).filter(({ h }) => h.level <= depth && (!olFilter.trim() || h.text.toLowerCase().includes(olFilter.trim().toLowerCase())));
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
    { id: "cut", name: "Cut", sub: "cut, emphasis, shrink, highlight, clear, condense", cols: "c3", body: <>
      <B id="underline"><span className="s-u">Cut</span></B>
      <B id="emphasis"><span className="s-emph">Emphasis</span></B>
      <B id="shrink"><span className="s-big">A</span><span className="s-small">a</span></B>
      <span className="rm-split2">
        <B id="highlight"><span className="rm-sw" /><span>Highlight</span></B>
        <button type="button" className="rm-b rm-menubtn rm-car" data-tip="Highlighter colour" aria-label="Highlighter colour" aria-expanded={menu?.id === "hl"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("hl", e)}>▾</button>
      </span>
      <B id="clear">Clear</B>
      <B id="condense" cls="rm-i">{I.condense}</B>
    </>,
    mini: <>
      <B id="underline"><span className="s-u">Cut</span></B>
      <B id="emphasis"><span className="s-emph">Emphasis</span></B>
      <B id="highlight"><span className="rm-sw" /><span className="lbl">Highlight</span></B>
    </> },
    { id: "card", name: "Card", sub: "new card, send, reference, clean up, reformat, extension", cols: "c3", body: <>
      <B id="new-card" cls="rm-i">{I.plus}</B>
      <B id="send" cls="send"><span className="rm-sendic">{I.send}</span><span>Send</span></B>
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
    <div className={"rm" + (side ? "" : " side-hidden") + (full ? " full" : "") + (ribMin ? " ribmin" : "")} ref={root} data-mode={mode} data-palette={palette}
      style={{ ["--rm-hl" as string]: hl, ["--rm-speech" as string]: `${Math.round(speechW * 1000) / 10}%`, ["--rm-side" as string]: `${sideW}px` }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); void openFile(f); } }}>

      {/* ------------------------------------------------------------ the ribbon */}
      <div className="rm-rib" role="toolbar" aria-label="Round Magic">
        <div className="rm-brand">
          <Link className="rm-back" href="/tools" title="Back to the tools" aria-label="Back to the tools">←</Link>
          <span className="rm-logo" aria-label="Round Magic">ROUND<br />MAGIC</span>
        </div>
        {ribbon.map((g) => {
          const shut = ribMin || folded.includes(g.id);
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
            {curTheirs && <span className="rm-badge" title="A doc of theirs — kept apart from your library">THEIRS</span>}
            <input className="rm-title" value={name} onChange={(e) => setName(e.target.value)} aria-label="File name" spellCheck={false}
              onBlur={(e) => void rename(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); view.current?.focus(); } if (e.key === "Escape") { setName(cur?.name || ""); view.current?.focus(); } }} />
            <span className="rm-meta">{state === "saved" ? "SAVED" : state === "saving" ? "SAVING…" : "EDITING"} · {docStat.cards} CARD{docStat.cards === 1 ? "" : "S"}</span>
          </div>
          <div className="rm-trow end">
            <div className="rm-modes" role="group" aria-label="View">
              <button type="button" aria-pressed={mode === "edit"} onClick={() => setMode("edit")} data-tip={"Just the file"}>EDIT</button>
              <button type="button" aria-pressed={mode === "split"} onClick={() => setMode("split")} data-tip={tip("mode-split", "The speech doc beside")} className={sentPulse && mode !== "split" ? "pulse" : ""} key={"s" + sentPulse}>SPLIT</button>
              <button type="button" aria-pressed={mode === "read"} onClick={() => setMode("read")} data-tip={tip("mode-read", "Read it, timed")}>READ</button>
            </div>
            <button type="button" className="rm-b rm-room" data-act="room" data-tip="Room — share the speech doc with your partner">
              <span className="dot" id="roomdot" /><span id="roomstate">Room</span>
            </button>
            <button type="button" className={"rm-b rm-i" + (timer.open ? " on" : "")} data-tip={tip("timer", "Speech timer")} aria-label="Speech timer" aria-pressed={timer.open} onClick={() => run("timer")}>{I.timer}</button>
            <button type="button" className={"rm-b rm-i rm-menubtn" + (menu?.id === "palette" ? " on" : "")} data-tip="Colours" aria-label="Colours" aria-expanded={menu?.id === "palette"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("palette", e)}>
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
            <button type="button" role="tab" className="rm-tabbtn" aria-selected={tab === "search"} onClick={focusLibrary} title={tip("library")}>SEARCH</button>
            <button type="button" role="tab" className="rm-tabbtn" aria-selected={tab === "round"} onClick={() => setTab("round")}>ROUND</button>
            <span className="rm-grow" />
            <button type="button" className={"rm-sico" + (sideW > 420 ? " on" : "")} onClick={() => setSideW((w) => (w > 420 ? SIDE_W : SIDE_WIDE))} aria-label={sideW > 420 ? "Narrower" : "Wider"} title={sideW > 420 ? "Narrower — or drag the edge" : "Wider — or drag the edge"}>{I.wide}</button>
            <button type="button" className="rm-sico" onClick={() => setSide(false)} aria-label="Hide the side" title={tip("sidebar", "Hide the side")}>{I.x}</button>
          </div>

          {/* outline: of whatever the cursor is in */}
          <div className="rm-tabpane" hidden={tab !== "outline"}>
            <div className="rm-depth" role="group" aria-label="Outline depth">
              {[1, 2, 3, 4].map((n) => (
                <button key={n} type="button" aria-pressed={depth === n} onClick={() => setDepth(n)} title={["Pockets", "Hats", "Blocks", "Tags"][n - 1]}>{n}</button>
              ))}
              <span className="rm-olof">{headsOf === "speech" ? "SPEECH DOC" : "THIS FILE"}</span>
            </div>
            <label className="rm-sfilter">{I.search}<input value={olFilter} onChange={(e) => setOlFilter(e.target.value)} placeholder="Filter headings" aria-label="Filter headings" spellCheck={false} /></label>
            <nav className={"rm-slist" + (drag !== null ? " dragging" : "")} aria-label="Outline"
              onDragOver={(e) => { if (drag !== null && e.target === e.currentTarget) { e.preventDefault(); const ok = dropTarget(drag, heads.length) !== null; setDropAt(ok ? heads.length : null); } }}
              onDrop={(e) => { e.preventDefault(); dropRow(); }}>
              {olRows.length ? olRows.map(({ h, i }) => (
                <button key={i} type="button" draggable
                  className={`rm-ol k${h.level}` + (i === at ? " on" : "") + (drag === i ? " lifted" : "") + (dropAt === i ? " drop" : "") + (dropAt === heads.length && i === heads.length - 1 ? " drop-after" : "")}
                  style={{ ["--d" as string]: h.level - 1 }}
                  title="Click to go there · drag to move it, and everything under it"
                  onClick={() => { const v = target(); if (v) goPos(v, h.pos); }}
                  onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", h.text); }}
                  onDragOver={(e) => onRowDrag(e, i)}
                  onDragEnd={() => { setDrag(null); setDropAt(null); }}>
                  <span className="lab">{h.text}</span>
                </button>
              )) : <p className="rm-sempty">{heads.length ? "No heading here says that." : `No headings yet. ${K("tag")} makes a line a tag, ${K("block")} a block.`}</p>}
            </nav>
            <div className="rm-sfoot">Drag a heading to move it, and everything under it. {K("move-up")} / {K("move-down")} move the one you&apos;re in.</div>
          </div>

          {/* your files */}
          <div className="rm-tabpane" hidden={tab !== "files"}>
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
                        <small>{f.cards.length} CARD{f.cards.length === 1 ? "" : "S"} · {when(f.updated).toUpperCase()}</small>
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
          <div className="rm-tabpane" hidden={tab !== "search"}>
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
              <div className="binbar" id="binbar" hidden />
              <div className="indexhead mono">
                <i>Outline</i>
                <i className="c3"><button className="link" data-act="groups">Fold all</button></i>
              </div>
              <div id="results" />
            </div>
            <div className="rm-sfoot"><b>↑↓</b> move · <b>→</b> arguments · <b>Enter</b> send to the speech doc · <b>Esc</b> clear</div>
          </div>

          {/* the round: their docs, SpeechDrop, your partner */}
          <div className="rm-tabpane" hidden={tab !== "round"}>
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

        {side && <div className="rm-sgrab" role="separator" aria-orientation="vertical" aria-label="Resize the side" onPointerDown={dragSide}
          onDoubleClick={() => setSideW((w) => (w > 420 ? SIDE_W : SIDE_WIDE))} title="Drag to widen the side · double-click: wide or narrow" />}
        {/* ------------------------------------------------------------ the work */}
        <div className="rm-main">
          {!side && <button type="button" className="rm-showside" onClick={() => setSide(true)} aria-label="Show the side" title={tip("sidebar", "Show the side")}>{I.menu}</button>}
          <div className="rm-work" ref={workBox}>
            <div className="rm-panes" ref={panesBox}>
              {panes.map((p, i) => {
                const v = views.current.get(p.key);
                const words = p.read && v ? readWords(v.state.doc) : 0;
                const theirsHere = isTheirs(p.fileId);
                const meta = theirsHere ? theirFor(p.fileId) : null;
                const showHead = many || p.read || theirsHere || mode === "split";
                const pdf = pdfs[p.fileId];
                return [
                  i > 0 && <div key={"s" + p.key} className="rm-psplit" role="separator" aria-orientation="vertical" aria-label="Resize the pages"
                    onPointerDown={(e) => dragSplit(e, i - 1)} onDoubleClick={() => setWidths(panes.map(() => 1))} title="Drag to resize · double-click for equal widths" />,
                  <section key={p.key} className={"rm-pane" + (p.key === activeKey && many ? " active" : "") + (p.read ? " read" : "") + (theirsHere ? " theirs" : "")}
                    style={{ flex: `${widths[i] ?? 1} 1 0` }}
                    onPointerDown={() => { if (!p.read) activate(p.key); }}>
                    {showHead && (
                      <div className="rm-phead">
                        <span className={theirsHere ? "rm-acc2" : "rm-acc"}>{theirsHere ? "THEIRS" : p.read ? "READ" : "FILE"}</span>
                        <select className="rm-psel" value={p.fileId} onChange={(e) => void setPaneFile(p.key, e.target.value)} aria-label="What this page shows">
                          <optgroup label="Your files">{files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</optgroup>
                          {!!theirs.length && <optgroup label="Their docs">{theirs.map((m) => <option key={m.id} value={THEIRS + m.id}>{m.name}</option>)}</optgroup>}
                        </select>
                        {meta && <span className="rm-pmeta">{(SOURCE[meta.source] || meta.source).toUpperCase()}{meta.by ? " · " + meta.by.toUpperCase() : ""}</span>}
                        {!pdf && (
                          <span className="rm-pmode" role="group" aria-label="Edit or read">
                            <button type="button" aria-pressed={!p.read} onClick={() => setPaneRead(p.key, false)}>EDIT</button>
                            <button type="button" aria-pressed={p.read} onClick={() => setPaneRead(p.key, true)}>VERBATIM</button>
                          </span>
                        )}
                        {p.read && <span className="rm-pmeta">{words} WORDS{words ? ` · ${readTime(words).toUpperCase()}` : ""}</span>}
                        {p.read && many && (
                          <button type="button" className={"rm-pbtn" + (p.follow ? " on" : "")} aria-pressed={p.follow}
                            onClick={() => setPanes(panesRef.current.map((x) => (x.key === p.key ? { ...x, follow: !x.follow } : x)))}
                            title="Following: this page keeps the card you're editing in view">{p.follow ? "● FOLLOWING" : "FOLLOW"}</button>
                        )}
                        <span className="rm-grow" />
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
                  </section>,
                ];
              })}
            </div>

            <div className="rm-ssplit" role="separator" aria-orientation="vertical" aria-label="Resize the speech doc" onPointerDown={dragSpeech}
              onDoubleClick={() => setSpeechW(.46)} title="Drag to resize · double-click to reset" />
            {/* the speech doc: Evidence's send doc, its editor, its outline */}
            <section className="evi withdoc rm-speech" ref={speechBox} aria-label="Speech doc">
              <div className="rm-phead speech">
                <span className="rm-acc">SPEECH</span>
                <b id="doclabel">Send doc</b>
                <span className="rm-grow" />
                <button type="button" className={"rm-pbtn" + (speechOutline ? " on" : "")} aria-pressed={speechOutline} onClick={() => setSpeechOutline((o) => !o)} title="The speech doc's sent list and outline">LIST</button>
                <button type="button" className="rm-pbtn" onClick={() => setMode("edit")} title={tip("mode-split", "Just the file")}>CLOSE</button>
              </div>
              <div className="pane docpane rm-docpane">
                <div className={"pane right docside" + (speechOutline ? "" : " shut")}>
                  <button type="button" className="dsfold mono" onClick={() => setSpeechOutline((o) => !o)} aria-pressed={speechOutline}>{speechOutline ? "‹" : "›"}<span>Sent</span></button>
                  <div className="tabs mono">
                    <button data-tab="send" className="on">Send doc <span className="count" id="sendCount" /></button>
                    <button data-tab="read">Read doc</button>
                  </div>
                  <div className="sideacts" id="sideacts" />
                  <div id="sidebody" />
                </div>
                <div className="docmain">
                  <DocEditor host={root} width={Math.max(300, speechWidth)} owner={owner} onView={onSpeechView} onChange={onSpeechChange} compact />
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
        <div className="rm-menu rm-gpop" style={{ left: menu.x, top: menu.y }} role="menu">
          <h4><span>{openGroup.name.toUpperCase()}</span>
            {!ribMin && <button type="button" className="rm-linkbtn" onClick={() => { setFolded((f) => f.filter((x) => x !== openGroup.id)); setMenu(null); }}>UNFOLD INTO THE RIBBON</button>}
          </h4>
          <div className={"rm-g " + openGroup.cols}>{openGroup.body}</div>
        </div>
      )}
      {menu?.id === "palette" && (
        <div className="rm-menu wide" style={{ left: menu.x, top: menu.y }} role="menu">
          <h4>COLOURS</h4>
          {PALETTES.map((p) => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={palette === p.id} className="rm-mb lay" onClick={() => { setPalette(p.id); setMenu(null); }}>
              <span className="rm-palpic" aria-hidden="true" style={{ background: p.chrome }}><i style={{ background: p.side }} /><i style={{ background: "#fff" }} /><b style={{ background: p.acc }} /></span>
              <span className="rm-lt"><b>{p.name}</b><small>{p.sub}</small></span>
              {palette === p.id && <span className="k">✓</span>}
            </button>
          ))}
          <div className="rm-mnote">The page stays white, the way a cut file is read. Kept in this browser.</div>
        </div>
      )}
      {menu?.id === "hl" && (
        <div className="rm-menu" style={{ left: menu.x, top: menu.y }} role="menu">
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
        <div className="rm-menu wide" style={{ left: menu.x, top: menu.y }} role="menu">
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
        <div className="rm-menu" style={{ left: menu.x, top: menu.y }} role="menu">
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

