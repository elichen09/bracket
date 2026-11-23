"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { signOut as signOutOfCoda } from "@/lib/account";
import { checkUpdate, type Ready } from "@/lib/update";
import { isDesktop, apiBase, CODA_WEB, caselistLogin, setCaselistLogin, type CaselistLogin } from "@/lib/desktop";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { DOMParser as PMParser, DOMSerializer, Fragment as PMFragment, type Node as PMNode } from "prosemirror-model";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { undoCommand, redoCommand, ySyncPlugin, yCursorPlugin, yUndoPlugin, initProseMirrorDoc, prosemirrorToYXmlFragment } from "y-prosemirror";
import { openShare, createShare, stopShare, peekShare, shareLink, linkId, NotShared, type Shared } from "@/lib/cutter/share";
import { schema } from "@/lib/evidence/docSchema";
import { listFiles, getFile, putFile, dropFile, newFileId, type CutMeta, type CutFile } from "@/lib/cutter/store";
import * as C from "@/lib/cutter/commands";
import * as X from "@/lib/cutter/extensions";
import * as R from "@/lib/cutter/reference";
import { reformat } from "@/lib/cutter/reformat";
import { DEFAULT_CITE_FORMAT, writeCite } from "@/lib/cutter/cites";
import { aiKey, setAiKey, checkKey, AI_MODEL } from "@/lib/ai/claude";
import { citeFromLink } from "@/lib/ai/cite";
import { aiReformat, cardsToDo, cardAt } from "@/lib/ai/reformat";
import { aiIndict, type Rehighlight } from "@/lib/ai/indict";
import { findBlocks, type Found, type Sources, type Analytic } from "@/lib/ai/blocks";
import { spotPlugin, holdSpot, takeSpot, type Spot } from "@/lib/ai/spot";
import { caselistClient, familyOf, haveKept } from "@/lib/caselist/client";
import { ACTIONS, ACTION, comboOf, keyLabel, keyFor, actionFor, bind, refuse, caveat, loadKeys, saveKeys, watchChords, type Overrides } from "@/lib/cutter/keys";
import { docxToHtml } from "@/lib/cutter/docxIn";
import { sanitize, readTime } from "@/lib/viewer/doc";
import { textToHtml } from "@/lib/viewer/draw";
import { listDocs, getDoc, keepDoc, dropDoc, newDocId, type ViewDoc, type ViewMeta, type DocKind } from "@/lib/viewer/store";
import { verbatimPlugin, verbKey, readWords, countIn, isVerbatim } from "@/lib/cutter/verbatim";
import { spellPlugin, spellKey, SPELL_MODES, type SpellMode } from "@/lib/cutter/spell";
import { placePlugin, placeCard, placeKey, removeCards } from "@/lib/cutter/place";
import { slashPlugin, type SlashAt } from "@/lib/cutter/slash";
import { gripPlugin } from "@/lib/cutter/grips";
import { foldPlugin, setFolded as foldTags, isFolded } from "@/lib/cutter/fold";
import { RM_PALETTE_KEY } from "@/lib/toolTheme";
import { parseFlow, gdocId, type FlowItem } from "@/lib/gflow";
import FlowTable, { type SectionWrite, type FlowedCard } from "./FlowTable";
import { parseSections, type FlowSection } from "@/lib/gflowTable";
import { readFlow, writeRows, isStale, getToken, hasToken, wasConnected, warmUp, signOut, SignInExpired, type ApiFlow, type ApiRow, type RowWrite } from "@/lib/gdocsApi";
import { buildSearch, searchCards } from "@/lib/caselist/search.js";
import { openBus, type Bus } from "@/lib/toolsBus";
import { scoped } from "@/lib/owner";
import { newCode, tidyCode } from "@/lib/flow/share";
import { useFullscreen } from "./FullBtn";
import { popOut } from "./PopBtn";
import DocEditor, { type DocApi } from "./DocEditor";
import { clock } from "./MagicRead";
import MagicFlow, { type Outline } from "./MagicFlow";
import SlashFind, { slashFor, slashStep, type SlashRow, type SlashMenu } from "./SlashFind";
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
 *  - Flow, a Public Forum flower (MagicFlow): what you send lands on it, and partners flow together.
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
/** A page made on the spot from library blocks that were never a file: open while you want it, kept nowhere. */
const TEMP = "t:";
const isTemp = (id: string) => id.startsWith(TEMP);
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
type Mode = "edit" | "split" | "speech" | "flow";
type Tab = "outline" | "files" | "search" | "round";
interface SdFile { i: number; name: string; ctime: number }

const MAX_PANES = 3;
let paneSeq = 0;
const newKey = () => "p" + (++paneSeq) + "_" + Date.now().toString(36);

/** What only makes sense with the cursor in a document. */
const IN_DOC = new Set(["pocket", "hat", "block", "tag", "cite", "underline", "emphasis", "highlight", "clear", "shrink", "condense", "paste", "new-card", "move-up", "move-down", "new-extension", "analytic", "page-break", "clean-up", "reference", "insert-reference", "reformat", "send", "condense-omitted"]);
/** coda's keys that still work while you're flowing: the modes, the command menu, the timer, the library. */
const IN_FLOW_TOO = new Set(["mode-split", "mode-speech", "mode-flow", "palette", "timer", "library"]);
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
  { id: "ink", name: "Ink", sub: "coda: near-black, ivory", chrome: "#0B0B0C", side: "#0F0F11", acc: "#EDEDEF" },
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
  { id: "blueprint", name: "Blueprint", sub: "Drafting grid, blueprint blue", chrome: "#EEF4FB", side: "#F4F8FD", acc: "#1F5FBF" },
  { id: "sakura", name: "Sakura", sub: "Blush, plum, cherry", chrome: "#FBEEF2", side: "#FDF5F7", acc: "#C2366B" },
  { id: "matcha", name: "Matcha", sub: "Sage, tea green, paper", chrome: "#EEF2E6", side: "#F4F7EE", acc: "#5A7D2A" },
  { id: "library", name: "Library", sub: "Parchment, oxblood, gold", chrome: "#F3EBDA", side: "#F7F0E1", acc: "#7A1F2B" },
  { id: "lilac", name: "Lilac", sub: "Lavender haze, violet", chrome: "#F1EDFB", side: "#F6F3FD", acc: "#7C4DDB" },
  { id: "citrus", name: "Citrus", sub: "Cream, tangerine, hard black lines", chrome: "#FFF8E6", side: "#FFFBEF", acc: "#F26B1D" },
] as const;
/** Set once Graphite, the default before coda, has been moved to Ink. */
const INK_MOVED_KEY = "rm.inkMoved";
/** The palettes with light chrome, listed apart in the menu. */
const LIGHT_PALETTES = new Set(["paper", "glacier", "blueprint", "sakura", "matcha", "library", "lilac", "citrus"]);
/** The light six each read in a face of their own (the page you cut on stays Calibri): fetched the first time one is picked. */
const PALETTE_FONT: Partial<Record<string, string>> = { blueprint: "IBM+Plex+Mono:wght@400;500;600", sakura: "Zen+Maru+Gothic:wght@400;500;700", matcha: "Zen+Kaku+Gothic+New:wght@400;500;700", library: "EB+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400", lilac: "Quicksand:wght@400;500;600;700", citrus: "Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700" };
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
  { id: "twin", name: "Twin", sub: "The speech doc twice: as you write it, and beside it verbatimised or tags only — a second look", pic: [[0, 0, 60, 4, "c"], [0, 4, 12, 34, "s"], [13, 4, 23, 34, "d"], [37, 4, 23, 34, "p"], [40, 9, 15, 2, "c"], [40, 15, 11, 2, "c"], [40, 21, 15, 2, "c"]] },
  { id: "deck", name: "Deck", sub: "One page at a time, full width, with tabs along the top — Alt+[ and Alt+] flip", pic: [[0, 0, 60, 4, "c"], [0, 4, 13, 34, "s"], [14, 5, 10, 4, "d"], [25, 5, 10, 4, "c"], [14, 9, 46, 29, "p"]] },
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
  wide: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M3 12h18" /></svg>,
  /** the coda sign: an oval, heavy at its sides, crossed */
  coda: <svg width="18" height="18" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M32 14a13 18 0 1 0 0.001 0ZM32 18.6a7.6 13.4 0 1 1 -0.001 0Z" /><rect x="30.7" y="6" width="2.6" height="52" /><rect x="12" y="30.7" width="40" height="2.6" /></svg>,
  spark: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z" /><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" /></svg>,
  theme: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5a8.5 8.5 0 010 17z" fill="currentColor" stroke="none" /></svg>,
  more: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>,
  bolt: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M13 3L5 13h6l-1 8 8-10h-6z" /></svg>,
  file: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8zM14 3v5h5" /></svg>,
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
  const [wpm, setWpm] = useState(230);
  const [hideDim, setHideDim] = useState(false);
  const [depth, setDepth] = useState(4);
  const [olFilter, setOlFilter] = useState("");
  // the outline's folds, the way Word's navigation pane has them: a heading opened or shut by hand, over what the depth buttons say
  const [olFold, setOlFold] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<null | { id: string; x: number; y: number; up?: number }>(null);
  /** the speech doc's room, as the engine has it (EV.room()), and the Room panel's fields */
  const [roomInfo, setRoomInfo] = useState<null | { code: string; status: string; name: string; suggested: string; flows: { name: string; kind: string }[]; mates: { name: string; color: string }[] }>(null);
  const [roomNameIn, setRoomNameIn] = useState("");
  const [roomCodeIn, setRoomCodeIn] = useState("");
  // the ribbon: folded to one line, or with some of its groups folded into a button each
  // one line by default: the cutting buttons are on the keys and in ⋯, and Alt+M brings their row back
  const [ribMin, setRibMin] = useState(true);
  const [layoutMode, setLayoutMode] = useState<LayoutId>("classic");
  // Focus: the side is a drawer, out of sight until the pointer reaches the edge or a key asks for it
  const [drawer, setDrawer] = useState(false);
  // Deck: the pages opened this session, as tabs
  const [deckTabs, setDeckTabs] = useState<{ id: string; name: string }[]>([]);
  // the speech doc verbatimised in place (Alt+V with the cursor in it)
  const [speechVerb, setSpeechVerb] = useState(false);
  // Twin: how the second look shows the speech doc
  const [twinView, setTwinView] = useState<"verbatim" | "tags">("verbatim");
  // what is typed in the library search, for the commands that sit over its results
  const [cmdQ, setCmdQ] = useState("");
  // your partner's flow, in a Google Doc shared by link: where it is, whether it is watched and shown, and what it says
  const [gfLink, setGfLink] = useState("");
  const [gfOn, setGfOn] = useState(false);
  const [gfShow, setGfShow] = useState(true);
  // the flow panel's place and size on the screen
  const [gfPos, setGfPos] = useState({ x: 0, y: 0, w: 380, h: 460 });
  const gfPosRef = useRef(gfPos);
  gfPosRef.current = gfPos;
  const fitGf = (p: { x: number; y: number; w: number; h: number }) => {
    const W = window.innerWidth, H = window.innerHeight;
    const w = Math.min(Math.max(240, p.w), W - 16), h = Math.min(Math.max(160, p.h), H - 16);
    return { w, h, x: Math.min(Math.max(8, p.x), W - w - 8), y: Math.min(Math.max(8, p.y), H - h - 8) };
  };
  // first time open: at the right, under the ribbon
  useEffect(() => { if (gfOn && gfPos.x === 0 && gfPos.y === 0) setGfPos(fitGf({ x: window.innerWidth - 400, y: 150, w: 380, h: 460 })); }, [gfOn]); // eslint-disable-line react-hooks/exhaustive-deps
  const gfDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget, sx = e.clientX, sy = e.clientY, p0 = gfPosRef.current;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setGfPos(fitGf({ ...p0, x: p0.x + ev.clientX - sx, y: p0.y + ev.clientY - sy }));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const gfResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget, sx = e.clientX, sy = e.clientY, p0 = gfPosRef.current;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setGfPos(fitGf({ ...p0, w: p0.w + ev.clientX - sx, h: p0.h + ev.clientY - sy }));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  // the Doc itself, to write in (Google's editor, framed) — or read: formatted, a line clicked looks for it in the library
  const [gf, setGf] = useState<{ items: FlowItem[]; html: string; at: number; err: string; fresh: Set<string> } | null>(null);
  const [cmdSel, setCmdSel] = useState(0);
  const focusLayout = layoutMode === "focus";
  // the dock is the folded ribbon, laid out another way
  const ribSmall = ribMin || focusLayout || layoutMode === "dock";
  const [folded, setFolded] = useState<string[]>([]);
  const [palette, setPalette] = useState<PaletteId>("ink");
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
  const aiOpenRef = useRef<(what: "cite" | "reformat" | "indict" | "blocks" | "settings") => void>(() => {});
  // the command menu: one box for every command, every file, and both searches
  const [pal, setPal] = useState<null | { q: string; sel: number }>(null);
  const palIn = useRef<HTMLInputElement>(null);
  const palList = useRef<HTMLUListElement>(null);
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
        if (typeof u.gfLink === "string") setGfLink(u.gfLink);
        if (u.gfPos && typeof u.gfPos.x === "number") setGfPos(fitGf(u.gfPos));
        else setGfPos(fitGf({ x: window.innerWidth - 400, y: 120, w: 380, h: 460 }));
        // open when the page was left: open again
        if (u.gfOn === true && typeof u.gfLink === "string" && u.gfLink) setGfOn(true);
        if (typeof u.wpm === "number") setWpm(u.wpm);
        if (typeof u.hideDim === "boolean") setHideDim(u.hideDim);
        if (typeof u.speechOutline === "boolean") setSpeechOutline(u.speechOutline);
        if (typeof u.depth === "number") setDepth(u.depth);
        if (typeof u.limit === "number") setTimer((t) => ({ ...t, limit: u.limit }));
        if (typeof u.ribMin === "boolean") setRibMin(u.ribMin);
        if (LAYOUT_MODES.some((l) => l.id === u.layout)) setLayoutMode(u.layout);
        if (Array.isArray(u.folded)) setFolded(u.folded.filter((x: unknown) => typeof x === "string"));
        // coda moved everyone on Graphite, the old default, to Ink — once; Graphite is still in the menu
        let movedToInk = false;
        try { movedToInk = !!localStorage.getItem(INK_MOVED_KEY); localStorage.setItem(INK_MOVED_KEY, "1"); } catch { /* private */ }
        if (u.palette === "graphite" && !movedToInk) setPalette("ink");
        else if (PALETTES.some((p) => p.id === u.palette)) setPalette(u.palette);
        if (typeof u.sideW === "number") setSideW(Math.min(760, Math.max(220, u.sideW)));
        if (SPELL_MODES.some((m) => m.id === u.spell)) setSpell(u.spell);
        if (typeof u.speechTags === "boolean") setSpeechTags(u.speechTags);
      }
    } catch { /* first time */ }
    setUiReady(true);
  }, [owner]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem(scoped("cutter.hl", owner), hl); } catch { /* private */ } }, [hl, owner]);
  // a palette with a face of its own: the face, fetched once
  useEffect(() => {
    const f = PALETTE_FONT[palette];
    if (!f || document.getElementById("rm-font-" + palette)) return;
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.id = "rm-font-" + palette;
    l.href = "https://fonts.googleapis.com/css2?family=" + f + "&display=swap";
    document.head.appendChild(l);
  }, [palette]);
  // the site's nav, above the ribbon, wears the palette too (magic.css) — and from before the page paints, next time (lib/toolTheme)
  useEffect(() => {
    if (!uiReady) return;
    document.documentElement.setAttribute("data-rm-palette", palette);
    try { localStorage.setItem(RM_PALETTE_KEY, palette); } catch { /* private */ }
  }, [palette, uiReady]);
  useEffect(() => {
    if (!uiReady) return;
    try { localStorage.setItem(UI_KEY, JSON.stringify({ mode: mode === "flow" ? "edit" : mode, tab, speechW, speechH, wpm, hideDim, speechOutline, depth, limit: timer.limit, ribMin, folded, palette, sideW, spell, speechTags, layout: layoutMode, gfLink, gfOn, gfPos })); } catch { /* private */ }
  }, [mode, tab, speechW, speechH, wpm, hideDim, speechOutline, depth, timer.limit, ribMin, folded, palette, sideW, spell, speechTags, layoutMode, gfLink, gfOn, gfPos, UI_KEY, uiReady]);
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
          spotPlugin(),
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
        spotPlugin(),
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
      // the outline draws again only when a heading itself changed — not for every letter typed in a
      // card, which only moves where the headings sit (read fresh from headsFor when one is clicked)
      const was = headsFor.current.heads;
      headsFor.current = { doc, heads: out };
      if (out.length !== was.length || out.some((h, k) => h.level !== was[k].level || h.text !== was[k].text)) setHeads(out);
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
          if (isTemp(fid)) {
            // library blocks opened as a page: what's on it is what those blocks are now
            const html = toHtml(doc);
            loaded.current.set(fid, { ...base, doc: doc.toJSON(), html, updated: Date.now() });
            const t = tempOf.current.get(fid);
            if (t) await (window as any).EV?.updatePocket?.(t.name, html, t.hatPocket);
            continue;
          }
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
      const f = isTheirs(fid) ? await theirRecord(fid) : isTemp(fid) ? rec || null : await getFile(owner, fid);
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
      if (!isTemp(fid)) try { localStorage.setItem(scoped("cutter.last", owner), fid); } catch { /* private */ }
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

  /** A doc of theirs opened from Round: just that doc, never the speech doc beside it. */
  const openSolo = useCallback(async (id: string, then?: (v: EditorView) => void) => {
    if (modeRef.current === "speech" || modeRef.current === "split") { modeRef.current = "edit"; setModeState("edit"); inSpeech.current = false; }
    await open(id, then);
  }, [open]);

  const create = useCallback(async (fileName: string, html?: string) => {
    const f = await newFile(fileName, html);
    const key = activeRef.current || panesRef.current[0]?.key;
    if (key && isRead(key)) setPaneRead(key, false);
    await open(f.id, (v) => { v.focus(); v.dispatch(v.state.tr.setSelection(TextSelection.atStart(v.state.doc))); });
    return f;
  }, [newFile, open, setPaneRead]);

  // a library import that brought your files back (engine.js restoreFiles): the Files tab reads them again
  useEffect(() => {
    const on = () => {
      void listFiles(owner).then((l) => {
        setFiles(l);
        // the empty file a fresh install starts in may have gone: open one that is there
        const here = curRef.current?.id;
        if (l.length && here && !isTheirs(here) && !isTemp(here) && !l.some((f) => f.id === here)) void open(l[0].id);
      });
    };
    window.addEventListener("coda:files-changed", on);
    return () => window.removeEventListener("coda:files-changed", on);
  }, [owner, setFiles, open]);

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
        panes: panes.filter((p) => !isTheirs(p.fileId) && !isTemp(p.fileId)).map((p) => ({ fileId: p.fileId, read: p.read, follow: p.follow })),
        widths, side, active: Math.max(0, panes.findIndex((p) => p.key === activeKey)),
      }));
    } catch { /* private */ }
  }, [panes, widths, side, activeKey, LAYOUT_KEY]);

  // a shared file's link: the file is opened — made a file of yours first, if this browser has not had it before
  const linked = useRef(false);
  const [linkIn, setLinkIn] = useState("");
  const openLinkRef = useRef<(id: string) => Promise<void>>(async () => {});
  useEffect(() => {
    if (!sharedLink || linked.current || !panes.length) return;
    linked.current = true;
    void openLinkRef.current(sharedLink).then(() => {
      try { const u = new URL(location.href); u.searchParams.delete("doc"); window.history.replaceState(null, "", u.pathname + u.search); } catch { /* the address keeps it */ }
    });
  }, [sharedLink, panes.length]); // eslint-disable-line react-hooks/exhaustive-deps
  openLinkRef.current = async (link: string) => {
      try {
        let f = filesRef.current.find((x) => x.share === link) || null;
        if (!f) {
          const info = await peekShare(link);
          const made = await newFile(info.title || "Shared doc", "<p></p>", link);
          f = stripDoc(made);
          toast(`“${made.name}”${info.owner ? ", shared by " + info.owner : ""} — it is in your files now, and you are in it together`);
        }
        if (modeRef.current === "flow") { modeRef.current = "edit"; setModeState("edit"); }
        await open(f.id, (v) => v.focus());
      } catch (e) {
        toast(e instanceof NotShared ? "That link's doc is not shared any more" : "The shared doc would not open: " + String((e as Error)?.message || e));
      }
  };
  /** A link pasted into the Share menu. */
  const openPasted = () => {
    const id = linkId(linkIn);
    if (!id) { toast("That isn't a coda share link"); return; }
    setLinkIn(""); setMenu(null);
    void openLinkRef.current(id);
  };

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
  /** Your name over your cursor: the account's, or — in the app, with no account — the one you gave the Room. */
  const myName = () => { if (me) return me; try { return localStorage.getItem(scoped("evidence.me", owner)) || ""; } catch { return ""; } };
  const copyLink = useCallback(async (id: string) => {
    try { await navigator.clipboard.writeText(shareLink(id)); toast("Link copied — whoever opens it is in the file with you"); }
    catch { toast("The browser would not copy it — the link is in the Share menu to copy by hand"); }
  }, [toast]);
  const startShare = useCallback(async (fid: string) => {
    const k = keyShowing(fid);
    const v = k ? views.current.get(k) : null;
    const base = loaded.current.get(fid);
    if (!v || !base || isTheirs(fid) || isTemp(fid)) return;
    if (base.share) { void copyLink(base.share); return; }
    setBusy(true);
    try {
      await flush();
      const id = await createShare(base.name, myName());
      const doc = v.state.doc;
      const sh = await openShare(id, {
        name: myName() || "Partner", first: true,
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
    // just their doc — the speech doc opens only when you open it (SPLIT)
    await openSolo(THEIRS + d.id, (v) => { v.focus(); v.dispatch(v.state.tr.setSelection(TextSelection.atStart(v.state.doc))); });
  }, [owner, refreshTheirs, openSolo]);

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
      const r = await fetch(`${apiBase()}/api/tools/speechdrop?room=${encodeURIComponent(code)}`, { cache: "no-store" });
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
      const r = await fetch(`${apiBase()}/api/tools/speechdrop?room=${encodeURIComponent(sdState.code)}&i=${f.i}`, { cache: "no-store" });
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
  const setMode = useCallback((m: Mode) => {
    modeRef.current = m;
    setModeState(m);
    if (m === "speech") inSpeech.current = true;
    else if (m !== "split") inSpeech.current = false;
    requestAnimationFrame(() => {
      if (m === "split" || m === "speech") (window as any).EV?.renderDoc?.();
      if (m === "speech") speechView.current?.focus();
      else if (m === "flow") (document.querySelector(".mf-grid") as HTMLElement | null)?.focus();
      else view.current?.focus();
      readHeads();
    });
  }, [readHeads]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- Flow: what it reads from coda, and how it asks the library */
  /** A document's blocks and the tags under each, for Flow to take down. */
  const outlineOf = (doc: PMNode | null | undefined, fallback: string): Outline[] => {
    if (!doc) return [];
    const out: Outline[] = [];
    let cur: Outline | null = null;
    doc.forEach((n) => {
      if (n.type !== schema.nodes.heading) return;
      const t = n.textContent.replace(/\s+/g, " ").trim();
      if (!t) return;
      if (n.attrs.level === 3) { cur = { block: t, tags: [] }; out.push(cur); }
      else if (n.attrs.level === 4) { if (!cur) { cur = { block: fallback, tags: [] }; out.push(cur); } cur.tags.push(t); }
    });
    return out.filter((b) => b.tags.length);
  };
  const flowSpeechOutline = () => outlineOf(speechView.current?.state.doc || speechDoc(), "Speech doc");
  const flowFileOutline = () => {
    const v = view.current;
    if (!v || !cur) return null;
    return { name: cur.name, theirs: curTheirs, blocks: outlineOf(v.state.doc, cur.name) };
  };
  /** A cell of the flow, answered from your library: the search, in Answer mode, Enter still sending. */
  const flowAnswer = (text: string) => {
    const EV = (window as any).EV;
    setSide(true); setTab("search");
    requestAnimationFrame(() => {
      (root.current?.querySelector('#srcsw [data-src="lib"]') as HTMLElement | null)?.click();
      const q = root.current?.querySelector("#q") as HTMLInputElement | null;
      if (!q) return;
      q.value = text.slice(0, 200);
      q.dispatchEvent(new Event("input", { bubbles: true }));
      EV?.setAnswer?.({ claim: text, under: false });
      q.focus();
      // typing something else in the search leaves Answer mode
      const off = () => { if (q.value !== text.slice(0, 200)) { EV?.setAnswer?.(null); q.removeEventListener("input", off); } };
      q.addEventListener("input", off);
    });
  };

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

  // the speech doc's room: the engine says when it changes, and the Room panel follows
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const on = () => { const ev = (window as any).EV; if (ev?.room) setRoomInfo(ev.room()); };
    el.addEventListener("evi:room", on);
    on();
    return () => el.removeEventListener("evi:room", on);
  }, []);

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
      await openSolo(d.file, (v) => {
        let pos = -1;
        v.state.doc.forEach((n, p) => { if (pos < 0 && n.type === schema.nodes.heading && n.textContent.replace(/\s+/g, " ").trim().toLowerCase() === want) pos = p; });
        if (pos >= 0) goPos(v, pos); else v.focus();
      });
      if (modeRef.current === "flow") { modeRef.current = "edit"; setModeState("edit"); }
      return;
    }
    if (d.how === "page") {
      // a page of its own, kept with the round's docs and out of the library: to read, rehighlight, send from
      const rec: ViewDoc = { id: newDocId(), name: d.title.slice(0, 80) || "Card", kind: "html", source: d.from === "caselist" ? "caselist" : "library", by: d.by, at: Date.now(), html: d.html };
      await keepDoc(owner, rec);
      void refreshTheirs();
      // just the page, never the speech doc beside it
      if (modeRef.current !== "edit") { modeRef.current = "edit"; setModeState("edit"); inSpeech.current = false; }
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
  }, [owner, open, openSolo, addPane, activate, goPos, refreshTheirs, toast]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const on = (e: Event) => { void openCard((e as CustomEvent).detail); };
    el.addEventListener("evi:open", on);
    return () => el.removeEventListener("evi:open", on);
  }, [openCard]);

  /** Which library pocket each page of library blocks is, so its edits go back to those blocks. */
  const tempOf = useRef(new Map<string, { name: string; hatPocket: boolean }>());
  // ---- a pocket in the search, clicked: its file — the one it came from, or one of yours by its name.
  // Imported blocks that were never a file open as a page of their own, kept nowhere: not in your files,
  // not in their docs. Edits stay while it's open; Keep as mine makes it a file.
  const openPocketFile = useCallback(async (d: { name: string; file?: string; html?: string; hatPocket?: boolean; none?: () => void }) => {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const have = (d.file && filesRef.current.find((f) => f.id === d.file)) || filesRef.current.find((f) => norm(f.name) === norm(d.name));
    if (!have && !d.html) { d.none?.(); return; }
    if (modeRef.current === "flow") { modeRef.current = "edit"; setModeState("edit"); }
    if (have) { await open(have.id, (v) => v.focus()); return; }
    const id = TEMP + norm(d.name);
    tempOf.current.set(id, { name: d.name, hatPocket: !!d.hatPocket });
    if (!loaded.current.has(id)) loaded.current.set(id, { id, name: d.name, doc: null, html: d.html!, cards: [], words: 0, created: Date.now(), updated: Date.now() });
    await open(id, (v) => { v.focus(); v.dispatch(v.state.tr.setSelection(TextSelection.atStart(v.state.doc))); });
  }, [open]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const on = (e: Event) => { void openPocketFile((e as CustomEvent).detail); };
    el.addEventListener("evi:file", on);
    return () => el.removeEventListener("evi:file", on);
  }, [openPocketFile]);

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
    // the speech doc, when that is where you are: verbatimised in place, and back
    const s = speechView.current;
    if (s && (modeRef.current === "speech" || inSpeech.current || s.hasFocus())) {
      const on = !isVerbatim(s.state);
      s.dispatch(s.state.tr.setMeta(verbKey, on).setMeta("addToHistory", false));
      setSpeechVerb(on);
      if (!on) s.focus();
      toast(on ? "Speech doc verbatimised — just what you'll read · " + (keyLabel(keyFor(keysRef.current, "verbatim")) || "the same key") + " to edit it again" : "Speech doc: editing");
      return;
    }
    const k = activeRef.current;
    if (k) setPaneRead(k, !isRead(k));
  }, [setPaneRead, toast]);

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
    if (id === "palette") { setMenu(null); setPal((p) => (p ? null : { q: "", sel: 0 })); return; }
    if (id === "ai-cite") { aiOpenRef.current("cite"); return; }
    if (id === "ai-reformat") { aiOpenRef.current("reformat"); return; }
    if (id === "ai-blocks") { aiOpenRef.current("blocks"); return; }
    if (id === "ai-indict") { aiOpenRef.current("indict"); return; }
    if (id === "command") {
      // the search, with every command after a >
      focusLibrary();
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
    if (id === "library") { if (layoutMode === "focus") setDrawer(true); focusLibrary(); return; }
    if (id === "new-file") { void create("Untitled file"); return; }
    if (id === "mode-split") { setMode(modeRef.current === "split" ? "edit" : "split"); return; }
    if (id === "mode-speech") { setMode(modeRef.current === "speech" ? "split" : "speech"); return; }
    if (id === "mode-flow") { setMode(modeRef.current === "flow" ? "edit" : "flow"); return; }
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
    if (id === "hl-next") {
      const i = C.HIGHLIGHTS.findIndex((h) => h.color === hlRef.current);
      const n = C.HIGHLIGHTS[(i + 1) % C.HIGHLIGHTS.length];
      setHl(n.color);
      toast(`Highlighter: ${n.name}`);
      return;
    }
    if (modeRef.current === "flow" && IN_DOC.has(id)) { toast("That's for the page — Edit to get back to it"); return; }
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
  }, [flush, create, toast, toggleVerb, readBeside, nextPane, setTab, setMode, sendCard, focusLibrary, toggleTags, layoutMode, deckTabs, mode, cur, keys]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ---- Twin: the speech doc a second time, read-only, verbatimised or folded to its tags ----------------
  const twinBox = useRef<HTMLDivElement>(null);
  const twinViewRef = useRef<EditorView | null>(null);
  useEffect(() => {
    if (layoutMode !== "twin") return;
    // the speech doc is the whole of the work area: no file pages beside it
    if (mode !== "speech" && mode !== "flow") setMode("speech");
  }, [layoutMode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const host = twinBox.current;
    if (layoutMode !== "twin" || !host) return;
    const tags = twinView === "tags";
    const mk = (doc: PMNode) => EditorState.create({ doc, plugins: [verbatimPlugin(!tags), foldPlugin(tags), gripPlugin()] });
    const s0 = speechView.current;
    const tv = new EditorView(host, {
      state: mk(s0 ? s0.state.doc : schema.topNodeType.createAndFill()!),
      editable: () => false,
      attributes: { class: "ct-sheet rm-twinsheet" },
      // a click in the second look: the speech doc goes there, with the cursor
      handleClickOn: (_v, pos) => {
        const s = speechView.current;
        if (!s) return false;
        const at = Math.min(pos, s.state.doc.content.size);
        try { s.dispatch(s.state.tr.setSelection(TextSelection.near(s.state.doc.resolve(at))).scrollIntoView()); } catch { /* the docs differ for a moment */ }
        s.focus();
        return true;
      },
    });
    twinViewRef.current = tv;
    let lastDoc: PMNode | null = s0 ? s0.state.doc : null, lastHead = -1;
    // the speech doc, followed: what is written in it, and where its cursor is
    const iv = window.setInterval(() => {
      const s = speechView.current;
      if (!s) return;
      if (s.state.doc !== lastDoc) {
        lastDoc = s.state.doc;
        tv.dispatch(tv.state.tr.replaceWith(0, tv.state.doc.content.size, s.state.doc.content).setMeta("addToHistory", false));
      }
      const head = s.state.selection.head;
      if (head !== lastHead && s.hasFocus()) {
        lastHead = head;
        const scroller = host.closest(".rm-scroll") as HTMLElement | null;
        try {
          const c = tv.coordsAtPos(Math.min(head, tv.state.doc.content.size));
          if (scroller && c.top) {
            const r = scroller.getBoundingClientRect();
            if (c.top < r.top + 40 || c.top > r.bottom - 60) scroller.scrollTo({ top: scroller.scrollTop + c.top - r.top - r.height / 3, behavior: "smooth" });
          }
        } catch { /* hidden there */ }
      }
    }, 200);
    return () => { clearInterval(iv); tv.destroy(); twinViewRef.current = null; };
  }, [layoutMode, twinView]);
  const twinWords = layoutMode === "twin" && speechView.current ? readWords(speechView.current.state.doc) : 0;

  // ---- your partner's flow, from a Google Doc -----------------------------------------------------------
  // Signed into Google: the Docs API — the tab called "flow", read and written. Not: Google's export of
  // the Doc (shared by link), read only. Either way read every few seconds while this tab is in front.
  const [gConn, setGConn] = useState(false);
  // the desktop app (src-tauri/, lib/desktop): Google will not sign in inside it, so the
  // partner's flow is read from its shared link there, and nothing asks for Google
  const [desktop, setDesktop] = useState(false);
  // the app's own updates: asked a little after it opens, then every six hours
  const [update, setUpdate] = useState<Ready | null>(null);
  const [updating, setUpdating] = useState<number | null>(null);
  useEffect(() => {
    if (!isDesktop()) return;
    let told = "";
    const ask = () => { void checkUpdate().then((u) => {
      if (!u) return;
      setUpdate(u);
      if (told !== u.version) { told = u.version; toast("coda " + u.version + " is ready — Update, top right, when you have a moment"); }
    }); };
    const first = setTimeout(ask, 8000);
    const every = setInterval(ask, 6 * 3600_000);
    return () => { clearTimeout(first); clearInterval(every); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const installUpdate = async () => {
    if (!update || updating !== null) return;
    setUpdating(0);
    try {
      await flush();                                   // what you have open, saved first
      await update.install((p) => setUpdating(p));
    } catch (e) {
      setUpdating(null);
      toast("The update didn't install: " + String((e as Error)?.message || e));
    }
  };
  useEffect(() => { setDesktop(isDesktop()); }, []);
  // the caselist in the app: the user's own openCaselist (Tabroom) sign-in, asked for when Caselist is first pressed
  const [clLogin, setClLoginState] = useState<CaselistLogin | null>(null);
  const [clAsk, setClAsk] = useState<null | { user: string; pass: string; busy: boolean; err: string }>(null);
  useEffect(() => {
    if (!isDesktop()) return;
    setClLoginState(caselistLogin());
    const out = () => { setClLoginState(null); setClAsk({ user: "", pass: "", busy: false, err: "Your openCaselist sign-in ran out — sign in again." }); setTab("search"); };
    window.addEventListener("coda:caselist-login", out);
    // Caselist pressed with no sign-in: the sign-in, not a failed search
    const el = root.current;
    const gate = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('#srcsw [data-src="cl"]') || caselistLogin() || haveKept()) return;
      e.preventDefault(); e.stopPropagation();
      setClAsk((a) => a || { user: "", pass: "", busy: false, err: "" });
    };
    el?.addEventListener("click", gate, true);
    return () => { window.removeEventListener("coda:caselist-login", out); el?.removeEventListener("click", gate, true); };
  }, [setTab]);
  const clSignIn = async () => {
    if (!clAsk || clAsk.busy) return;
    const user = clAsk.user.trim();
    if (!user || !clAsk.pass) { setClAsk({ ...clAsk, err: "Your Tabroom email and password." }); return; }
    setClAsk({ ...clAsk, busy: true, err: "" });
    try {
      const r = await fetch(CODA_WEB + "/api/tools/caselist?op=login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user, password: clAsk.pass }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.token) throw new Error(j.error || "openCaselist didn't answer (" + r.status + ")");
      const l = { token: String(j.token), until: Number(j.until) || Date.now() + 13 * 864e5, user };
      setCaselistLogin(l); setClLoginState(l); setClAsk(null);
      toast("Signed into openCaselist as " + user);
      // on into the caselist, now that it will answer
      requestAnimationFrame(() => (root.current?.querySelector('#srcsw [data-src="cl"]') as HTMLElement | null)?.click());
    } catch (e) {
      const m = (e as Error).message;
      setClAsk((a) => a && { ...a, busy: false, err: /fetch|network/i.test(m) ? "coda can't reach openCaselist — the caselist needs the internet." : m });
    }
  };
  // ---- AI (lib/ai): Claude Haiku 5.5, on each person's own Anthropic key, kept in this browser ----
  const [aiK, setAiK] = useState("");
  useEffect(() => { setAiK(aiKey(owner)); }, [owner]);
  const AI_OPTS = scoped("coda.ai.opts", owner);
  const [aiOpts, setAiOptsState] = useState({ trim: false, cutEnds: true, condense: true, retag: true, analytics: false });
  useEffect(() => { try { const v = JSON.parse(localStorage.getItem(AI_OPTS) || "null"); if (v) setAiOptsState((o) => ({ ...o, ...v })); } catch { /* first time */ } }, [AI_OPTS]);
  const setAiOpts = (p: Partial<typeof aiOpts>) => setAiOptsState((o) => { const n = { ...o, ...p }; try { localStorage.setItem(AI_OPTS, JSON.stringify(n)); } catch { /* private */ } return n; });
  type AiPanel =
    | { kind: "settings"; draft: string; busy: boolean; msg: string; bad: boolean; then?: "cite" | "reformat" | "indict" | "blocks" }
    | { kind: "cite"; url: string; err: string }
    | { kind: "blocks"; want: string; err: string };
  const [aiPanel, setAiPanel] = useState<AiPanel | null>(null);
  const aiStop = useRef<AbortController | null>(null);
  /** AI at work, in the background: what it's doing, for the chip in the corner. */
  const [aiRun, setAiRun] = useState<null | { label: string; done?: number; of?: number }>(null);
  /** Find blocks' answers, docked in the corner: the doc stays yours while they're up. */
  const [aiFound, setAiFound] = useState<(Found & { rehi?: Rehighlight[]; rehiSays?: string[] }) | null>(null);
  /** Find blocks' argument, when it came from their cards in the doc: those cards, held, to rehighlight if nothing answers them. */
  const aiWantFrom = useRef<null | { text: string; view: EditorView; spots: (Spot | null)[] }>(null);
  /** The answers dock, folded down to a bar in the corner so the page is clear. */
  const [aiDockMin, setAiDockMin] = useState(false);
  const aiWant = useRef("");
  const aiBusy = () => { if (aiStop.current) { toast("AI is still working on the last one — Stop it first"); return true; } return false; };
  /** What the block finder starts from: the selection, else the card you're in (its tag and what's read), else the line. */
  const wantFromHere = () => {
    const v = target();
    if (!v) return "";
    const { from, to, empty } = v.state.selection;
    if (!empty) {
      // every card the selection touches, whole: its tag, its cite, and what's read (else the start of its text)
      const st = v.state, idx = cardsToDo(st);
      if (idx.length > 1 || (idx.length === 1 && to - from > 200)) {
        const cards = idx.map((k) => {
          const c = cardAt(st, k);
          if (!c || !c.tag) return "";
          let read = "";
          st.doc.nodesBetween(c.bodyFrom, c.bodyTo, (n) => { if (n.isText && n.marks.some((m) => m.type === schema.marks.highlight)) read += n.text + " "; });
          read = read.replace(/\s+/g, " ").trim();
          const body = read || st.doc.textBetween(c.bodyFrom, c.bodyTo, "\n").slice(0, 2000);
          return [c.tag.node.textContent, c.cite?.node.textContent || "", body].filter(Boolean).join("\n");
        }).filter(Boolean);
        if (cards.length) return cards.join("\n\n").slice(0, 16000);
      }
      return st.doc.textBetween(from, to, "\n").slice(0, 16000);
    }
    const c = C.cardAround(v.state);
    if (c && c.tag) {
      let read = "";
      v.state.doc.nodesBetween(c.bodyFrom, c.bodyTo, (n) => { if (n.isText && n.marks.some((m) => m.type === schema.marks.highlight)) read += n.text + " "; });
      read = read.replace(/\s+/g, " ");
      return (c.tag.node.textContent + "\n" + (read.trim() || v.state.doc.textBetween(c.bodyFrom, c.bodyTo, "\n").slice(0, 1500))).trim();
    }
    return v.state.selection.$from.parent.textContent.slice(0, 2000);
  };
  /** A feature asked for: its panel — or with no key yet, AI settings first, and then it. */
  const aiOpen = (what: "cite" | "reformat" | "indict" | "blocks" | "settings") => {
    setMenu(null);
    if (what === "settings" || !aiKey(owner)) {
      setAiPanel({ kind: "settings", draft: "", busy: false, bad: false, msg: aiKey(owner) ? "" : "Paste your Anthropic API key to use AI in coda.", then: what === "settings" ? undefined : what });
      return;
    }
    if (what === "cite") setAiPanel({ kind: "cite", url: "", err: "" });
    else if (what === "blocks") {
      const here = wantFromHere();
      for (const sp of aiWantFrom.current?.spots || []) { const v0 = aiWantFrom.current!.view; if (!v0.isDestroyed) takeSpot(v0.state, sp); }
      aiWantFrom.current = null;
      const v = target();
      if (here && v) {
        const tags: number[] = [];
        v.state.doc.forEach((n, pos) => { if (n.type === schema.nodes.heading && n.attrs.level === 4) tags.push(pos); });
        const spots = cardsToDo(v.state).slice(0, 4).map((k) => (tags[k] === undefined ? null : holdSpot(v.state, tags[k])));
        if (spots.some(Boolean)) aiWantFrom.current = { text: here, view: v, spots };
      }
      setAiPanel({ kind: "blocks", want: here || aiWant.current, err: "" });
    }
    else if (what === "indict") void aiIndictNow();
    else void aiReformatNow();
  };
  aiOpenRef.current = aiOpen;
  const aiSaveKey = async () => {
    if (!aiPanel || aiPanel.kind !== "settings") return;
    const k = aiPanel.draft.trim();
    if (!k) { setAiPanel({ ...aiPanel, msg: "Paste the key first — it starts with sk-ant-.", bad: true }); return; }
    setAiPanel({ ...aiPanel, busy: true, msg: "Checking it with Anthropic…", bad: false });
    try {
      await checkKey(k);
      setAiKey(owner, k); setAiK(k);
      const then = aiPanel.then;
      setAiPanel({ kind: "settings", draft: "", busy: false, bad: false, msg: "Saved. AI is on." });
      if (then) requestAnimationFrame(() => aiOpenRef.current(then));
    } catch (e) {
      setAiPanel((p) => p && p.kind === "settings" ? { ...p, busy: false, bad: true, msg: (e as Error).message } : p);
    }
  };
  /** Rehighlighted copies, to the speech doc where its cursor is, as a sent card goes. Returns how many went. */
  const sendRehighlights = async (list: Rehighlight[]) => {
    const EV = (window as any).EV;
    const fid = viewFile.current.get(activeRef.current) || "";
    const fileName = loaded.current.get(fid)?.name || "their card";
    let sent = 0;
    if (!list.length || !EV?.parseHtml || !EV?.sendParsed) return 0;
    for (const c of list) {
      const parsed = EV.parseHtml(`<h3>${esc(c.block || fileName)}</h3>` + toHtml(c.doc), {});
      for (const b of (parsed.blocks || []).filter((x: any) => (x.args || []).length)) {
        await EV.sendParsed({ ...b, id: `rm:rehi:${Date.now()}:${sent}` }, 0, "rehighlighted, from " + fileName);
        sent++;
      }
    }
    if (sent) setSentPulse((x) => x + 1);
    return sent;
  };
  /** Analytics, to the speech doc as tags with no card under them. */
  /** Caselist cards, fetched whole and kept: one fetch each, started as soon as the answers come, so Send is instant. */
  const clReady = useRef(new Map<string, Promise<any>>());
  const readyCl = (raw: any): Promise<any> => {
    const id = String(raw?.id || raw?.tag || "");
    let p = clReady.current.get(id);
    if (!p) {
      const cl = caselistClient(owner, scoped) as any;
      p = Promise.resolve(cl.cardHtml(raw)).then((html: string) => {
        const EV = (window as any).EV;
        const b = EV?.parseHtml?.(html, {})?.blocks?.find((x: any) => (x.args || []).length);
        if (!b) throw new Error("it came back empty");
        return b;
      });
      p.catch(() => clReady.current.delete(id));
      clReady.current.set(id, p);
    }
    return p;
  };
  /** A caselist card into the speech doc, as the caselist search sends one: under its block's heading. */
  const sendCl = async (raw: any, team: string) => {
    const EV = (window as any).EV;
    if (!raw || !EV?.sendParsed) { toast("The speech doc is still starting — a moment"); return false; }
    try {
      const b = await readyCl(raw);
      await EV.sendParsed({ ...b, id: "cl_" + String(raw.path || raw.id || "") + "#" + String(b.title || ""), pre: [], args: [b.args[0]] }, 0, "from " + team);
      setSentPulse((x) => x + 1);
      return true;
    } catch (e) {
      toast("That caselist card wouldn't come: " + (e as Error).message);
      return false;
    }
  };
  // the caselist picks, fetched the moment the answers are up
  useEffect(() => {
    if (!aiFound) return;
    const raws = [...aiFound.best.map((p) => (p.from === "caselist" ? p.raw : null)), ...(aiFound.analytics || []).map((a) => (a.card && a.card.from === "caselist" ? a.card.raw : null))];
    for (const r of raws) if (r) readyCl(r).catch(() => { /* Send says so, if it's asked for */ });
  }, [aiFound]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Analytics, to the speech doc as tags, each with the card from your library that proves it right under it. */
  const sendAnalytics = async (items: Analytic[]) => {
    const EV = (window as any).EV;
    if (!items.length || !EV?.parseHtml || !EV?.sendParsed) { toast("The speech doc is still starting — a moment"); return; }
    let cards = 0;
    for (const [k, a] of items.entries()) {
      const parsed = EV.parseHtml(`<h3>Analytics</h3><h4>${esc(a.text)}</h4>`, {});
      for (const b of (parsed.blocks || []).filter((x: any) => (x.args || []).length)) {
        await EV.sendParsed({ ...b, id: `rm:analytic:${Date.now()}:${k}` }, 0, "analytic");
      }
      if (a.card && a.card.from === "library" && EV.quickSend) { await EV.quickSend(a.card.id, a.card.card === null ? undefined : a.card.card); cards++; }
      else if (a.card && a.card.from === "caselist" && a.card.raw) { if (await sendCl(a.card.raw, a.card.team)) cards++; }
    }
    setSentPulse((x) => x + 1);
    const n = items.length;
    toast((n === 1 ? "Sent the analytic" : `Sent ${n} analytics`) + (cards ? (cards === 1 ? " and its card" : ` and ${cards} cards`) : ""));
  };
  const aiIndictNow = async () => {
    const v = target();
    if (!v) { toast("Open a file first"); return; }
    if (aiBusy()) return;
    const ctl = new AbortController(); aiStop.current = ctl;
    setAiRun({ label: "Finding indicts" });
    try {
      const r = await aiIndict(v, aiKey(owner), { retag: aiOpts.retag }, ctl.signal, (done, of) => setAiRun({ label: "Finding indicts", done, of }));
      // the rehighlighted copies, to the speech doc; the file is as it was
      const sent = await sendRehighlights(r.done);
      const n = (x: number, w: string) => x + " " + w + (x === 1 ? "" : "s");
      const bits: string[] = [];
      if (sent) bits.push(`Sent ${r.done.length > 1 ? n(sent, "rehighlight") : "the rehighlight"} to the speech doc, ${n(r.indicts, "indict")}: ${r.says.slice(0, 2).join("; ")}`);
      else if (r.done.length) bits.push("Rehighlighted, but the speech doc is still starting — try again in a moment");
      if (r.skipped.length) bits.push((r.done.length ? "left alone: " : "Nothing rehighlighted: ") + r.skipped.join("; "));
      if (r.failed.length) bits.push("failed: " + r.failed[0]);
      toast(bits.join(" · "));
    } catch (e) {
      toast(ctl.signal.aborted ? "Stopped" : (e as Error).message);
    } finally {
      aiStop.current = null; setAiRun(null);
    }
  };
  const aiReformatNow = async () => {
    const v = target();
    if (!v) { toast("Open a file first"); return; }
    if (aiBusy()) return;
    const ctl = new AbortController(); aiStop.current = ctl;
    setAiRun({ label: "Reformatting" });
    try {
      const r = await aiReformat(v, aiKey(owner), { ...aiOpts, citeFormat: citeRef.current }, ctl.signal, (done, of) => setAiRun({ label: "Reformatting", done, of }));
      const n = (x: number, w: string) => x + " " + w + (x === 1 ? "" : "s");
      const bits = [`Reformatted ${r.done} of ${n(r.cards, "card")}`];
      if (r.done) bits.push(r.underlined + "% underlined");
      if (r.cites) bits.push(n(r.cites, "cite") + " rewritten");
      if (r.tightened) bits.push(n(r.tightened, "sentence") + " tightened");
      if (r.cutWords) bits.push(n(r.cutWords, "unread word") + " cut");
      if (r.skipped.length) bits.push("left alone: " + r.skipped.join("; "));
      if (r.failed.length) bits.push("failed: " + r.failed[0]);
      toast(bits.join(" · "));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      aiStop.current = null; setAiRun(null);
    }
  };
  /**
   * Where the cite will go, decided when you ask for it: the empty line you're on, else the card's empty
   * cite line, else after your line. It's held as a spot, so typing on elsewhere while Claude writes it doesn't move it.
   */
  const citeSpot = (v: EditorView) => {
    const st = v.state, $f = st.selection.$from;
    const here = $f.depth >= 1 ? { pos: $f.before(1), node: st.doc.child($f.index(0)) } : null;
    const c = C.cardAround(st);
    if (here && here.node.type === schema.nodes.paragraph && !here.node.textContent.trim()) return { spot: holdSpot(st, here.pos), replace: true };
    if (c?.cite && !c.cite.node.textContent.trim()) return { spot: holdSpot(st, c.cite.pos), replace: true };
    return { spot: holdSpot(st, here ? here.pos + here.node.nodeSize : st.doc.content.size), replace: false };
  };
  /** The cite, put at its spot: over the empty line if that's still empty, else just before what's there now. */
  const putCite = (v: EditorView, at: ReturnType<typeof citeSpot>, node: PMNode) => {
    const p = v.isDestroyed ? null : takeSpot(v.state, at.spot);
    if (!p) return false;
    const st = v.state, tr = st.tr;
    const $p = st.doc.resolve(p.pos);
    const pos = $p.depth ? $p.before(1) : p.pos;
    const there = st.doc.nodeAt(pos);
    if (at.replace && !p.lost && there && there.type === schema.nodes.paragraph && !there.textContent.trim()) tr.replaceWith(pos, pos + there.nodeSize, node);
    else tr.insert(pos, node);
    v.dispatch(tr);
    return true;
  };
  const aiCiteNow = async () => {
    if (!aiPanel || aiPanel.kind !== "cite") return;
    const url = aiPanel.url.trim();
    if (!/^https?:\/\/\S+\.\S+/i.test(url)) { setAiPanel({ ...aiPanel, err: "Paste the article's link — it starts with https://" }); return; }
    const v = target();
    if (!v) { setAiPanel({ ...aiPanel, err: "Open a file first." }); return; }
    if (aiBusy()) return;
    const at = citeSpot(v);
    const ctl = new AbortController(); aiStop.current = ctl;
    setAiPanel(null); v.focus();
    setAiRun({ label: "Writing the cite" });
    try {
      const parts = await citeFromLink(aiKey(owner), url, ctl.signal);
      const node = writeCite(parts, citeRef.current);
      const tail = parts.quals ? "" : " — the page didn't say the author's credentials";
      if (putCite(v, at, node)) toast("Cite added: " + parts.short + tail);
      else { try { await navigator.clipboard.writeText(node.textContent); } catch { /* not allowed */ } toast("Cite copied — the file it was for isn't open: " + parts.short); }
    } catch (e) {
      takeSpot(v.state, at.spot);
      toast(ctl.signal.aborted ? "Stopped" : (e as Error).message);
    } finally {
      aiStop.current = null; setAiRun(null);
    }
  };
  const aiBlocksNow = async () => {
    if (!aiPanel || aiPanel.kind !== "blocks") return;
    const EV = (window as any).EV;
    if (!EV?.libraryText) { setAiPanel({ ...aiPanel, err: "The library is still loading — try again in a moment." }); return; }
    if (!aiPanel.want.trim()) { setAiPanel({ ...aiPanel, err: "Select their argument, or paste it in, first." }); return; }
    if (aiBusy()) return;
    const clOn = desktop ? !!caselistLogin() || haveKept() : true;
    const cl = clOn ? (caselistClient(owner, scoped) as any) : null;
    const src: Sources = {
      library: () => EV.libraryText(),
      caselist: cl ? async (q: string, answer: boolean) => {
        // the wikis chosen in the caselist search, with its own default (high school policy) when none have been
        let fams: string[] = ["hspf"];
        try { const v = JSON.parse(localStorage.getItem(scoped("caselist.wikis", owner)) || "null"); if (Array.isArray(v) && v.length) fams = v; } catch { /* the default */ }
        if (!fams.length) return [];
        const metas = ((await cl.metas()) || []) as { wiki: string }[];
        for (const m of metas) if (fams.includes(familyOf(m.wiki))) { try { await cl.loadIndex(m.wiki); } catch { /* that wiki not now */ } }
        const r = await cl.find(q, fams, { answer });
        return ((r && r.groups) || []).flatMap((g: any) => g.cards.slice(0, 3).map((c: any) => ({ tag: String(c.tag || ""), cite: String(c.cite || ""), block: String(c.block || ""), team: String(g.name || ""), raw: c }))).slice(0, 12);
      } : null,
    };
    const want = aiPanel.want;
    aiWant.current = want;
    const ctl = new AbortController(); aiStop.current = ctl;
    setAiPanel(null); setAiFound(null); target()?.focus();
    setAiRun({ label: "Finding answers" });
    try {
      const found = await findBlocks(aiKey(owner), want, src, ctl.signal, (stage) => setAiRun({ label: stage.replace(/…$/, "") }), { analytics: aiOpts.analytics });
      const from = aiWantFrom.current;
      aiWantFrom.current = null;
      let rehi: Rehighlight[] = [], rehiSays: string[] = [];
      if (from) {
        // their cards, where they are now (and only if the argument is still the one taken from them)
        const tags: number[] = [];
        if (!from.view.isDestroyed) from.view.state.doc.forEach((n, pos) => { if (n.type === schema.nodes.heading && n.attrs.level === 4) tags.push(pos); });
        const idx = from.spots.map((sp) => (from.view.isDestroyed ? null : takeSpot(from.view.state, sp))).map((p) => (p && !p.lost ? tags.indexOf(p.pos) : -1)).filter((i) => i >= 0);
        if (!found.best.length && from.text === want && idx.length) {
          setAiRun({ label: "Rehighlighting their cards" });
          try {
            const r = await aiIndict(from.view, aiKey(owner), { retag: aiOpts.retag }, ctl.signal, (done, of) => setAiRun({ label: "Rehighlighting their cards", done, of }), idx);
            rehi = r.done; rehiSays = r.says;
          } catch (e) { if (ctl.signal.aborted) throw e; /* the analytics still stand */ }
        }
      }
      setAiFound({ ...found, rehi, rehiSays }); setAiDockMin(false);
    } catch (e) {
      toast(ctl.signal.aborted ? "Stopped" : (e as Error).message);
    } finally {
      aiStop.current = null; setAiRun(null);
    }
  };
  /** A caselist pick, found in the caselist search: Enter sends it, Shift+Enter puts it in the file. */
  const showInCaselist = (tag: string) => {
    setAiPanel(null); setTab("search");
    requestAnimationFrame(() => {
      const rootEl = root.current;
      (rootEl?.querySelector('#srcsw [data-src="cl"]') as HTMLElement | null)?.click();
      requestAnimationFrame(() => {
        const q = rootEl?.querySelector("#q") as HTMLInputElement | null;
        if (q) { q.value = tag.slice(0, 120); q.dispatchEvent(new Event("input", { bubbles: true })); q.focus(); }
      });
    });
  };
  const aiClose = () => { setAiPanel(null); target()?.focus(); };
  const clSignOut = () => { setCaselistLogin(null); setClLoginState(null); (root.current?.querySelector('#srcsw [data-src="lib"]') as HTMLElement | null)?.click(); toast("Signed out of openCaselist"); };
  const [apiFlow, setApiFlow] = useState<ApiFlow | null>(null);
  const gfTab = (gfLink.match(/[?&#]tab=(t\.[A-Za-z0-9_-]+)/) || [])[1] || "";
  // signed in here before: back in without a pop-up (Google hands a token over while you're signed into it)
  const [gExpired, setGExpired] = useState(false);
  useEffect(() => {
    if (!uiReady || isDesktop()) return;
    if (hasToken()) { setGConn(true); return; }
    // signed in before, but the hour is up: one click renews it
    if (wasConnected()) { setGExpired(true); warmUp(); }
  }, [uiReady]);
  useEffect(() => { if (tab === "round" && !gConn && !desktop) warmUp(); }, [tab, gConn, desktop]);
  const gConnect = async () => {
    try {
      await getToken(true);
      setGConn(true); setGExpired(false);
      toast("Connected to Google — what you write in the table goes into the Doc");
    } catch (e) { toast((e as Error).message); }
  };
  // the speech doc into your partner's Google Doc: a "speech doc" tab, and "(rhetoric speech doc)" inside it, verbatimised
  const [gSending, setGSending] = useState(false);
  const sendToGoogle = async () => {
    const sv = speechView.current;
    if (!sv) { toast("The speech doc isn't open"); return; }
    if (!gConn) { setTab("round"); toast("Connect Google first (Round tab), then send again"); return; }
    if (!gfLink.trim()) { setTab("round"); toast("Paste your partner's Google Doc link in the Round tab first"); return; }
    setGSending(true);
    try {
      const { sendSpeechDoc } = await import("@/lib/gdocsSpeech");
      const r = await sendSpeechDoc(gdocId(gfLink), sv.state.doc);
      toast("Sent — in the Doc's “speech doc” tab, with “(rhetoric speech doc)” inside it");
      void r;
    } catch (e) { toast("Couldn't send it: " + (e as Error).message); }
    finally { setGSending(false); }
  };
  const gDisconnect = () => { signOut(); setGConn(false); setApiFlow(null); toast("Disconnected from Google"); };
  useEffect(() => {
    if (!gfOn || !gfLink.trim()) return;
    let stop = false, busy = false, last = "";
    const pull = async () => {
      if (busy || stop || document.visibilityState !== "visible") return;
      busy = true;
      try {
        if (gConn) {
          const f = await readFlow(gdocId(gfLink), gfTab);
          if (stop) return;
          const sig = JSON.stringify(f.sections);
          if (sig !== last) { last = sig; setApiFlow(f); }
          setGf((g) => ({ items: [], html: "", fresh: new Set(), ...(g || {}), at: Date.now(), err: "" }));
          return;
        }
        const r = await fetch("/api/tools/gdoc?doc=" + encodeURIComponent(gfLink.trim()), { cache: "no-store" });
        const j = await r.json();
        if (stop) return;
        if (!r.ok) { setGf((g) => ({ items: g?.items || [], html: g?.html || "", at: g?.at || 0, err: j.error || "Couldn't read it", fresh: new Set() })); return; }
        if (j.html === last) { setGf((g) => (g ? { ...g, at: Date.now(), err: "" } : g)); return; }
        last = j.html;
        setGf({ items: parseFlow(j.html), html: j.html, at: Date.now(), err: "", fresh: new Set() });
      } catch (e) {
        if (e instanceof SignInExpired) { setGConn(false); setGExpired(true); toast(e.message); return; }
        if (!stop) setGf((g) => ({ items: g?.items || [], html: g?.html || "", at: g?.at || 0, err: gConn ? (e as Error).message : "Couldn't reach coda — trying again", fresh: new Set() }));
      } finally { busy = false; }
    };
    void pull();
    const iv = window.setInterval(() => void pull(), 4000);
    const vis = () => { if (document.visibilityState === "visible") void pull(); };
    document.addEventListener("visibilitychange", vis);
    return () => { stop = true; clearInterval(iv); document.removeEventListener("visibilitychange", vis); };
  }, [gfOn, gfLink, gConn, gfTab]);
  /** The table's changes into the Doc: worked out against the Doc as it is right now, and again if your partner moved it first. */
  const gWrite = useCallback(async (writes: SectionWrite[]) => {
    const id = gdocId(gfLink);
    for (let attempt = 0; attempt < 3; attempt++) {
      const fresh = await readFlow(id, gfTab);
      const list: RowWrite[] = [];
      const forRow = (row: ApiRow) => {
        let w = list.find((x) => x.row === row);
        if (!w) { w = { row, responses: row.responses, add: [] }; list.push(w); }
        return w;
      };
      const findRow = (si: number, arg: string) => fresh.sections[si]?.rows.find((r) => r.arg === arg) || fresh.sections.flatMap((x) => x.rows).find((r) => r.arg === arg);
      for (const w of writes) {
        for (const r of w.rows) { const row = findRow(w.si, r.arg); if (row) forRow(row).responses = r.responses; }
        if (w.added.length) {
          const sec = fresh.sections[w.si], last = sec?.rows[sec.rows.length - 1];
          if (!last) throw new Error("Add arguments under one that's in the Doc already");
          // an argument already in the Doc isn't added twice
          forRow(last).add.push(...w.added.filter((a) => !sec.rows.some((r) => r.arg === a.arg)));
        }
      }
      try {
        await writeRows(id, fresh, list);
        setApiFlow(await readFlow(id, gfTab));
        return;
      } catch (e) {
        if (isStale(e) && attempt < 2) continue;      // your partner typed in between: work it out again
        throw e;
      }
    }
  }, [gfLink, gfTab]);
  const flowSections: FlowSection[] = gConn ? apiFlow?.sections || [] : gf?.html ? parseSections(gf.html) : [];
  const gfWatch = () => {
    if (!gfLink.trim()) { toast("Paste the link to your partner's Google Doc first"); return; }
    setGf(null); setApiFlow(null); setGfOn(true); setGfShow(true);
    toast(gConn ? "Your partner's flow — what you write in the table goes into the Doc" : "Your partner's flow as tables — Connect Google to write into the Doc");
  };
  // a line of their flow, clicked: the library searched for it
  const lookFor = (text: string) => {
    focusLibrary();
    requestAnimationFrame(() => {
      const q = root.current?.querySelector("#q") as HTMLInputElement | null;
      if (!q) return;
      q.value = headOf(text);
      q.dispatchEvent(new Event("input", { bubbles: true }));
      q.focus(); q.select();
      // the search tab may only now be coming into view: focus it once it has
      setTimeout(() => { if (document.activeElement !== q) { q.focus(); q.select(); } }, 80);
    });
  };
  const gfSince = gf?.at ? Math.max(0, Math.round((Date.now() - gf.at) / 1000)) : null;

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
    ([["edit", "Just the file"], ["split", "Speech doc beside"], ["speech", "Just the speech doc"], ["flow", "Flow"]] as const)
      .forEach(([m, l]) => out.push({ id: "mode:" + m, label: "Mode: " + l, key: "", go: () => setMode(m) }));
    LAYOUT_MODES.forEach((l) => out.push({ id: "layout:" + l.id, label: "Layout: " + l.name, key: "", go: () => setLayoutMode(l.id) }));
    PALETTES.forEach((p) => out.push({ id: "pal:" + p.id, label: "Colours: " + p.name, key: "", go: () => setPalette(p.id) }));
    return out;
  })();
  const cmdMode = cmdQ.startsWith(">");
  const cmdHits = (() => {
    const raw = (cmdMode ? cmdQ.slice(1) : cmdQ).trim().toLowerCase();
    if (!cmdMode) return [];
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
      // in Flow, its keys are its own: only coda's few round-wide ones get through
      const inFlow = !!t?.closest?.(".mf");
      if (e.key === "/" && !typing && !inFlow && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); focusLibrary(); return; }
      // Esc in the search with nothing typed: back to the page
      if (e.key === "Escape" && t && t.id === "q" && !(t as HTMLInputElement).value) {
        e.preventDefault(); e.stopPropagation();
        target()?.focus();
        return;
      }
      const spec = comboOf(e);
      if (!spec) return;
      const id = actionFor(keysRef.current, spec);
      if (!id) return;
      if (inFlow && !IN_FLOW_TOO.has(id)) return;
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
    const w = id === "palette" ? 600 : id === "all" ? 560 : id === "pages" || id === "share" || id === "room" ? 330 : id.startsWith("g:") ? 360 : 240;
    const inRib = !!(anchor || e.currentTarget).closest(".rm-rib");
    // from the dock a menu opens upwards
    if (inRib && layoutMode === "dock") { setMenu({ id, x: Math.min(window.innerWidth - w - 8, Math.max(8, r.left)), y: 0, up: window.innerHeight - r.top + 6 }); return; }
    setMenu({ id, x: Math.min(window.innerWidth - w - 8, Math.max(8, r.left)), y: r.bottom + 6 });
  };

  /** The Room panel, under the Room button: its fields filled from the room (the code from your flow). */
  const openRoomPanel = (e?: React.MouseEvent<HTMLElement>) => {
    const ev = (window as any).EV;
    const info = ev?.room ? ev.room() : null;
    if (info) { setRoomInfo(info); setRoomNameIn(info.name || ""); setRoomCodeIn(info.code || info.suggested || ""); }
    const btn = root.current?.querySelector(".rm-room") as HTMLElement | null;
    if (e && menu?.id !== "room") { openMenu("room", e, btn || undefined); return; }
    if (menu?.id === "room") { setMenu(null); return; }
    const r = btn?.getBoundingClientRect();
    setMenu({ id: "room", x: r ? Math.min(window.innerWidth - 338, Math.max(8, r.left)) : Math.max(8, window.innerWidth / 2 - 165), y: r ? r.bottom + 6 : 80 });
  };
  const joinRoomNow = () => {
    const c = tidyCode(roomCodeIn);
    if (c.length < 4) { toast("A room code is at least 4 letters"); return; }
    (window as any).EV?.joinRoom(c, roomNameIn);
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
  /** Where heading i is now: the outline's list keeps the headings, not where typing has pushed them. */
  const headPos = (i: number) => headsFor.current.heads[i]?.pos ?? heads[i]?.pos;
  const dropTarget = (from: number, i: number): number | null => {
    const v = target();
    if (!v) return null;
    const secs = C.sections(v.state.doc);
    const me = secs.find((s) => s.pos === headPos(from));
    if (!me) return null;
    const t = i < heads.length ? headPos(i) : v.state.doc.content.size;
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
      const tr = t === null ? null : C.moveSection(v.state, headPos(drag), t);
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
  /** Flow cells deleted that had put cards in the speech doc: those cards out of it. */
  const unflow = useCallback((cards: FlowedCard[]) => {
    const s = speechView.current;
    if (!s) return 0;
    const r = removeCards(s.state, cards);
    if (!r) return 0;
    s.dispatch(r.tr);
    return r.n;
  }, []);
  // ---- "/" in the speech doc: the library, searched where you are, a card put in from a menu ----
  const [slash, setSlash] = useState<{ at: SlashAt; menu: SlashMenu } | null>(null);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const pickSlash = useCallback(async (r: SlashRow) => {
    const v = speechView.current;
    if (!v) return;
    // the "/words" go; the card takes the empty line they were on
    const $f = v.state.selection.$from;
    if ($f.depth === 1 && $f.parent.textContent.startsWith("/")) v.dispatch(v.state.tr.delete($f.start(), $f.end()).setMeta(placeKey, { aimed: true }));
    setSlash(null);
    const EV = (window as any).EV;
    if (!EV?.quickSend) { toast("The library is still loading"); return; }
    await EV.quickSend(r.id, r.ai);
    v.focus();
  }, [toast]);
  const slashHooks = useMemo(() => ({
    onChange: (at: SlashAt | null) => {
      if (!at) { if (slashRef.current) setSlash(null); return; }
      const was = slashRef.current;
      setSlash({ at, menu: slashFor(at.q, was && { q: was.at.q, menu: was.menu }) });
    },
    onKey: (e: KeyboardEvent) => {
      const s = slashRef.current;
      if (!s) return false;
      const step = slashStep(s.menu, e);
      if (!step) return false;
      if (step.pick) void pickSlash(step.pick);
      // straight into the ref too: a key held down comes faster than React draws
      else if (step.menu) { const next = { ...s, menu: step.menu }; slashRef.current = next; setSlash(next); }
      return true;
    },
  }), [pickSlash]);
  const slashHooksRef = useRef(slashHooks);
  slashHooksRef.current = slashHooks;

  /** What makes the speech doc edit as a page does: a page's Enter, a page's spelling, "/" to find a card. */
  const speechPlugins = useCallback(() => [
    slashPlugin({ onChange: (at) => slashHooksRef.current.onChange(at), onKey: (e) => slashHooksRef.current.onKey(e) }),
    keymap({ Enter: X.enterKeepingAnalytics }),
    spellPlugin(spellRef.current),
    placePlugin(),
    gripPlugin(),
    foldPlugin(speechTagsRef.current),
    spotPlugin(),
    verbatimPlugin(false),
  ], []);
  // a card sent from the search (or Alt+Enter in a file) goes where the speech doc's cursor is
  useEffect(() => {
    const placer = (d: { html: string; whole: boolean }) => {
      const s = speechView.current;
      // read-only only because it is verbatimised: the card still goes in
      if (!s || (!s.editable && !isVerbatim(s.state))) return null;
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
    // a speech doc made again (a room joined, the Read tab left) starts editable
    setSpeechVerb(false);
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
  // a temporary page shares, downloads and pops out like a doc of theirs: not until it is kept as yours
  const curTheirs = !!cur && (isTheirs(cur.id) || isTemp(cur.id));
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
      <button type="button" className="rm-b rm-i" data-tip="Download this file as a .docx" aria-label="Download as .docx" onClick={() => { const fid = viewFile.current.get(activeRef.current); if (fid && !isTheirs(fid) && !isTemp(fid)) void download(fid); else toast(fid && isTemp(fid) ? "Keep as mine first — then it downloads" : "Their docs download from where they came from — or keep it as yours first"); }}>{I.down}</button>
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

  // ---- the command menu ----------------------------------------------------------
  /** A library action (the engine listens for data-act clicks), run without its menu being open. */
  const act = (name: string) => {
    const b = document.createElement("button");
    b.type = "button"; b.hidden = true; b.dataset.act = name;
    root.current?.appendChild(b); b.click(); b.remove();
  };
  /** A menu of the bar's, opened as if its button were clicked. */
  const press = (sel: string) => (root.current?.querySelector(sel) as HTMLElement | null)?.click();
  type PalItem = { id: string; label: string; sub: string; key?: string; icon: React.ReactNode; go: () => void };
  /** What the command menu offers that needs the web: left out of the app. */
  const WEB_ONLY = new Set(["x:share", "x:room", "x:popsend", "x:tutorial", "x:signout", "x:desktop"]);
  const palItems: PalItem[] = (() => {
    if (!pal) return [];
    const q = pal.q.trim();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const extra: PalItem[] = [
      { id: "x:open", label: "Open a file…", sub: ".docx, web page, text or PDF", icon: I.file, go: () => fileIn.current?.click() },
      { id: "x:download", label: "Download this file as .docx", sub: "File", icon: I.down, go: () => { const fid = viewFile.current.get(activeRef.current); if (fid && !isTheirs(fid) && !isTemp(fid)) void download(fid); else toast("Keep it as yours first — then it downloads"); } },
      { id: "x:ai", label: "AI settings", sub: aiK ? "Your Anthropic key, and how cards are reformatted" : "Add your Anthropic key to use AI", icon: I.spark, go: () => aiOpen("settings") },
      { id: "x:keys", label: "Keys and cite format", sub: "Change any key", icon: I.keys, go: () => { setKeysOpen(true); setKeyNote(""); } },
      { id: "x:share", label: "Share this file…", sub: "A link your partner edits with you", icon: I.share, go: () => press(".rm-share") },
      { id: "x:room", label: "Room — the speech doc with your partner", sub: "Round", icon: I.share, go: () => openRoomPanel() },
      { id: "x:colours", label: "Colours and layout…", sub: "View", icon: I.pages, go: () => press(".rm-palbtn") },
      { id: "x:pages", label: "Pages…", sub: "Read view beside, two places in a file", icon: I.pages, go: () => press(".rm-pagesbtn") },
      { id: "x:full", label: full ? "Leave full screen" : "Full screen", sub: "View", icon: I.full, go: toggleFull },
      { id: "x:import", label: "Import an evidence file…", sub: "Library", icon: I.down, go: () => act("import") },
      { id: "x:case", label: "Your case…", sub: "Library", icon: I.file, go: () => act("case") },
      { id: "x:export", label: "Export the library", sub: "Library", icon: I.down, go: () => act("export") },
      { id: "x:settings", label: "Library settings", sub: "Library", icon: I.keys, go: () => act("settings") },
      { id: "x:format", label: "Format the speech doc for sending…", sub: "Speech doc", icon: I.send, go: () => act("format") },
      { id: "x:copysend", label: "Copy the speech doc", sub: "Speech doc", icon: I.send, go: () => act("copySend") },
      { id: "x:senddocx", label: "Download the speech doc", sub: "Speech doc", icon: I.down, go: () => speechApi.current?.saveDocx() },
      { id: "x:speechdrop", label: "Send the speech doc to SpeechDrop…", sub: "Speech doc", icon: I.send, go: () => speechApi.current?.speechDrop() },
      { id: "x:popsend", label: "Pop out the speech doc", sub: "A window that stays on top", icon: I.full, go: () => { if (!popOut("send")) toast("The browser blocked the window — allow pop-ups for this site"); } },
      { id: "x:tutorial", label: "Open the tutorial", sub: "How coda works", icon: I.bolt, go: () => window.open("/tools/tutorial", "_blank") },
      ...(desktop ? [] : [{ id: "x:desktop", label: "Get the desktop app", sub: "Windows and Mac — every key is yours", icon: I.down, go: () => window.open("/download", "_blank") }]),
      ...(desktop && clLogin ? [{ id: "x:clout", label: "Sign out of openCaselist", sub: "Signed in as " + clLogin.user, icon: I.x, go: clSignOut }] : []),
      ...(desktop && !clLogin ? [{ id: "x:clin", label: "Sign into openCaselist", sub: "Your Tabroom account — for the caselist", icon: I.search, go: () => { setTab("search"); setClAsk({ user: "", pass: "", busy: false, err: "" }); } }] : []),
      { id: "x:signout", label: "Sign out", sub: "Account", icon: I.x, go: async () => { await flush(true); await signOutOfCoda(); window.location.assign("/"); } },
    ];
    const cmds: PalItem[] = (desktop ? (xs: PalItem[]) => xs.filter((c) => !WEB_ONLY.has(c.id)) : (xs: PalItem[]) => xs)([
      ...commands.filter((c) => c.id !== "palette" && !["mode:split", "mode:speech", "mode:read"].includes(c.id)).map((c) => ({ id: c.id, label: c.label, sub: ACTION.get(c.id)?.group || c.label.split(":")[0], key: c.key, icon: I.bolt, go: c.go })),
      ...extra,
    ]);
    if (!words.length) {
      // nothing typed: the few things reached for most
      const want = ["library", "find", "send", "mode-split", "mode-flow", "new-file", "x:open", "timer", "x:keys", "x:colours"];
      return want.map((w) => cmds.find((c) => c.id === w)).filter(Boolean) as PalItem[];
    }
    const score = (label: string) => {
      const l = label.toLowerCase(), lw = l.split(/[^a-z0-9]+/);
      if (!words.every((w) => l.includes(w))) return -1;
      return words.reduce((n, w) => n + (lw.some((x) => x.startsWith(w)) ? 2 : 1), 0) + (l.startsWith(words[0]) ? 3 : 0);
    };
    const hitCmds = cmds.map((c) => ({ c, s: score(c.label + " " + c.sub) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 7).map((x) => x.c);
    const hitFiles = files.map((f) => ({ f, s: score(f.name) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 4)
      .map(({ f }) => ({ id: "f:" + f.id, label: f.name, sub: `File · ${f.cards.length} card${f.cards.length === 1 ? "" : "s"}`, icon: I.file, go: () => void open(f.id, (v) => v.focus()) }));
    const searches: PalItem[] = [
      { id: "s:lib", label: `Search the library for “${q}”`, sub: "Library and caselist — Enter sends a card", key: "Enter", icon: I.search, go: () => {
        focusLibrary();
        requestAnimationFrame(() => requestAnimationFrame(() => { const el = root.current?.querySelector("#q") as HTMLInputElement | null; if (el) { el.value = q; el.dispatchEvent(new Event("input", { bubbles: true })); el.focus(); } }));
      } },
      { id: "s:files", label: `Search your files for “${q}”`, sub: "Tags, cites, blocks and what is read", icon: I.search, go: () => { setTab("files"); setQ(q); requestAnimationFrame(() => qIn.current?.focus()); } },
    ];
    // a command or a file by its name first; with neither, what was typed is a search
    return hitCmds.length || hitFiles.length ? [...hitCmds, ...hitFiles, ...searches] : searches;
  })();
  const palGo = (it: PalItem) => {
    setPal(null);
    const isSearch = it.id.startsWith("s:") || it.id === "library" || it.id === "find";
    // the page gets the cursor back first: most commands work on it
    if (!isSearch) target()?.focus();
    requestAnimationFrame(() => it.go());
  };
  const palOpen = !!pal;
  useEffect(() => { if (palOpen) requestAnimationFrame(() => palIn.current?.focus()); }, [palOpen]);
  useEffect(() => { (palList.current?.querySelector("li.on") as HTMLElement | null)?.scrollIntoView({ block: "nearest" }); }, [pal?.sel]);

  return (
    <div className={"rm" + (desktop ? " desktop" : "") + (side ? "" : " side-hidden") + (full ? " full" : "") + (ribSmall ? " ribmin" : "") + (menu ? " menuopen" : "") + (drawer ? " drawer" : "")} ref={root} data-mode={mode} data-palette={palette} data-layout={layoutMode} data-sidetab={tab} data-heads={headsOf}
      style={{ ["--rm-hl" as string]: hl, ["--rm-speech" as string]: `${Math.round(speechW * 1000) / 10}%`, ["--rm-speech-h" as string]: `${Math.round(speechH * 1000) / 10}%`, ["--rm-side" as string]: `${sideW}px` }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); void openFile(f); } }}>

      {/* ------------------------------------------------------------ the ribbon */}
      <div className={"rm-rib v2" + (ribSmall ? " slim" : "")} role="toolbar" aria-label="coda">
        {/* the bar: where you are, the one box for everything, and how you are looking at it */}
        <div className="rm-bar">
          {desktop
            ? <span className="rm-home" aria-label="coda">{I.coda}<span>coda</span></span>
            : <Link className="rm-home" href="/" title="coda — home" aria-label="coda — home">{I.coda}<span>coda</span></Link>}
          <div className="rm-tbox">
            {mode === "speech" && <span className="rm-fname fixed" title="The speech doc — Split or Edit for your files">Speech doc</span>}
            {curTheirs && mode !== "speech" && (isTemp(cur!.id)
              ? <span className="rm-badge" title="Library blocks, opened as a page: edits save to those blocks in the library search, not to your files. Keep as mine makes it a file">Library</span>
              : <span className="rm-badge" title="A doc of theirs — kept apart from your library">Theirs</span>)}
            <input className="rm-fname" hidden={mode === "speech"} value={name} style={{ width: `${Math.min(Math.max(name.length, 6), 90) + 1}ch` }} onChange={(e) => setName(e.target.value)} aria-label="File name" spellCheck={false}
              onBlur={(e) => void rename(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); view.current?.focus(); } if (e.key === "Escape") { setName(cur?.name || ""); view.current?.focus(); } }} />
            <span className={"rm-state " + state}>{state === "saved" ? "Saved" : state === "saving" ? "Saving…" : "Editing"}<i>·</i>{docStat.cards} card{docStat.cards === 1 ? "" : "s"}</span>
          </div>
          <button type="button" className="rm-cmdbtn" onClick={() => run("palette")} aria-label="Search, or run a command" aria-keyshortcuts={K("palette") || undefined}>
            {I.search}<span>Search, or run a command</span>{K("palette") && <kbd>{K("palette")}</kbd>}
          </button>
          <div className="rm-modes" role="group" aria-label="View">
            <button type="button" aria-pressed={mode === "edit"} onClick={() => setMode("edit")} data-tip={"Just the file"}>Edit</button>
            <button type="button" aria-pressed={mode === "split"} onClick={() => setMode("split")} data-tip={tip("mode-split", "The speech doc beside")} className={sentPulse && mode !== "split" && mode !== "speech" ? "pulse" : ""} key={"s" + sentPulse}>Split</button>
            <button type="button" aria-pressed={mode === "speech"} onClick={() => setMode("speech")} data-tip={tip("mode-speech", "Just the speech doc")}>Speech</button>
            <button type="button" aria-pressed={mode === "flow"} onClick={() => setMode("flow")} data-tip={tip("mode-flow", "Flow the round")}>Flow</button>
          </div>
          <div className="rm-acts">
            <button type="button" className={"rm-b rm-share rm-menubtn" + (cur?.share && !curTheirs ? " on" : "")} aria-expanded={menu?.id === "share"}
              data-tip={cur?.share ? "Shared — the link, and who is in it" : "Share this file: a link your partner opens to edit it with you"} aria-label="Share this file"
              onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("share", e)}>
              {I.share}<span>{cur?.share && !curTheirs ? (curShare?.mates.length ? `Shared · ${curShare.mates.length + 1}` : "Shared") : "Share"}</span>
            </button>
            <button type="button" className="rm-b rm-room rm-menubtn" data-tip="Room — share the speech doc with your partner" aria-expanded={menu?.id === "room"}
              onMouseDown={(e) => e.preventDefault()} onClick={(e) => openRoomPanel(e)}>
              <span className="dot" id="roomdot" /><span id="roomstate">Room</span>
            </button>
            {/* a newer coda (the app): only there when there is one */}
            {update && (
              <button type="button" className="rm-b rm-update" disabled={updating !== null} onClick={() => void installUpdate()}
                data-tip={"coda " + update.version + " — downloads, installs and starts again; your files stay"}>
                {updating === null ? "Update" : updating < 1 ? `Updating ${Math.round(updating * 100)}%` : "Restarting…"}
              </button>
            )}
            {/* AI at work: beside its button, small; the whole step on hover */}
            {aiRun && (
              <span className="rm-aibusy" role="status" title={aiRun.label + (aiRun.of ? ` · ${aiRun.done} of ${aiRun.of}` : "")}>
                <span className="lb">{aiRun.label}{aiRun.of ? ` · ${aiRun.done}/${aiRun.of}` : "…"}</span>
                <button type="button" aria-label="Stop the AI" onMouseDown={(e) => e.preventDefault()} onClick={() => aiStop.current?.abort()}>{I.x}</button>
              </span>
            )}
            <button type="button" className={"rm-b rm-i rm-menubtn rm-aibtn" + (menu?.id === "ai" || aiRun ? " on" : "") + (aiRun ? " busy" : "")} data-tip={aiK ? "AI — cite from link, reformat, rehighlight for indicts, find blocks" : "AI — add your Anthropic key to use it"} aria-label="AI" aria-expanded={menu?.id === "ai"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("ai", e)}>{I.spark}</button>
            <button type="button" className={"rm-b rm-i" + (timer.open ? " on" : "")} data-tip={tip("timer", "Speech timer")} aria-label="Speech timer" aria-pressed={timer.open} onClick={() => run("timer")}>{I.timer}</button>
            <button type="button" className={"rm-b rm-i rm-menubtn rm-palbtn" + (menu?.id === "palette" ? " on" : "")} data-tip={"Colours and layout" + (K("layout") ? " · " + K("layout") + " next layout" : "")} aria-label="Colours and layout" aria-expanded={menu?.id === "palette"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("palette", e)}>
              {I.theme}
            </button>
            <button type="button" className={"rm-b rm-i" + (full ? " on" : "")} data-tip={full ? "Leave full screen" : "Full screen — every key is yours"} aria-label="Full screen" onClick={toggleFull}>{I.full}</button>
            <button type="button" className={"rm-b rm-me rm-menubtn web-only" + (menu?.id === "me" ? " on" : "")} data-tip={me ? me + " — home, the tutorial, sign out" : "Home, the tutorial, sign out"} aria-label="You" aria-expanded={menu?.id === "me"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("me", e)}>
              <i aria-hidden="true">{(me?.trim()[0] || "·").toUpperCase()}</i>
            </button>
            {ribSmall && (
              <>
                <button type="button" className={"rm-b rm-i rm-menubtn rm-pagesbtn" + (menu?.id === "pages" || many ? " on" : "")} data-tip="Pages — the read view beside you, two places in a file, another file beside" aria-label="Pages" aria-expanded={menu?.id === "pages"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("pages", e)}>{I.pages}</button>
                <button type="button" className={"rm-b rm-i rm-menubtn" + (menu?.id === "all" ? " on" : "")} data-tip="Every button" aria-label="Every button" aria-expanded={menu?.id === "all"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("all", e)}>{I.more}</button>
              </>
            )}
          </div>
        </div>

        {/* the format bar: the buttons a card is cut with, and nothing else */}
        {!ribSmall && (
          <div className="rm-fmt">
            <div className="rm-fmtin" role="group" aria-label="Formatting">
              <div className="rm-fg" role="group" aria-label="Headings">
                <B id="pocket"><span className="s-pocket">Pocket</span></B>
                <B id="hat"><span className="s-hat">Hat</span></B>
                <B id="block"><span className="s-block">Block</span></B>
                <B id="tag"><span className="s-tag">Tag</span></B>
                <B id="cite"><span className="s-cite">Cite</span></B>
              </div>
              <div className="rm-fg" role="group" aria-label="Cutting">
                <B id="underline"><span className="s-u">Cut</span></B>
                <B id="emphasis"><span className="s-emph">Emphasis</span></B>
                <B id="shrink"><span className="s-big">A</span><span className="s-small">a</span></B>
                <span className="rm-split2">
                  <B id="highlight"><span className="rm-sw" /><span className="lbl">Highlight</span></B>
                  <button type="button" className={"rm-b rm-menubtn rm-car" + (menu?.id === "hl" ? " on" : "")} data-tip="Highlighter colour" aria-label="Highlighter colour" aria-expanded={menu?.id === "hl"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("hl", e)}>▾</button>
                </span>
                <B id="clear">Clear</B>
              </div>
              <div className="rm-fg" role="group" aria-label="Card">
                <B id="send" cls="send"><span className="rm-sendic">{I.send}</span><span>Send</span></B>
                <B id="reformat"><span className="s-reformat">Reformat</span></B>
                <B id="new-card" cls="rm-i" label="New card">{I.plus}</B>
              </div>
              <div className="rm-fg" role="group" aria-label="History">
                <B id="undo" cls="rm-i" label="Undo · Ctrl+Z">{I.undo}</B>
                <B id="redo" cls="rm-i" label="Redo · Ctrl+Y">{I.redo}</B>
              </div>
              <div className="rm-fg" role="group" aria-label="More">
                <button type="button" className={"rm-b rm-menubtn rm-pagesbtn" + (menu?.id === "pages" || many ? " on" : "")} data-tip="Pages — the read view beside you, two places in a file, another file beside" aria-expanded={menu?.id === "pages"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("pages", e)}>{I.pages}<span className="lbl">Pages</span></button>
                <button type="button" className={"rm-b rm-i rm-menubtn" + (menu?.id === "all" ? " on" : "")} data-tip="Every button — analytic, reference, condense, the library, this file" aria-label="Every button" aria-expanded={menu?.id === "all"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => openMenu("all", e)}>{I.more}</button>
              </div>
            </div>
          </div>
        )}
        <input ref={fileIn} type="file" accept=".docx,.html,.htm,.txt,.pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void openFile(f); }} />
        <input ref={theirIn} type="file" accept=".docx,.pdf,.html,.htm,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void openTheirFile(f); }} />
      </div>

      <div className="rm-body">
        {/* ------------------------------------------------------------ the side */}
        <aside className="rm-side" aria-label="Sidebar">
          <div className="rm-shead" role="tablist">
            <button type="button" role="tab" className="rm-tabbtn" aria-selected={tab === "outline"} onClick={() => setTab("outline")}>Outline</button>
            <button type="button" role="tab" className="rm-tabbtn" aria-selected={tab === "files"} onClick={() => setTab("files")}>Files</button>
            <button type="button" role="tab" className="rm-tabbtn tb-search" aria-selected={tab === "search"} onClick={focusLibrary} title={tip("library")}>Search</button>
            <button type="button" role="tab" className="rm-tabbtn" aria-selected={tab === "round"} onClick={() => setTab("round")}>Round</button>
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
                  onClick={() => { const v = target(); if (v) goPos(v, headPos(i)); }}
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
              <button type="button" onClick={() => void create("Untitled file")} title={tip("new-file", "New file")}>{I.plus}New file</button>
              <button type="button" onClick={() => fileIn.current?.click()} disabled={busy}>{I.file}{busy ? "Opening…" : "Open .docx"}</button>
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
            {clAsk && (
              <form className="rm-cllogin" onSubmit={(e) => { e.preventDefault(); void clSignIn(); }}>
                <b>Sign into openCaselist</b>
                <p>The caselist is searched as you, with your own openCaselist account — your Tabroom email and password. coda keeps the sign-in on this computer for two weeks; your password isn&apos;t kept.</p>
                <input type="email" autoComplete="username" placeholder="Tabroom email" value={clAsk.user} autoFocus spellCheck={false} aria-label="Tabroom email"
                  onChange={(e) => setClAsk({ ...clAsk, user: e.target.value })} />
                <input type="password" autoComplete="current-password" placeholder="Password" value={clAsk.pass} aria-label="Tabroom password"
                  onChange={(e) => setClAsk({ ...clAsk, pass: e.target.value })} onKeyDown={(e) => { if (e.key === "Escape") setClAsk(null); }} />
                {clAsk.err && <p className="bad">{clAsk.err}</p>}
                <div className="row">
                  <button type="submit" className="pri" disabled={clAsk.busy}>{clAsk.busy ? "Signing in…" : "Sign in"}</button>
                  <button type="button" onClick={() => setClAsk(null)}>Not now</button>
                </div>
              </form>
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
            <div className="rm-sfoot rm-sfoot1" title="Click a card to send it; click a block to open it. ↑↓ move, → opens a block, ← folds it.">
              <b>Click</b> or <b>Enter</b> sends a card · <b>Shift+Enter</b> into your file · <b>Ctrl+Enter</b> opens it
            </div>
          </div>

          {/* the round: their docs, SpeechDrop, your partner */}
          <div className="rm-tabpane tp-round" hidden={tab !== "round"}>
            {desktop && <p className="rm-sempty rm-webnote">SpeechDrop and the caselist need the internet; the rest of coda doesn&apos;t. Your partner&apos;s app on the same Wi-Fi connects straight to yours, internet or not. Your partner&apos;s Google Doc is in coda on the web.</p>}
            <div className="rm-rsec web-only">
              <div className="rm-cap">PARTNER&apos;S FLOW · GOOGLE DOC</div>
              <form className="rm-sdform" onSubmit={(e) => { e.preventDefault(); gfWatch(); }}>
                <input value={gfLink} onChange={(e) => { setGfLink(e.target.value); if (gfOn) setGfOn(false); }} placeholder="Link to their Google Doc" spellCheck={false} aria-label="Your partner's Google Doc" />
                <button type="submit" disabled={!gfLink.trim()}>{gfOn ? "↻" : "OPEN"}</button>
              </form>
              {!gConn && !desktop && (
                <button type="button" className="rm-gbtn rm-gcheckbtn" onClick={() => void gConnect()} title="Sign in with Google so what you write in the flow goes into the Doc by itself">
                  <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6c1.9-5.6 7.1-9.8 13.6-9.8z" /><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" /><path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.8-6z" /><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.5 0-11.7-4.2-13.6-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z" /></svg>
                  {gExpired ? "RECONNECT GOOGLE" : "CONNECT GOOGLE"}
                </button>
              )}
              {gfOn ? (
                <p className="rm-sempty">
                  {gf?.err ? <span className="bad">{gf.err}</span> : gf ? <>Open in its own panel</> : "Reading it…"}
                  {" "}<button type="button" className="rm-linkbtn" onClick={() => setGfShow((s) => !s)}>{gfShow ? "HIDE" : "SHOW"}</button>
                  <button type="button" className="rm-linkbtn" onClick={() => { setGfOn(false); setGf(null); }}>CLOSE</button>
                </p>
              ) : <p className="rm-sempty">{desktop
                ? <>Paste the link to the flow tab (it ends <b>?tab=t.…</b>), shared <b>Anyone with the link</b>. It opens as tables, read only — <b>COPY FOR DOCS</b> puts what you write on the clipboard to paste back. (Writing straight into the Doc needs Google, which signs in only in the browser.)</>
                : gConn
                ? <>Paste any link to the Doc — its tab called <b>flow</b> is found by itself. You need to be able to edit it (your partner shares it with you).</>
                : <><b>Connect Google</b> and the table writes into the Doc as you type, and finds the <b>flow</b> tab by itself. Without it: the flow tab&apos;s link (it ends <b>?tab=t.…</b>), shared <b>Anyone with the link</b>, read only — <b>COPY FOR DOCS</b> to paste it back.</>}</p>}
            </div>
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
                    <button type="button" className="rm-fopen" onClick={() => void openSolo(THEIRS + m.id, (v) => v.focus())}>
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
          <div className="rm-work" ref={workBox}>
            <div className="rm-panes" ref={panesBox}>
              {panes.map((p, i) => {
                const v = views.current.get(p.key);
                const words = p.read && v ? readWords(v.state.doc) : 0;
                const tempHere = isTemp(p.fileId);
                const theirsHere = isTheirs(p.fileId) || tempHere;
                const meta = theirsHere && !tempHere ? theirFor(p.fileId) : null;
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
                        <span className={theirsHere ? "rm-acc2" : "rm-acc"}>{tempHere ? "LIBRARY" : theirsHere ? (meta?.source === "library" || meta?.source === "caselist" ? "CARD" : "THEIRS") : p.read ? "READ" : "FILE"}</span>
                        <select className="rm-psel" value={p.fileId} onChange={(e) => void setPaneFile(p.key, e.target.value)} aria-label="What this page shows">
                          <optgroup label="Your files">{files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</optgroup>
                          {!!theirs.length && <optgroup label="Their docs">{theirs.map((m) => <option key={m.id} value={THEIRS + m.id}>{m.name}</option>)}</optgroup>}
                          {tempHere && <optgroup label="Library"><option value={p.fileId}>{loaded.current.get(p.fileId)?.name || "Library blocks"}</option></optgroup>}
                        </select>
                        {tempHere && <span className="rm-pmeta" title="Edits save to these blocks in the library search — not to your files. Keep as mine makes it a file">SAVES TO THE LIBRARY</span>}
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

            {layoutMode === "twin" && (
              <section className="rm-pane rm-twin" aria-label="The speech doc, a second look">
                <div className="rm-phead">
                  <span className="rm-acc">SECOND LOOK</span>
                  <b>Speech doc</b>
                  <div className="rm-pmode" role="group" aria-label="Show it">
                    <button type="button" aria-pressed={twinView === "verbatim"} onClick={() => setTwinView("verbatim")}>VERBATIM</button>
                    <button type="button" aria-pressed={twinView === "tags"} onClick={() => setTwinView("tags")}>TAGS</button>
                  </div>
                  <span className="rm-pmeta">{twinWords} WORDS{twinWords ? ` · ${readTime(twinWords).toUpperCase()}` : ""}</span>
                </div>
                <div className="rm-scroll"><div className={"rm-col" + (twinView === "verbatim" ? " verb" : "")}><div ref={twinBox} /></div></div>
              </section>
            )}
            <div className="rm-ssplit" role="separator" aria-orientation="vertical" aria-label="Resize the speech doc" onPointerDown={dragSpeech}
              onDoubleClick={() => { if (layoutMode === "stack") setSpeechH(.42); else setSpeechW(.46); }} title="Drag to resize · double-click to reset" />
            {/* the speech doc: Evidence's send doc, its editor, its outline */}
            <section className={"evi withdoc rm-speech" + (headsOf === "speech" && mode === "split" ? " active" : "")} ref={speechBox} aria-label="Speech doc">
              <div className="rm-phead speech">
                <span className="rm-acc">SPEECH</span>
                <b>Speech doc</b>
                <span className="rm-pmeta" id="sendCount" title="Blocks sent to it" />
                <span className="rm-grow" />
                <button type="button" className={"rm-pbtn" + (speechVerb ? " on" : "")} aria-pressed={speechVerb} onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { inSpeech.current = true; toggleVerb(); }} title={tip("verbatim", "Verbatimise the speech doc: just what you'll read")}>VERBATIM</button>
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

          {/* Flow: always there, so what you send reaches the round even from Edit or Split; drawn in Flow mode */}
          <MagicFlow owner={owner ?? null} shown={mode === "flow"} wpm={wpm} toast={toast} who={me || ""} showSide={!side && !focusLayout ? () => setSide(true) : undefined}
            speechOutline={flowSpeechOutline} fileOutline={flowFileOutline} answer={flowAnswer} />
        </div>
      </div>

      {/* ------------------------------------------------------------ the status line */}
      <footer className="rm-status">
        <span className="rm-crumb">{headsOf === "speech" ? "Speech doc" : cur?.name || ""}{crumb ? " › " + crumb : ""}</span>
        <span className="rm-grow" />
        {docStat.cards > 0 && <span>Card {Math.max(cardNo, 0)} of {docStat.cards}</span>}
        <span>{docStat.read.toLocaleString()} words to read · <b className="rm-accent">{clock((docStat.read / Math.max(60, wpm)) * 60)}</b> at {wpm} wpm</span>
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
          {([["DARK", PALETTES.filter((p) => !LIGHT_PALETTES.has(p.id))], ["LIGHT", PALETTES.filter((p) => LIGHT_PALETTES.has(p.id))]] as const).map(([group, list]) => (
          <Fragment key={group}>
          <h4>{group}</h4>
          <div className="rm-pals">
            {list.map((p) => (
              // the menu stays open: try one after another, and see each on the whole tool
              <button key={p.id} type="button" role="menuitemradio" aria-checked={palette === p.id} className="rm-mb lay" onClick={() => setPalette(p.id)}>
                <span className="rm-palpic" aria-hidden="true" style={{ background: p.chrome }}><i style={{ background: p.side }} /><i style={{ background: "#fff" }} /><b style={{ background: p.acc }} /></span>
                <span className="rm-lt"><b>{p.name}</b><small>{p.sub}</small></span>
                {palette === p.id && <span className="k">✓</span>}
              </button>
            ))}
          </div>
          </Fragment>
          ))}
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
              <div className="rm-mnote top">Share “{cur.name}” and it has a link. Whoever opens the link — on coda&apos;s site or in the app — is in the file with you: you both type in it at once, see each other&apos;s cursor, and it is there for each of you whether or not the other is.</div>
              <button type="button" className="rm-mb pri" disabled={busy} onClick={() => { void startShare(cur.id); }}>{busy ? "Sharing…" : "Share it, and copy the link"}</button>
            </>
          ) : (
            <>
              <label className="rm-linkrow">
                <input readOnly value={shareLink(cur.share)} onFocus={(e) => e.currentTarget.select()} aria-label="The link" spellCheck={false} />
                <button type="button" onClick={() => void copyLink(cur.share!)}>COPY</button>
              </label>
              <div className="rm-who">
                <span><i style={{ background: "var(--acc)", color: "var(--on-acc)" }}>{(me?.[0] || "Y").toUpperCase()}</i>You</span>
                {(curShare?.mates || []).map((m) => <span key={m.client}><i style={{ background: m.color }}>{(m.name[0] || "?").toUpperCase()}</i>{m.name}</span>)}
                {!curShare?.mates.length && <em>{curShare?.status === "error" ? "Not connected right now" : "Nobody else is in it right now"}</em>}
              </div>
              <div className="rm-mnote">Anyone with the link can open and edit it. It saves by itself, for everyone.</div>
              {curShare?.mine
                ? <button type="button" className="rm-mb" onClick={() => { setMenu(null); if (window.confirm(`Stop sharing “${cur.name}”? The link stops working; everyone keeps the copy they have.`)) void unshare(cur.id, "stop"); }}>Stop sharing</button>
                : <button type="button" className="rm-mb" onClick={() => { setMenu(null); void unshare(cur.id, "leave"); }}>Leave it — keep a copy of my own</button>}
            </>
          )}
          <div className="rm-sep" />
          <h4>OPEN A SHARED FILE</h4>
          <label className="rm-linkrow">
            <input value={linkIn} placeholder="Paste its link" spellCheck={false} aria-label="A shared file's link"
              onChange={(e) => setLinkIn(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") openPasted(); }} />
            <button type="button" disabled={!linkIn.trim()} onClick={openPasted}>OPEN</button>
          </label>
          <div className="rm-sep" />
          <h4>THE SPEECH DOC</h4>
          <button type="button" className="rm-mb" onClick={() => openRoomPanel()}>Room — one speech doc for you and your partner…</button>
        </div>
      )}
      {menu?.id === "room" && (
        <div className="rm-menu wide rm-sharemenu rm-roommenu" style={menuAt(menu)} role="dialog" aria-label="Room">
          <h4>ROOM · THE SPEECH DOC</h4>
          {!roomInfo?.code ? (
            <>
              <div className="rm-mnote top">One speech doc for you and your partner: either of you can send a card, cut, reorder or type in it, and the other sees it as it happens. Use the code from your Flow. If the room already has a speech doc you take it, and cards you had sent are added.</div>
              <label className="rm-field"><span>You are</span>
                <input value={roomNameIn} maxLength={24} placeholder="Your name" onChange={(e) => setRoomNameIn(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") joinRoomNow(); }} />
              </label>
              <label className="rm-field"><span>Code{roomInfo?.suggested && roomCodeIn === roomInfo.suggested ? <small>from your flow</small> : null}</span>
                <input className="code" value={roomCodeIn} maxLength={8} placeholder="ABCDE" spellCheck={false} autoFocus
                  onChange={(e) => setRoomCodeIn(tidyCode(e.target.value))} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") joinRoomNow(); }} />
              </label>
              <button type="button" className="rm-mb pri" disabled={tidyCode(roomCodeIn).length < 4} onClick={joinRoomNow}>Join the room</button>
              <button type="button" className="rm-mb" onClick={() => setRoomCodeIn(newCode(5))}>New code<small>start a room, then read it out</small></button>
            </>
          ) : (
            <>
              <label className="rm-linkrow">
                <input readOnly value={roomInfo.code} className="code" onFocus={(e) => e.currentTarget.select()} aria-label="The room's code" spellCheck={false} />
                <button type="button" onClick={() => { void navigator.clipboard?.writeText(roomInfo.code).then(() => toast("Code copied")).catch(() => toast("Couldn't copy — it's " + roomInfo.code)); }}>COPY</button>
              </label>
              <div className="rm-who">
                <span><i style={{ background: "var(--acc)", color: "var(--on-acc)" }}>{((roomInfo.name || me || "Y")[0] || "Y").toUpperCase()}</i>You</span>
                {roomInfo.mates.map((m, i) => <span key={"m" + i}><i style={{ background: m.color }}>{(m.name[0] || "?").toUpperCase()}</i>{m.name}</span>)}
                {roomInfo.flows.filter((f) => !roomInfo.mates.some((m) => m.name === f.name)).map((f, i) => <span key={"f" + i}><i style={{ background: "var(--mut)" }}>{(f.name[0] || "?").toUpperCase()}</i>{f.name}<em>{f.kind === "viewer" ? "reading" : "flowing"}</em></span>)}
              </div>
              <div className="rm-mnote">{roomInfo.status === "error" ? "Can't reach the room right now — it keeps trying."
                : roomInfo.mates.length ? "One speech doc: either of you can send, cut, reorder and type in it."
                : roomInfo.flows.length ? "They see every change to your speech doc as you make it."
                : "Waiting for your partner. Give them the code, or have them join from their Flow."}</div>
              <button type="button" className="rm-mb" onClick={() => { (window as any).EV?.leaveRoom(); setMenu(null); }}>Leave the room<small>the speech doc stays here as yours</small></button>
            </>
          )}
        </div>
      )}
      {menu?.id === "speech" && (
        <div className="rm-menu" style={menuAt(menu)} role="menu">
          <h4>THE SPEECH DOC</h4>
          <button type="button" className="rm-mb" data-act="format" onClick={() => setMenu(null)} title="Title it, drop the analytics, renumber, take out the white space">Format for sending…</button>
          <button type="button" className="rm-mb" data-act="copySend" onClick={() => setMenu(null)}>Copy it</button>
          <button type="button" className="rm-mb" onClick={() => { setMenu(null); speechApi.current?.saveDocx(); }}>Download as .docx</button>
          <button type="button" className="rm-mb" onClick={() => { setMenu(null); speechApi.current?.speechDrop(); }}>Send to SpeechDrop…</button>
          {!desktop && (
          <button type="button" className="rm-mb" disabled={gSending} onClick={() => { setMenu(null); void sendToGoogle(); }}
            title="Into your partner's Google Doc: a “speech doc” tab, and inside it “(rhetoric speech doc)” verbatimised — each send replaces them">
            {gSending ? "Sending to the Google Doc…" : "Send to the Google Doc"}<span className="k">{gConn ? "" : "connect first"}</span></button>
          )}
          <div className="rm-sep" />
          <button type="button" className="rm-mb" data-act="docReset" onClick={() => setMenu(null)} title="Throw away what was written in it and build it again from the cards sent">Rebuild from the cards sent</button>
          <button type="button" className="rm-mb" data-act="clearSend" onClick={() => setMenu(null)}>Clear it</button>
          <div className="rm-mnote">It edits like any page: every ribbon button and key works in it — Reformat, Clean up, Condense, the headings, move up and down.</div>
        </div>
      )}
      {menu?.id === "me" && (
        <div className="rm-menu" style={menuAt(menu)} role="menu">
          {me && <h4>{me.toUpperCase()}</h4>}
          <a className="rm-mb" role="menuitem" href="/">Home</a>
          <a className="rm-mb" role="menuitem" href="/tools/tutorial" target="_blank" rel="noopener">The tutorial</a>
          <button type="button" className="rm-mb" role="menuitem" onClick={() => { setMenu(null); setKeysOpen(true); setKeyNote(""); }}>Keys and cite format</button>
          {!desktop && <a className="rm-mb" role="menuitem" href="/download" target="_blank" rel="noopener">Get the desktop app</a>}
          <div className="rm-sep" />
          <button type="button" className="rm-mb" role="menuitem" onClick={async () => { setMenu(null); await flush(true); await signOutOfCoda(); window.location.assign("/"); }}>Sign out</button>
        </div>
      )}
      {menu?.id === "ai" && (
        <div className="rm-menu" style={menuAt(menu)} role="menu">
          <h4>AI · CLAUDE HAIKU</h4>
          <button type="button" className="rm-mb" role="menuitem" onClick={() => aiOpen("cite")}>Cite from link…<span className="k">{K("ai-cite")}</span></button>
          <button type="button" className="rm-mb" role="menuitem" onClick={() => aiOpen("reformat")}>Reformat with AI<span className="k">{K("ai-reformat")}</span></button>
          <button type="button" className="rm-mb" role="menuitem" onClick={() => aiOpen("indict")}>Rehighlight for indicts<span className="k">{K("ai-indict")}</span></button>
          <button type="button" className="rm-mb" role="menuitem" onClick={() => aiOpen("blocks")}>Find blocks…<span className="k">{K("ai-blocks")}</span></button>
          <div className="rm-sep" />
          <button type="button" className="rm-mb" role="menuitem" onClick={() => aiOpen("settings")}>AI settings…<span className="k">{aiK ? "key added" : "no key yet"}</span></button>
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
      {menu?.id === "all" && (() => {
        // every button, as one even list: a mark, the name, the key. Picking one does it and closes the panel.
        const row = (id: string, label: string, go: (e: React.MouseEvent<HTMLElement>) => void, mark?: React.ReactNode, key?: string, extra?: Record<string, string>) => (
          <button key={id} type="button" role="menuitem" className="rm-arow" onMouseDown={(e) => e.preventDefault()} onClick={go} {...(extra || {})}>
            <span className="ic">{mark}</span><span className="lb">{label}</span>{key ? <kbd>{key}</kbd> : null}
          </button>
        );
        const act = (id: string, mark?: React.ReactNode, label?: string) =>
          row(id, label || ACTION.get(id)?.label || id, () => { runRef.current(id); setMenu(null); }, mark, K(id));
        const gl = (cls: string, t: string) => <span className={"gl " + cls}>{t}</span>;
        const dl = () => {
          setMenu(null);
          const fid = viewFile.current.get(activeRef.current);
          if (fid && !isTheirs(fid) && !isTemp(fid)) void download(fid);
          else toast(fid && isTemp(fid) ? "Keep as mine first — then it downloads" : "Their docs download from where they came from — or keep it as yours first");
        };
        return (
          <div className="rm-menu rm-allpop v2" style={menuAt(menu)} role="menu" aria-label="Every button">
            <section><h4>File</h4><div className="rm-arows">
              {row("open", "Open a file…", () => { setMenu(null); fileIn.current?.click(); }, I.folder)}
              {act("new-file", I.newfile)}
              {row("download", "Download as .docx", dl, I.down)}
              {row("keys", "Keys and cite format", () => { setMenu(null); setKeysOpen(true); setKeyNote(""); }, I.keys)}
            </div></section>
            <section><h4>Styles</h4><div className="rm-arows">
              {act("pocket", gl("box", "P"))}
              {act("hat", gl("u", "H"))}
              {act("block", gl("bu", "B"))}
              {act("tag", gl("b", "T"))}
              {act("analytic", gl("ana", "A"))}
              {act("cite", gl("b", "C"))}
            </div></section>
            <section><h4>Cut</h4><div className="rm-arows">
              {act("underline", gl("u", "U"))}
              {act("emphasis", gl("box b", "E"))}
              {act("shrink", gl("", "Aa"))}
              {act("highlight", <span className="rm-sw" />)}
              {row("hl-colour", "Highlight colour…", (e) => openMenu("hl", e), <span className="rm-sw" />)}
              {act("clear", gl("", "Tx"))}
              {act("condense", I.condense)}
              {act("condense-omitted", I.pilcrow, "None omitted")}
            </div></section>
            <section><h4>Card</h4><div className="rm-arows">
              {act("new-card", I.plus)}
              {act("send", I.send, "Send")}
              {act("reference", gl("ref", "R"))}
              {act("clean-up", gl("", "✓"))}
              {act("reformat", gl("fmt", "F"))}
              {act("new-extension", gl("b", "+"), "Extension")}
            </div></section>
            <section><h4>Move</h4><div className="rm-arows">
              {act("move-up", I.up)}
              {act("move-down", I.dn)}
              {row("undo", "Undo", () => { setMenu(null); runRef.current("undo"); }, I.undo, "Ctrl+Z")}
              {row("redo", "Redo", () => { setMenu(null); runRef.current("redo"); }, I.redo, "Ctrl+Y")}
            </div></section>
            <section><h4>Library</h4><div className="rm-arows">
              {row("import", "Import an evidence file…", () => setMenu(null), I.folder, undefined, { "data-act": "import" })}
              {row("case", "Your case…", () => setMenu(null), gl("", "◎"), undefined, { "data-act": "case" })}
              {row("export", "Export the library", () => setMenu(null), I.down, undefined, { "data-act": "export" })}
              {row("settings", "Library settings", () => setMenu(null), gl("", "⚙"), undefined, { "data-act": "settings" })}
            </div></section>
            <section className="web-only"><h4>Pop out · a window that stays on top</h4><div className="rm-arows">
              {row("popsend", "The speech doc", () => { setMenu(null); if (!popOut("send")) toast("The browser blocked the window — allow pop-ups for this site"); }, I.full)}
              {curTheirs && cur && !isTemp(cur.id) && row("popdoc", "Their doc", () => { setMenu(null); void flush().then(() => { if (!popOut("doc", { doc: cur.id.slice(THEIRS.length) })) toast("The browser blocked the window — allow pop-ups for this site"); }); }, I.full)}
            </div></section>
            <section><h4>Spelling{K("spelling") ? " · " + K("spelling") : ""}</h4><div className="rm-arows">
              {SPELL_MODES.map((m) => row("sp-" + m.id, m.name, () => { setSpell(m.id); setMenu(null); }, spell === m.id ? gl("on", "✓") : gl("", ""), undefined, { "aria-checked": String(spell === m.id), title: m.sub }))}
            </div></section>
            <section><h4>This file</h4><div className="rm-arows">
              {row("paste", "Paste as text", () => { setMenu(null); run("paste"); }, gl("", "¶"))}
              {act("page-break", gl("", "⤓"))}
              {row("save", "Save now", () => { setMenu(null); void flush(true); }, gl("", "↧"), K("save"))}
            </div></section>
          </div>
        );
      })()}
      {menu?.id === "more" && (
        <div className="rm-menu" style={menuAt(menu)} role="menu">
          <h4>LIBRARY</h4>
          <button type="button" className="rm-mb" data-act="import" onClick={() => setMenu(null)}>Import an evidence file…</button>
          <button type="button" className="rm-mb" data-act="case" onClick={() => setMenu(null)}>Your case…</button>
          <button type="button" className="rm-mb" data-act="export" onClick={() => setMenu(null)}>Export the library</button>
          <button type="button" className="rm-mb" data-act="settings" onClick={() => setMenu(null)}>Library settings</button>
          <div className="web-only">
          <div className="rm-sep" />
          <h4>POP OUT — A WINDOW THAT STAYS ON TOP</h4>
          <button type="button" className="rm-mb" onClick={() => { setMenu(null); if (!popOut("send")) toast("The browser blocked the window — allow pop-ups for this site"); }}>The speech doc</button>
          {curTheirs && cur && !isTemp(cur.id) && <button type="button" className="rm-mb" onClick={() => { setMenu(null); void flush().then(() => { if (!popOut("doc", { doc: cur.id.slice(THEIRS.length) })) toast("The browser blocked the window — allow pop-ups for this site"); }); }}>Their doc, “{cur.name}”</button>}
          </div>
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

      {aiFound && (
        <aside className={"rm-aidock" + (aiDockMin ? " min" : "")} aria-label="Answers to their argument">
          <div className="rm-aihead" role="button" tabIndex={0} aria-expanded={!aiDockMin} title={aiDockMin ? "Show the answers" : "Fold the answers away"}
            onMouseDown={(e) => e.preventDefault()} onClick={() => setAiDockMin((m) => !m)}>
            {I.spark}<b>Answers</b>
            <span className="rm-aicount">{aiFound.best.length + (aiFound.analytics || []).length + (aiFound.rehi?.length ? 1 : 0)}</span>
            <button type="button" className="rm-aix" aria-label={aiDockMin ? "Show the answers" : "Fold away"} onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); setAiDockMin((m) => !m); }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">{aiDockMin ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}</svg>
            </button>
            <button type="button" className="rm-aix" aria-label="Close" onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); setAiFound(null); }}>{I.x}</button>
          </div>
          <p className="rm-aiclaim" title={aiFound.claim}>{aiFound.claim}</p>
          <div className="rm-aifound">
            <ol className="rm-aians">
              {aiFound.best.map((p, i) => (
                <li key={i} className="rm-aians-i">
                  <div className="top">
                    <span className="part" title={p.says}>{p.kind}</span>
                    <span className={"how" + (/turn/i.test(p.how) ? " turn" : "")}>{p.how}</span>
                    {p.from === "library"
                      ? <button type="button" className="send" onMouseDown={(e) => e.preventDefault()} onClick={async () => { const EV = (window as any).EV; await EV?.quickSend?.(p.id, p.card === null ? undefined : p.card); toast("Sent: " + (p.cardTag || p.title)); }}>{p.card === null ? "Send block" : "Send"}</button>
                      : <button type="button" className="send" onMouseDown={(e) => e.preventDefault()} onClick={async () => { if (!p.raw) { showInCaselist(p.tag); return; } if (await sendCl(p.raw, p.team)) toast("Sent: " + p.tag); }}>Send</button>}
                  </div>
                  <b className="ttl">{p.from === "library" ? p.cardTag || p.title : p.tag}</b>
                  {p.quote && <q className="quote">{p.quote}</q>}
                  <p className="why">{p.why}</p>
                  <small className="src">{p.from === "library" ? [p.cardTag ? p.title : "", ...p.where.split(" › ")].filter(Boolean).join(" › ") : `Caselist › ${p.team} › ${p.cite}`}</small>
                </li>
              ))}
              {!aiFound.best.length && <li className="rm-aians-none">{(aiFound.caselist === "off" ? "No card in your library answers this, and the caselist isn't on: sign in to openCaselist (Search › Caselist) to look there too." : aiFound.caselist ? "No card in your library or the caselist answers this." : "No card in your library answers this.") + ((aiFound.analytics || []).length || aiFound.rehi?.length ? " Instead:" : "")}</li>}
              {!aiFound.best.length && !!aiFound.rehi?.length && (
                <li className="rm-aians-i">
                  <div className="top">
                    <span className="part">their cards</span>
                    <span className="how turn">Rehighlight</span>
                    <button type="button" className="send" onMouseDown={(e) => e.preventDefault()} onClick={async () => { const n = await sendRehighlights(aiFound.rehi || []); toast(n ? (n === 1 ? "Sent the rehighlight" : `Sent ${n} rehighlights`) : "The speech doc is still starting — a moment"); }}>Send</button>
                  </div>
                  <b className="ttl">{aiFound.rehi.map((r) => r.tag).join(" · ")}</b>
                  {(aiFound.rehiSays || []).map((x, k) => <p key={k} className="why">{x}</p>)}
                  <small className="src">A copy, their highlighting greyed and the indicts in cyan. Your file stays as it is.</small>
                </li>
              )}
              {aiFound.best.length > 0 && (aiFound.analytics || []).length > 0 && <li className="rm-aians-head">Analytics</li>}
              {(aiFound.analytics || []).map((a, k) => (
                <li key={"an" + k} className="rm-aians-i">
                  <div className="top">
                    {a.kind && <span className="part">{a.kind}</span>}
                    <span className={"how" + (/turn/i.test(a.how) ? " turn" : "")}>{a.how || "Analytic"}</span>
                    <button type="button" className="send" onMouseDown={(e) => e.preventDefault()} onClick={() => void sendAnalytics([a])}>{a.card && (a.card.from === "library" || a.card.raw) ? "Send with card" : "Send"}</button>
                  </div>
                  <b className="ttl">{a.text}</b>
                  {a.card ? (
                    <div className="rm-aiback">
                      <span className="lbl">Card</span>
                      <b>{a.card.from === "library" ? a.card.cardTag || a.card.title : a.card.tag}</b>
                      {a.card.quote && <q className="quote">{a.card.quote}</q>}
                      <small className="src">{a.card.from === "library" ? [a.card.cardTag ? a.card.title : "", ...a.card.where.split(" › ")].filter(Boolean).join(" › ") : `Caselist › ${a.card.team} › ${a.card.cite}`}</small>
                      {a.card.from === "caselist" && <button type="button" className="send" onMouseDown={(e) => e.preventDefault()} onClick={async () => { const c = a.card as any; if (!c.raw) { showInCaselist(c.tag); return; } if (await sendCl(c.raw, c.team)) toast("Sent: " + c.tag); }}>Send card</button>}
                    </div>
                  ) : <small className="src">Analytic: no card proves it</small>}
                </li>
              ))}
              {(aiFound.analytics || []).length > 1 && (
                <li className="rm-aians-all"><button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void sendAnalytics(aiFound.analytics || [])}>Send all {(aiFound.analytics || []).length} analytics{(aiFound.analytics || []).some((a) => a.card && (a.card.from === "library" || a.card.raw)) ? " with their cards" : ""}</button></li>
              )}
            </ol>
            {aiFound.best.length > 0 && aiFound.unanswered.length > 0 && <p className="rm-aiopen">Nothing answers their {aiFound.unanswered.join(" or ")}.</p>}
            <p className="rm-ainote">{aiFound.of ? `Read ${aiFound.read === aiFound.of ? "every block" : aiFound.read + " of " + aiFound.of + " blocks, the ones that use its words"} across all your bins. Send puts it where your cursor is.` : "Your library is empty: import blocks to search them."}</p>
          </div>
        </aside>
      )}
      {aiPanel && (
        <div className="rm-scrim top rm-palscrim" onPointerDown={(e) => { if (e.target === e.currentTarget) aiClose(); }} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); aiClose(); } }}>
          <div className="rm-pal rm-aipanel" role="dialog" aria-label={aiPanel.kind === "settings" ? "AI settings" : aiPanel.kind === "cite" ? "Cite from link" : "Find blocks"}>
            {aiPanel.kind === "settings" && (
              <form onSubmit={(e) => { e.preventDefault(); void aiSaveKey(); }}>
                <div className="rm-aihead">{I.spark}<b>AI settings</b><span>Claude Haiku 5.5</span></div>
                <p className="rm-ainote">coda&apos;s AI runs on your own Anthropic API key. It&apos;s kept on this computer for your account, and every request goes straight from here to Anthropic — coda never sees it. Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">console.anthropic.com</a>. A card costs a fraction of a cent.</p>
                <label className="rm-aifield"><span>API key</span>
                  <input type="password" value={aiPanel.draft} placeholder={aiK ? "A key is saved — paste a new one to replace it" : "sk-ant-…"} autoFocus spellCheck={false} autoComplete="off"
                    onChange={(e) => setAiPanel({ ...aiPanel, draft: e.target.value })} />
                </label>
                {aiPanel.msg && <p className={"rm-aimsg" + (aiPanel.bad ? " bad" : "")}>{aiPanel.msg}</p>}
                <div className="rm-airow">
                  <button type="submit" className="pri" disabled={aiPanel.busy}>{aiPanel.busy ? "Checking…" : "Save key"}</button>
                  {aiK && <button type="button" onClick={() => { setAiKey(owner, null); setAiK(""); setAiPanel({ ...aiPanel, msg: "Key removed.", bad: false }); }}>Remove key</button>}
                  <span className="rm-grow" />
                  <button type="button" onClick={aiClose}>Done</button>
                </div>
                <div className="rm-aiopts">
                  <b>Reformat with AI</b>
                  <label><input type="checkbox" checked={aiOpts.cutEnds} onChange={(e) => setAiOpts({ cutEnds: e.target.checked })} /> Cut a long unread stretch (35+ words) at the top or bottom of a card</label>
                  <label><input type="checkbox" checked={aiOpts.condense} onChange={(e) => setAiOpts({ condense: e.target.checked })} /> Condense unread paragraphs in the middle, none omitted</label>
                  <label><input type="checkbox" checked={aiOpts.trim} onChange={(e) => setAiOpts({ trim: e.target.checked })} /> Tighten highlighting for efficiency — every warrant kept</label>
                  <b>Rehighlight for indicts</b>
                  <label><input type="checkbox" checked={aiOpts.retag} onChange={(e) => setAiOpts({ retag: e.target.checked })} /> Rewrite the tag to say what the indicts prove</label>
                  <small>Cites are written in your cite format, under Keys. Model: {AI_MODEL}.</small>
                </div>
              </form>
            )}
            {aiPanel.kind === "cite" && (
              <form onSubmit={(e) => { e.preventDefault(); void aiCiteNow(); }}>
                <div className="rm-aihead">{I.spark}<b>Cite from link</b><span>{K("ai-cite")}</span></div>
                <label className="rm-palq">{I.search}
                  <input value={aiPanel.url} placeholder="Paste the article's link…" autoFocus spellCheck={false} aria-label="The article's link"
                    onChange={(e) => setAiPanel({ ...aiPanel, url: e.target.value, err: "" })} />
                  <kbd>Enter</kbd>
                </label>
                {aiPanel.err && <p className="rm-aimsg bad">{aiPanel.err}</p>}
                <p className="rm-ainote">Keep working while Claude writes it. It goes on the empty line you&apos;re on now, or the card&apos;s empty cite line, in your cite format: {citeFormat}</p>
              </form>
            )}
            {aiPanel.kind === "blocks" && (
              <form className="rm-aiwant" onSubmit={(e) => { e.preventDefault(); void aiBlocksNow(); }}>
                <div className="rm-aihead">{I.spark}<b>Find blocks</b><span>{K("ai-blocks")}</span></div>
                <textarea value={aiPanel.want} rows={6} autoFocus spellCheck={false} placeholder="Their argument: select their cards in the doc first, or paste them in" aria-label="Their argument"
                  onChange={(e) => setAiPanel({ ...aiPanel, want: e.target.value, err: "" })}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void aiBlocksNow(); } }} />
                {aiPanel.err && <p className="rm-aimsg bad">{aiPanel.err}</p>}
                <label className="rm-aicheck"><input type="checkbox" checked={aiOpts.analytics} onChange={(e) => setAiOpts({ analytics: e.target.checked })} /> Also write analytics, each with a card behind it where one proves it</label>
                <div className="rm-aifoot">
                  <span>Answers to its uniqueness, link and impact, from your cards and the caselist</span>
                  <button type="submit" className="pri">Find answers <kbd>Ctrl+Enter</kbd></button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
      {pal && (
        <div className="rm-scrim top rm-palscrim" onPointerDown={(e) => { if (e.target === e.currentTarget) { setPal(null); target()?.focus(); } }}>
          <div className="rm-pal" role="dialog" aria-label="Command menu">
            <label className="rm-palq">{I.search}
              <input ref={palIn} value={pal.q} placeholder="Search the library, open a file, or run a command…" spellCheck={false} aria-label="Search, or run a command"
                role="combobox" aria-expanded="true" aria-controls="rm-pal-list" aria-activedescendant={palItems[pal.sel] ? "rm-pal-" + pal.sel : undefined}
                onChange={(e) => setPal({ q: e.target.value, sel: 0 })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setPal(null); target()?.focus(); }
                  else if (e.key === "ArrowDown") { e.preventDefault(); setPal((p) => p && { ...p, sel: Math.min(palItems.length - 1, p.sel + 1) }); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setPal((p) => p && { ...p, sel: Math.max(0, p.sel - 1) }); }
                  else if (e.key === "Enter") { e.preventDefault(); const it = palItems[pal.sel]; if (it) palGo(it); }
                }} />
              <kbd>Esc</kbd>
            </label>
            <ul ref={palList} id="rm-pal-list" role="listbox" aria-label="Results">
              {!pal.q.trim() && <li className="rm-palh" role="presentation">Suggested</li>}
              {palItems.map((it, n) => (
                <li key={it.id} id={"rm-pal-" + n} role="option" aria-selected={n === pal.sel} className={n === pal.sel ? "on" : ""}
                  onMouseMove={() => { if (pal.sel !== n) setPal((p) => p && { ...p, sel: n }); }}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => palGo(it)}>
                  <span className="ic">{it.icon}</span>
                  <span className="lt"><b>{it.label}</b><small>{it.sub}</small></span>
                  {it.key && <kbd>{it.key}</kbd>}
                </li>
              ))}
            </ul>
            <div className="rm-palfoot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span>Type anything to search the library</span></div>
          </div>
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

      {/* your partner's flow: a small panel that floats over everything — drag its top to move it, its corner to size it */}
      {gfOn && gfShow && (
        <div className="rm-gfpop" style={{ left: gfPos.x, top: gfPos.y, width: gfPos.w, height: gfPos.h }} role="dialog" aria-label="Your partner's flow">
          <div className="rm-gfbar" onPointerDown={gfDrag}>
            <b>FLOW</b>
            <span className={"dot" + (gConn ? " live" : "")} title={gConn ? "Connected to Google — what you write goes into the Doc" : "Read only — Connect Google in the Round tab to write into the Doc"} />
            <span className="t">{gf?.err ? <span className="bad">{gf.err}</span> : gf ? `${gfSince ?? 0}s` : "…"}</span>
            <span className="rm-grow" />
            <a href={`https://docs.google.com/document/d/${gdocId(gfLink)}/edit`} target="_blank" rel="noreferrer" title="Open the Doc in Google Docs" onPointerDown={(e) => e.stopPropagation()}>↗</a>
            <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setGfShow(false)} title="Hide (Round tab: SHOW brings it back)" aria-label="Hide the flow">–</button>
            <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => { setGfOn(false); setGf(null); }} title="Close it" aria-label="Close the flow">×</button>
          </div>
          <div className="rm-gfbody">
            {!gf && <p className="rm-gferr" style={{ color: "#777" }}>Reading the Doc…</p>}
            {(flowSections.length > 0 || (gf && !gf.err)) && <FlowTable compact sections={flowSections} docKey={gdocId(gfLink) + (gfTab ? ":" + gfTab : "")} owner={owner} onLook={lookFor} toast={toast} writer={gConn ? gWrite : undefined} onUnflow={unflow} />}
          </div>
          <div className="rm-gfsize" onPointerDown={gfResize} aria-hidden="true" />
        </div>
      )}
      {slash && <SlashFind at={slash.at} menu={slash.menu} onPick={(r) => void pickSlash(r)} onMenu={(m) => setSlash((s) => s && { ...s, menu: m })} />}
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

