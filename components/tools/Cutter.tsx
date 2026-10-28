"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { DOMParser as PMParser, DOMSerializer, type Node as PMNode } from "prosemirror-model";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { schema } from "@/lib/evidence/docSchema";
import { listFiles, getFile, putFile, dropFile, newFileId, type CutMeta, type CutFile } from "@/lib/cutter/store";
import * as C from "@/lib/cutter/commands";
import * as X from "@/lib/cutter/extensions";
import * as R from "@/lib/cutter/reference";
import { reformat } from "@/lib/cutter/reformat";
import { ACTIONS, ACTION, comboOf, keyLabel, keyFor, actionFor, bind, refuse, caveat, loadKeys, saveKeys, watchChords, type Overrides } from "@/lib/cutter/keys";
import { docxToHtml } from "@/lib/cutter/docxIn";
import { sanitize, readTime } from "@/lib/viewer/doc";
import { verbatimPlugin, verbKey, readWords, countIn } from "@/lib/cutter/verbatim";
import { buildSearch, searchCards } from "@/lib/caselist/search.js";
import { openBus, type Bus } from "@/lib/toolsBus";
import { scoped } from "@/lib/owner";
import { markHop } from "@/lib/toolsHop";
import ThemePicker from "./ThemePicker";
import Ico from "./Ico";
import { useFitBar } from "./fitBar";
import FullBtn, { useFullscreen } from "./FullBtn";
import "./docviewer.css";
import "./finish.css";
import "./cutter.css";

/**
 * Card cutter — cutting cards into files of your own, by key.
 *
 * Files are documents in a cut file's shape: pocket, hat, block, tag, and
 * under each tag its cite and the card. Every formatting move a card needs
 * is one key — Ctrl+Alt cut, Ctrl+N shrink, Alt+Z highlight and the rest
 * (lib/cutter/keys.ts) — and any of them can be moved. A double-click takes
 * the word and not the space after it, so a highlight stops where the word
 * does.
 *
 * The workspace is one page until you ask for more: up to three, side by
 * side, each any file, each to edit or to read (verbatimised). A file open
 * twice is one document — what you type in one page is in the other at once
 * — but each page scrolls on its own, so two places in one file can be in
 * view together. A read page follows the card being edited beside it, and a
 * click on a card in it brings the editing page there. With one page there
 * is no pane chrome at all; with more, each page has a thin line saying what
 * it shows. Layout (and Alt+R, Alt+V, Alt+S) is how pages come and go.
 *
 * Files save as you go, in this browser, and every one of them is searchable
 * from the side — by tag, cite, block, and the words that are read. They are
 * also Evidence's: each save tells Evidence, which reads the file into its
 * library like a pasted one (lib/evidence/engine.js, syncCutter), so a card
 * cut here is a card you can search and send there.
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

interface Head { level: number; text: string; pos: number }
/** One page of the workspace: which file, and whether it is for editing or reading. */
interface Pane { key: string; fileId: string; read: boolean; follow: boolean }

const MAX_PANES = 3;
let paneSeq = 0;
const newKey = () => "p" + (++paneSeq) + "_" + Date.now().toString(36);

/** The keys along the top of the page, the ones used most first. */
const STRIP = ["underline", "emphasis", "highlight", "shrink", "cite", "tag", "block", "hat", "pocket", "clear", "clean-up", "reformat", "condense", "new-extension", "reference"];
/** What only makes sense with the cursor in the document. */
const IN_DOC = new Set(["pocket", "hat", "block", "tag", "cite", "underline", "emphasis", "highlight", "clear", "shrink", "condense", "paste", "new-card", "move-up", "move-down", "new-extension", "analytic", "page-break", "clean-up", "reference", "insert-reference", "reformat"]);
/** What still works in a read page: reordering cards is fine in a read view. */
const IN_READ = new Set(["move-up", "move-down"]);

/** Ready-made layouts, each a picture and a name. */
const LAYOUTS = [
  { id: "one", name: "One page", sub: "Just the file", cols: ["e"] },
  { id: "read", name: "Page + read view", sub: "Verbatimised beside you, following your card", cols: ["e", "r"], key: "read-beside" },
  { id: "two", name: "Two places in one file", sub: "Same file, each page scrolled on its own", cols: ["e", "e"] },
  { id: "other", name: "Beside another file", sub: "Your cards on one side, the file you're writing on the other", cols: ["e", "o"] },
  { id: "write", name: "Write beside the cards", sub: "A new file for extensions, next to this one", cols: ["e", "n"] },
] as const;

export default function Cutter({ owner }: { owner?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);
  const qIn = useRef<HTMLInputElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const layoutBtn = useRef<HTMLButtonElement>(null);
  const panesBox = useRef<HTMLDivElement>(null);
  const bus = useRef<Bus | null>(null);

  // ---- the workspace: pages, the editor in each, and what each holds ---------------
  const views = useRef(new Map<string, EditorView>());       // pane key → its editor
  const viewFile = useRef(new Map<string, string>());        // pane key → the file its editor holds now
  const loaded = useRef(new Map<string, CutFile>());         // file id → its record (name, dates)
  const dirty = useRef(new Set<string>());                   // files changed since they were saved
  const refCbs = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const lastFollow = useRef(new Map<string, number>());
  /** The page being worked in — every key, the outline and the banner are about it. */
  const view = useRef<EditorView | null>(null);
  const [panes, setPanesState] = useState<Pane[]>([]);
  const panesRef = useRef<Pane[]>([]);
  const setPanes = useCallback((next: Pane[]) => { panesRef.current = next; setPanesState(next); }, []);
  const [activeKey, setActiveKey] = useState("");
  const activeRef = useRef("");
  const [widths, setWidths] = useState<number[]>([1]);
  const [side, setSide] = useState(true);
  const [layoutOpen, setLayoutOpen] = useState<{ x: number; y: number } | null>(null);
  const [tick, setTick] = useState(0);                       // a document changed somewhere (for the page lines)

  const [files, setFilesState] = useState<CutMeta[]>([]);
  const filesRef = useRef<CutMeta[]>([]);
  const setFiles = useCallback((u: CutMeta[] | ((l: CutMeta[]) => CutMeta[])) => {
    setFilesState((l) => { const n = typeof u === "function" ? u(l) : u; filesRef.current = n; return n; });
  }, []);
  const [cur, setCur] = useState<CutFile | null>(null);
  const curRef = useRef<CutFile | null>(null);
  curRef.current = cur;
  const [name, setName] = useState("");
  const [state, setStateTag] = useState<"saved" | "saving" | "dirty">("saved");
  const [heads, setHeads] = useState<Head[]>([]);
  // the words in what is selected, and how many of them are read
  const [selCount, setSelCount] = useState<{ words: number; read: number } | null>(null);
  const [at, setAt] = useState(-1);                       // the heading the cursor is under
  const [tab, setTab] = useState<"files" | "outline">("files");
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
  // how this account signs the cites Reformat rewrites
  const [sig, setSig] = useState("");
  const sigRef = useRef(sig);
  sigRef.current = sig;
  const hlRef = useRef(hl);
  hlRef.current = hl;
  const [toastMsg, setToastMsg] = useState<{ t: string; n: number } | null>(null);
  const [busy, setBusy] = useState(false);
  // finding a card to put in as a reference (Alt+Shift+G)
  const [refPick, setRefPick] = useState<{ q: string; sel: number } | null>(null);
  const refIn = useRef<HTMLInputElement>(null);
  const saveT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickT = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((t: string) => setToastMsg((m) => ({ t, n: (m?.n || 0) + 1 })), []);
  useEffect(() => { if (!toastMsg) return; const t = setTimeout(() => setToastMsg(null), 2600); return () => clearTimeout(t); }, [toastMsg]);

  const refused = useCallback(() => toast("This browser would not go full screen here"), [toast]);
  const { full, toggle: toggleFull } = useFullscreen(root, refused);
  useFitBar(bar);
  // Full screen, the page may have the keys Chrome otherwise keeps for itself
  // or hands to an extension first — Ctrl+N for a new window, or a Docs
  // hotkey extension's Ctrl+Space (the Keyboard Lock API; Chrome only). Every
  // key the cutter uses is locked, so they come here first.
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
      else if (/^F\d+$/.test(last)) codes.add(last);
    }
    kb.lock([...codes]).catch(() => {});
    return () => { try { kb.unlock(); } catch { /* gone */ } };
  }, [full, keys]);

  // ---- preferences ---------------------------------------------------------
  useEffect(() => {
    setKeys(loadKeys(owner));
    try { const c = localStorage.getItem(scoped("cutter.hl", owner)); if (c) setHl(c); } catch { /* private */ }
    try { setSig(localStorage.getItem(scoped("cutter.sig", owner)) ?? ""); } catch { /* private */ }
  }, [owner]);
  useEffect(() => { try { localStorage.setItem(scoped("cutter.hl", owner), hl); } catch { /* private */ } }, [hl, owner]);

  // ---- small questions about the workspace ------------------------------------------
  const paneOf = (key: string) => panesRef.current.find((p) => p.key === key) || null;
  const isRead = (key: string) => !!paneOf(key)?.read;
  /** A page whose editor holds this file now, other than `except`. */
  const keyShowing = (fid: string, except?: string) => {
    for (const [k, f] of viewFile.current) if (f === fid && k !== except && views.current.has(k)) return k;
    return null;
  };
  const scrollerOf = (v: EditorView) => v.dom.closest(".ct-scroll") as HTMLElement | null;

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

  // ---- the outline and the banner follow the page being worked in -------------------
  const readHeads = useCallback(() => {
    const v = view.current;
    if (!v) return;
    const { from: sf, to: st, empty } = v.state.selection;
    const c = empty ? null : countIn(v.state.doc, sf, st);
    setSelCount(c && c.words ? c : null);
    const out: Head[] = [];
    v.state.doc.forEach((n, pos) => { if (n.type === schema.nodes.heading) out.push({ level: n.attrs.level, text: n.textContent.trim() || "(empty)", pos }); });
    setHeads(out);
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
    if (!key || activeRef.current === key) return;
    activeRef.current = key;
    setActiveKey(key);
    view.current = views.current.get(key) || null;
    syncActive();
  }, [syncActive]);

  // ---- saving: every changed file, whichever page it was changed in ----------------
  const chain = useRef<Promise<void>>(Promise.resolve());
  const flush = useCallback((loud = false) => {
    if (saveT.current) { clearTimeout(saveT.current); saveT.current = null; }
    chain.current = chain.current.then(async () => {
      const ids = [...dirty.current];
      const afid = viewFile.current.get(activeRef.current);
      if (afid && ids.includes(afid)) setStateTag("saving");
      for (const fid of ids) {
        dirty.current.delete(fid);
        const k = keyShowing(fid);
        const v = k ? views.current.get(k) : null;
        const base = loaded.current.get(fid);
        if (!v || !base) continue;
        const doc = v.state.doc;
        const next: CutFile = { ...base, doc: doc.toJSON(), html: toHtml(doc), cards: C.briefs(doc), words: countWords(doc), updated: Date.now() };
        try {
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
      const a = viewFile.current.get(activeRef.current);
      setStateTag(a && dirty.current.has(a) ? "dirty" : "saved");
      if (loud) toast("Saved — and in Evidence's search");
    });
    return chain.current;
  }, [owner, toast, setFiles]);
  const markDirty = useCallback((fid: string) => {
    dirty.current.add(fid);
    if (viewFile.current.get(activeRef.current) === fid) setStateTag("dirty");
    if (saveT.current) clearTimeout(saveT.current);
    saveT.current = setTimeout(() => { void flush(); }, 700);
  }, [flush]);
  // nothing lost on the way out
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
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos + 1)));
    v.focus();
    const dom = v.nodeDOM(pos) as HTMLElement | null;
    const sc = scrollerOf(v);
    if (dom && sc) {
      sc.scrollTo({ top: dom.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 24 });
      dom.classList.remove("ct-flash"); void dom.offsetWidth; dom.classList.add("ct-flash");
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
        // the same steps, as someone else's: not in that page's own undo
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
      const f = await getFile(owner, fid);
      if (!f) return;
      if (!rec) { rec = f; loaded.current.set(fid, f); }
      if (!doc) doc = docOf(f);
    }
    if (!views.current.has(key)) return;                     // closed while it loaded
    v.updateState(makeState(doc, isRead(key)));
    viewFile.current.set(key, fid);
    lastFollow.current.delete(key);
    if (key === activeRef.current) {
      syncActive();
      try { localStorage.setItem(scoped("cutter.last", owner), fid); } catch { /* private */ }
    }
    setTick((n) => n + 1);
    if (then) requestAnimationFrame(() => then(v));
  }, [owner, flush, makeState, syncActive]);

  /** The element each page's editor lives in: made once per page, kept while the page is. */
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
            // the word, not the word and the space after it
            dblclick: () => {
              setTimeout(() => {
                const w = views.current.get(key);
                if (!w) return;
                try { (w as any).domObserver?.flush?.(); } catch { /* it reads it on its own soon enough */ }
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

  // ---- pages: what each shows, and how many ------------------------------------------
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

  /** A page beside this one (after it), up to three. */
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
  /** A new file in the store, not yet in any page. */
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

  /** Open a file in the page being worked in. */
  const open = useCallback(async (id: string, then?: (v: EditorView) => void) => {
    const key = activeRef.current || panesRef.current[0]?.key;
    if (!key) return;
    await setPaneFile(key, id, then);
  }, [setPaneFile]);

  /** A new file, in the page being worked in, ready to type in. */
  const create = useCallback(async (fileName: string, html?: string) => {
    const f = await newFile(fileName, html);
    const key = activeRef.current || panesRef.current[0]?.key;
    if (key && isRead(key)) setPaneRead(key, false);
    await open(f.id, (v) => { v.focus(); v.dispatch(v.state.tr.setSelection(TextSelection.atStart(v.state.doc))); });
    return f;
  }, [newFile, open, setPaneRead]);

  // the files, and the workspace as it was left
  const LAYOUT_KEY = scoped("cutter.layout", owner);
  useEffect(() => {
    let gone = false;
    bus.current = openBus(owner, () => {});
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
  // and kept as it changes
  useEffect(() => {
    if (!panes.length) return;
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({
        panes: panes.map((p) => ({ fileId: p.fileId, read: p.read, follow: p.follow })),
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
    setFiles((l) => l.map((x) => (x.id === fid ? { ...x, name: clean } : x)));
    dirty.current.add(fid);
    await flush();
  }, [flush, setFiles]);

  // renaming from the list: an open file through its pages, any other in place
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
    const next = { ...f, name: clean, updated: Date.now() };       // a new name is news to Evidence too
    await putFile(owner, next);
    loaded.current.delete(id);
    setFiles((l) => l.map((x) => (x.id === id ? { ...x, name: clean, updated: next.updated } : x)));
    bus.current?.post({ kind: "cutter-changed", id });
  }, [owner, flush, setFiles]);

  const remove = useCallback(async (id: string) => {
    const f = filesRef.current.find((x) => x.id === id);
    if (!f || !window.confirm(`Delete “${f.name}”? Its cards leave Evidence too.`)) return;
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

  // ---- layouts ----------------------------------------------------------------
  const layout = useCallback(async (id: string) => {
    setLayoutOpen(null);
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
      // an extensions file starts with a block heading to name, and an analytic (Heading 4) under it
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

  /** Alt+R: this file verbatimised beside you — or, if it is already, gone again. */
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
    if (edits.length < 2) return;
    const i = edits.findIndex((p) => p.key === activeRef.current);
    const k = edits[(i + 1) % edits.length].key;
    activate(k);
    views.current.get(k)?.focus();
  }, [activate]);

  // ---- the commands ---------------------------------------------------------
  /** This page: just the highlighting, or back to the whole cards. Nothing in the file changes. */
  const toggleVerb = useCallback(() => {
    const k = activeRef.current;
    if (k) setPaneRead(k, !isRead(k));
  }, [setPaneRead]);

  const run = useCallback((id: string) => {
    if (id === "verbatim") { toggleVerb(); return; }
    if (id === "read-beside") { readBeside(); return; }
    if (id === "next-pane") { nextPane(); return; }
    if (id === "sidebar") { setSide((s) => !s); return; }
    if (id === "save") { void flush(true); return; }
    if (id === "find") { setSide(true); setTab("files"); requestAnimationFrame(() => { qIn.current?.focus(); qIn.current?.select(); }); return; }
    if (id === "new-file") { void create("Untitled file"); return; }
    if (id === "hl-next") {
      const i = C.HIGHLIGHTS.findIndex((h) => h.color === hlRef.current);
      const n = C.HIGHLIGHTS[(i + 1) % C.HIGHLIGHTS.length];
      setHl(n.color);
      toast(`Highlighter: ${n.name}`);
      return;
    }
    const v = view.current;
    if (!v) return;
    // a read page: nothing to cut in it
    if (isRead(activeRef.current) && IN_DOC.has(id) && !IN_READ.has(id)) { toast(`A read page — ${keyLabel(keyFor(keysRef.current, "verbatim")) || "Verbatimise"} to edit it`); return; }
    const exec = (cmd: (s: EditorState, d?: EditorView["dispatch"]) => boolean) => { cmd(v.state, v.dispatch); v.focus(); };
    switch (id) {
      case "pocket": return exec(C.setLevel(1));
      case "hat": return exec(C.setLevel(2));
      case "block": return exec(C.setLevel(3));
      case "tag": return exec(C.setLevel(4));
      case "cite": return exec(C.cite);
      case "underline": {
        // plain → cut → emphasis → plain, at any pace (commands.ts, cut); a selection
        // made a moment ago is read first, so the press acts on what is selected now
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
      case "new-extension": return exec(X.newExtension(curRef.current?.name || ""));
      case "analytic": return exec(X.analytic);
      case "page-break": return exec(X.pageBreak);
      case "reference": {
        if (!R.referenceCard(hlRef.current)(v.state)) { toast("Put the cursor in a card (or select some of one) to keep it for reference"); return; }
        return exec(R.referenceCard(hlRef.current));
      }
      case "insert-reference": setRefPick({ q: "", sel: 0 }); return;
      case "reformat": {
        const whole = v.state.selection.empty;
        const r = reformat(v.state, hlRef.current, sigRef.current);
        if (!r.tr.docChanged) { toast(whole ? "Every card here is formatted already" : "What's selected is formatted already"); v.focus(); return; }
        v.dispatch(r.tr);
        v.focus();
        const said = [
          r.recoloured && "highlighting one colour",
          r.boxed && "emphasis boxed",
          r.plain && "pasted fonts and colours off",
          r.sized && "sizes set (11pt read, 8pt shrunk)",
          r.spaces && `${r.spaces} stray space${r.spaces === 1 ? "" : "s"} unmarked`,
          r.doubles && `${r.doubles} double space${r.doubles === 1 ? "" : "s"} made single`,
          r.cites && `${r.cites} cite${r.cites === 1 ? "" : "s"} rewritten`,
        ].filter(Boolean).join(", ");
        toast(`Reformatted${whole ? " the file" : ""}: ${said}`);
        return;
      }
      case "clean-up": {
        const { tr, spaces, doubles } = C.cleanUp(v.state);
        if (!tr.docChanged) { toast(v.state.selection.empty ? "Nothing to clean up in this file" : "Nothing to clean up in what's selected"); v.focus(); return; }
        v.dispatch(tr);
        v.focus();
        const said = [spaces && `${spaces} space${spaces === 1 ? "" : "s"} unmarked`, doubles && `${doubles} double space${doubles === 1 ? "" : "s"} made single`].filter(Boolean).join(", ");
        toast(`Cleaned up${v.state.selection.empty ? " the file" : ""}: ${said}`);
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
  }, [flush, create, toast, toggleVerb, readBeside, nextPane]);

  // every key, before the page does anything with it
  useEffect(() => {
    const inDoc = () => {
      const v = view.current;
      return !!v && (v.hasFocus() || (document.activeElement === document.body && !!curRef.current));
    };
    const onKey = (e: KeyboardEvent) => {
      if (listeningRef.current) return;                        // the Keys panel is taking one
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
    // and the ones made of modifiers alone (Ctrl+Alt), which fire as they are let go
    const offChords = watchChords((spec, e) => {
      if (listeningRef.current) return;
      const id = actionFor(keysRef.current, spec);
      if (!id) return;
      if (IN_DOC.has(id) && !inDoc()) return;
      e.preventDefault();
      run(id);
    });
    return () => { window.removeEventListener("keydown", onKey, true); offChords(); };
  }, [run]);

  // ---- the Keys panel: press the new key ---------------------------------------
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
    // modifiers alone — Ctrl+Alt — are taken as they are let go
    const offChords = watchChords((spec, e) => { e.preventDefault(); give(spec); });
    return () => { window.removeEventListener("keydown", take, true); offChords(); };
  }, [listening, owner]);
  useEffect(() => {
    if (!keysOpen || listening) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setKeysOpen(false); view.current?.focus(); } };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [keysOpen, listening]);
  // the Layout menu closes on Esc or a click elsewhere
  useEffect(() => {
    if (!layoutOpen) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setLayoutOpen(null); view.current?.focus(); } };
    const away = (e: PointerEvent) => { if (!(e.target as Element).closest?.(".ct-layouts, .ct-layoutbtn")) setLayoutOpen(null); };
    window.addEventListener("keydown", esc);
    window.addEventListener("pointerdown", away, true);
    return () => { window.removeEventListener("keydown", esc); window.removeEventListener("pointerdown", away, true); };
  }, [layoutOpen]);

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

  // ---- a card from any file, put in as a reference -----------------------------------
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
    const v = view.current;
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
  }, [owner, toast]);

  /** Bring the n-th tag of the open file to the top, with the cursor in it. */
  const goTag = useCallback((v: EditorView, n: number) => {
    let k = -1, pos = -1;
    v.state.doc.forEach((node, p) => { if (pos < 0 && node.type === schema.nodes.heading && node.attrs.level === 4 && ++k === n) pos = p; });
    if (pos < 0) return;
    goPos(v, pos);
  }, [goPos]);

  // ---- dragging in the outline: a heading takes everything under it along -------------
  const [drag, setDrag] = useState<number | null>(null);        // the row being dragged
  const [dropAt, setDropAt] = useState<number | null>(null);    // the row it would go in front of (heads.length: the end)
  /** Where a drop in front of row `i` lands in the document, or null where it can't go. */
  const dropTarget = (from: number, i: number): number | null => {
    const v = view.current;
    if (!v) return null;
    const secs = C.sections(v.state.doc);
    const me = secs.find((s) => s.pos === heads[from]?.pos);
    if (!me) return null;
    const target = i < heads.length ? heads[i].pos : v.state.doc.content.size;
    return target >= me.pos && target <= me.end ? null : target;
  };
  const onRowDrag = (e: React.DragEvent, i: number) => {
    if (drag === null) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = e.clientY > r.top + r.height / 2 ? i + 1 : i;
    const ok = dropTarget(drag, at) !== null;
    e.dataTransfer.dropEffect = ok ? "move" : "none";
    setDropAt(ok ? at : null);
  };
  const dropRow = () => {
    const v = view.current;
    if (v && drag !== null && dropAt !== null) {
      const target = dropTarget(drag, dropAt);
      const tr = target === null ? null : C.moveSection(v.state, heads[drag].pos, target);
      if (tr) {
        v.dispatch(tr);
        const pos = v.state.selection.$from.before(1);
        requestAnimationFrame(() => goPos(v, pos));
      }
    }
    setDrag(null); setDropAt(null);
  };

  // ---- the line between two pages drags ------------------------------------------
  const dragSplit = (e: React.PointerEvent<HTMLDivElement>, i: number) => {
    e.preventDefault();
    const el = e.currentTarget, box = panesBox.current;
    if (!box) return;
    el.setPointerCapture(e.pointerId);
    const total = box.getBoundingClientRect().width;
    const start = e.clientX, w0 = [...widths], sum = w0.reduce((a, b) => a + b, 0);
    const pair = w0[i] + w0[i + 1];
    const min = (260 / total) * sum;
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

  // ---- opening and downloading -------------------------------------------------
  const openFile = useCallback(async (file: File) => {
    setBusy(true);
    try {
      const n = file.name.toLowerCase();
      let html: string;
      if (n.endsWith(".docx")) html = await docxToHtml(file);
      else if (n.endsWith(".html") || n.endsWith(".htm")) html = sanitize(await file.text());
      else html = (await file.text()).split(/\r?\n/).map((l) => `<p>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`).join("");
      await create(file.name.replace(/\.(docx|html?|txt)$/i, ""), html);
      toast(`Opened “${file.name}” as a file of your own`);
    } catch (e) {
      toast("Could not open that: " + (e as Error).message);
    } finally { setBusy(false); }
  }, [create, toast]);

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

  // ---- drawing --------------------------------------------------------------
  const K = (id: string) => keyLabel(keyFor(keys, id));
  const groups = useMemo(() => Array.from(new Set(ACTIONS.map((a) => a.group))), []);
  const cardsHere = cur ? (cur.cards || []).length : 0;
  const activePane = panes.find((p) => p.key === activeKey) || null;
  const activeRead = !!activePane?.read;
  const many = panes.length > 1;
  void tick;

  return (
    <div className={"dvw cutw" + (side ? "" : " noside")} ref={root} style={{ ["--ct-hl" as string]: hl }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); void openFile(f); } }}>
      <header className="dv-top" ref={bar}>
        <Link className="dv-back mono" href="/tools" title="Back to the tools">←</Link>
        <div className="dv-brand mono">Card cutter</div>
        <div className="dv-now ct-now">
          <input className="ct-name" value={name} onChange={(e) => setName(e.target.value)} aria-label="File name"
            onBlur={(e) => void rename(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); view.current?.focus(); } if (e.key === "Escape") { setName(cur?.name || ""); view.current?.focus(); } }} spellCheck={false} />
          <span className="dv-src mono">
            {state === "saved" ? "Saved" : state === "saving" ? "Saving…" : "Editing"} · {cardsHere} card{cardsHere === 1 ? "" : "s"} · in Evidence
          </span>
        </div>
        <div className="dv-gap" />
        <button type="button" className={"dv-btn" + (activeRead ? " on" : "")} onClick={toggleVerb} aria-pressed={activeRead}
          title={`Verbatimise this page — just the highlighting, the cards as you'll read them${K("verbatim") ? ` (${K("verbatim")})` : ""}`}>
          <Ico n="highlight" /><span className="lbl">Verbatimise</span>
        </button>
        <button type="button" ref={layoutBtn} className={"dv-btn ct-layoutbtn" + (layoutOpen || many ? " on" : "")} aria-expanded={!!layoutOpen}
          onClick={() => {
            if (layoutOpen) { setLayoutOpen(null); return; }
            const r = layoutBtn.current!.getBoundingClientRect();
            setLayoutOpen({ x: Math.min(window.innerWidth - 336, Math.max(8, r.right - 320)), y: r.bottom + 6 });
          }}
          title="Layout — more than one page: the read view beside you, two places in a file, another file beside"><Ico n="grid" /><span className="lbl">Layout</span></button>
        <button type="button" className={"dv-btn" + (keysOpen ? " on" : "")} onClick={() => { setKeysOpen((o) => !o); setKeyNote(""); }} title="Change the keys"><Ico n="settings" /><span className="lbl">Keys</span></button>
        <FullBtn className="dv-btn dv-full" full={full} toggle={toggleFull} />
        <a className="dv-btn splitlink icoonly" aria-label="Split screen" href="/tools/split?a=cutter&b=evidence" onClick={markHop} title="Split screen — the cutter beside Evidence"><Ico n="split" /><span className="lbl">Split ◫</span></a>
        <ThemePicker />
        <input ref={fileIn} type="file" accept=".docx,.html,.htm,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void openFile(f); }} />
      </header>

      {/* every cutting key, the most used first — pressable as well */}
      <div className="ct-strip" role="toolbar" aria-label="Cutting keys">
        {STRIP.map((id) => {
          const a = ACTION.get(id)!;
          return (
            <button key={id} type="button" className={"ct-key ct-" + id} onMouseDown={(e) => e.preventDefault()} onClick={() => run(id)} disabled={activeRead}
              title={a.hint + (caveat(keyFor(keys, id)) ? ` — ${caveat(keyFor(keys, id))}` : "")}>
              {K(id) && <kbd>{K(id)}</kbd>}<span>{a.label}</span>
            </button>
          );
        })}
        <span className="ct-hls" role="group" aria-label="Highlighter colour">
          {C.HIGHLIGHTS.map((h) => (
            <button key={h.color} type="button" className={"ct-hl" + (hl === h.color ? " on" : "")} style={{ background: h.color }}
              onMouseDown={(e) => e.preventDefault()} onClick={() => setHl(h.color)} aria-pressed={hl === h.color} title={`Highlight ${h.name.toLowerCase()}`} />
          ))}
        </span>
      </div>

      <div className="dv-body">
        {side ? (
          <aside className="dv-side">
            <div className="dv-tabs mono" role="tablist">
              <button type="button" role="tab" className={tab === "files" ? "on" : ""} aria-selected={tab === "files"} onClick={() => setTab("files")}>Files <em>{files.length}</em></button>
              <button type="button" role="tab" className={tab === "outline" ? "on" : ""} aria-selected={tab === "outline"} onClick={() => setTab("outline")}>Outline <em>{heads.length}</em></button>
              <button type="button" className="ct-hide" onClick={() => setSide(false)} title={`Hide the side${K("sidebar") ? ` (${K("sidebar")})` : ""}`} aria-label="Hide the side">‹</button>
            </div>
            {tab === "files" ? (
              <div className="dv-outline">
                <div className="dv-ohead">
                  <input ref={qIn} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search every file${K("find") ? ` (${K("find")})` : ""}`} spellCheck={false}
                    aria-label="Search every file"
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { e.preventDefault(); if (q) setQ(""); else view.current?.focus(); }
                      if (e.key === "Enter" && results) {
                        e.preventDefault();
                        const c = results.cards[0], f = results.named[0];
                        if (c) void open(c.file.id, (v) => goTag(v, c.i)); else if (f) void open(f.id, (v) => v.focus());
                      }
                    }} />
                </div>
                <div className="ct-fileacts">
                  <button type="button" onClick={() => void create("Untitled file")} title={`New file${K("new-file") ? ` (${K("new-file")})` : ""}`}>+ New file</button>
                  <button type="button" onClick={() => fileIn.current?.click()} disabled={busy} title="Open a .docx (or a web page, or text) as a file of your own">{busy ? "Opening…" : "Open .docx"}</button>
                </div>
                <div className="dv-olist ct-files">
                  {results ? (
                    <>
                      {results.named.map((f) => (
                        <button key={"f" + f.id} type="button" className={"ct-file" + (cur?.id === f.id ? " on" : "")} onClick={() => void open(f.id, (v) => v.focus())}>
                          <b>{f.name}</b><small className="mono">file · {f.cards.length} cards</small>
                        </button>
                      ))}
                      {results.cards.map((c) => (
                        <button key={c.key} type="button" className="ct-hit" onClick={() => void open(c.file.id, (v) => goTag(v, c.i))}>
                          <b>{c.tag}</b>
                          {c.cite && <span className="ct-cite">{c.cite}</span>}
                          <small className="mono">{c.block ? c.block + " · " : ""}{c.file.name}</small>
                        </button>
                      ))}
                      {!results.named.length && !results.cards.length && <p className="dv-none">Nothing in your files says that.</p>}
                    </>
                  ) : (
                    files.map((f) => (
                      <div key={f.id} className={"ct-file" + (cur?.id === f.id ? " on" : "") + (renaming === f.id ? " renaming" : "")}>
                        {renaming === f.id ? (
                          <input className="ct-rename" defaultValue={f.name} autoFocus spellCheck={false} aria-label={`New name for ${f.name}`}
                            onFocus={(e) => e.currentTarget.select()}
                            onBlur={(e) => void renameFile(f.id, e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
                              if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
                            }} />
                        ) : (
                          <button type="button" className="ct-open"
                            // the open file is not opened again — so its double-click is a rename, not a reload —
                            // and a file opening never takes the cursor from a rename under way
                            onClick={() => { if (cur?.id !== f.id) void open(f.id, (v) => { if (!renamingRef.current) v.focus(); }); }}
                            onDoubleClick={(e) => { e.preventDefault(); setRenaming(f.id); }} title="Open in this page · double-click to rename">
                            <b>{f.name}</b>
                            <small className="mono">{f.cards.length} card{f.cards.length === 1 ? "" : "s"} · {when(f.updated)}</small>
                          </button>
                        )}
                        {renaming !== f.id && (
                          <>
                            <button type="button" className="ct-x ct-ren" onClick={() => setRenaming(f.id)} aria-label={`Rename ${f.name}`} title="Rename this file">✎</button>
                            <button type="button" className="ct-x ct-ren" onClick={() => void download(f.id)} aria-label={`Download ${f.name} as a .docx`} title="Download as a .docx — Word and Google Docs open it">↓</button>
                            <button type="button" className="ct-x" onClick={() => void remove(f.id)} aria-label={`Delete ${f.name}`} title="Delete this file">×</button>
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>
                <p className="ct-note">Every file here is in Evidence&apos;s search as well, kept up to date as you cut.</p>
              </div>
            ) : (
              <div className="dv-outline">
                <div className={"dv-olist ct-olist" + (drag !== null ? " dragging" : "")}
                  onDragOver={(e) => { if (drag !== null && e.target === e.currentTarget) { e.preventDefault(); const ok = dropTarget(drag, heads.length) !== null; setDropAt(ok ? heads.length : null); } }}
                  onDrop={(e) => { e.preventDefault(); dropRow(); }}>
                  {heads.length ? heads.map((h, i) => (
                    <button key={i} type="button" draggable
                      className={`dv-orow l${h.level}` + (i === at ? " on" : "") + (drag === i ? " lifted" : "") + (dropAt === i ? " drop-before" : "") + (dropAt === heads.length && i === heads.length - 1 ? " drop-after" : "")}
                      style={{ ["--d" as string]: h.level - 1 }}
                      title="Click to go there · drag to move it, and everything under it"
                      onClick={() => view.current && goPos(view.current, h.pos)}
                      onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", h.text); }}
                      onDragOver={(e) => onRowDrag(e, i)}
                      onDragEnd={() => { setDrag(null); setDropAt(null); }}>
                      <span className="ct-grip" aria-hidden="true">⠿</span>
                      <span className="t">{h.text}</span>
                    </button>
                  )) : <p className="dv-none">No headings yet. {K("tag")} makes a line a tag, {K("block")} a block.</p>}
                </div>
                {heads.length > 1 && <p className="ct-note">Drag a heading to move it — a tag takes its card, a block its cards. {K("move-up")} / {K("move-down")} move the one the cursor is in.</p>}
              </div>
            )}
          </aside>
        ) : (
          <button type="button" className="ct-rail" onClick={() => setSide(true)} title={`Show files and outline${K("sidebar") ? ` (${K("sidebar")})` : ""}`} aria-label="Show the side">›</button>
        )}

        <div className="ct-panes" ref={panesBox}>
          {panes.map((p, i) => {
            const v = views.current.get(p.key);
            const words = p.read && v ? readWords(v.state.doc) : 0;
            const showHead = many || p.read;
            return [
              i > 0 && <div key={"s" + p.key} className="ct-split" role="separator" aria-orientation="vertical" aria-label="Resize the pages"
                onPointerDown={(e) => dragSplit(e, i - 1)} onDoubleClick={() => setWidths(panes.map(() => 1))} title="Drag to resize · double-click for equal widths" />,
              <section key={p.key} className={"ct-pane" + (p.key === activeKey && many ? " active" : "") + (p.read ? " read" : "")}
                style={{ flex: `${widths[i] ?? 1} 1 0` }}
                onPointerDown={() => { if (!p.read) activate(p.key); }}>
                {showHead && (
                  <div className="ct-phead">
                    <select className="ct-psel" value={p.fileId} onChange={(e) => void setPaneFile(p.key, e.target.value)} aria-label="The file in this page">
                      {files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                    <span className="ct-pmode" role="group" aria-label="Edit or read">
                      <button type="button" className={p.read ? "" : "on"} aria-pressed={!p.read} onClick={() => setPaneRead(p.key, false)}>Edit</button>
                      <button type="button" className={p.read ? "on" : ""} aria-pressed={p.read} onClick={() => setPaneRead(p.key, true)}>Read</button>
                    </span>
                    {p.read && <span className="ct-pstat">{words} word{words === 1 ? "" : "s"}{words ? ` · ${readTime(words)}` : ""}</span>}
                    {p.read && many && (
                      <button type="button" className={"ct-pfollow" + (p.follow ? " on" : "")} aria-pressed={p.follow}
                        onClick={() => setPanes(panesRef.current.map((x) => (x.key === p.key ? { ...x, follow: !x.follow } : x)))}
                        title="Following: this page keeps the card you are editing in view. Click a card here to go to it there.">
                        {p.follow ? "Following" : "Follow"}
                      </button>
                    )}
                    <span className="ct-pgap" />
                    {panes.length < MAX_PANES && (
                      <button type="button" className="ct-pbtn" onClick={() => addPane({ fileId: p.fileId, read: false, follow: true }, p.key)} title="Another page of this file beside this one" aria-label="Split this page">＋</button>
                    )}
                    {many && <button type="button" className="ct-pbtn" onClick={() => void closePane(p.key)} title="Close this page" aria-label="Close this page">×</button>}
                  </div>
                )}
                {p.key === activeKey && selCount && (
                  <div className="ct-selcount mono" role="status" aria-live="polite">
                    {selCount.words} word{selCount.words === 1 ? "" : "s"} · {selCount.read} to read{selCount.read ? ` · ${readTime(selCount.read)}` : ""}
                  </div>
                )}
                <main className="dv-pane ct-scroll">
                  <div className={"dv-paper ct-paper" + (p.read ? " verb" : "")}>
                    <div ref={mountFor(p.key)} />
                  </div>
                </main>
              </section>,
            ];
          })}
        </div>
      </div>

      {layoutOpen && (
        <div className="ct-layouts" role="menu" aria-label="Layout" style={{ left: layoutOpen.x, top: layoutOpen.y }}>
          {LAYOUTS.map((l) => {
            const k = "key" in l ? K(l.key) : "";
            const now = l.id === "one" ? panes.length === 1 && !activeRead : l.id === "read" ? panes.length === 2 && panes.some((p) => p.read) : false;
            return (
              <button key={l.id} type="button" role="menuitem" className={"ct-lay" + (now ? " on" : "")} onClick={() => void layout(l.id)}>
                <span className="ct-pic" aria-hidden="true">{l.cols.map((c, n) => <i key={n} className={"c-" + c} />)}</span>
                <span className="ct-lt"><b>{l.name}</b><small>{l.sub}</small></span>
                {k && <kbd>{k}</kbd>}
              </button>
            );
          })}
          <p className="ct-layhint">Any page: its file and Edit / Read on its own line. Drag between pages to resize. {K("sidebar") && <><kbd>{K("sidebar")}</kbd> hides the side, </>}{K("next-pane") && <><kbd>{K("next-pane")}</kbd> moves to the next page.</>}</p>
        </div>
      )}

      {refPick && (
        <div className="ct-refveil" onPointerDown={(e) => { if (e.target === e.currentTarget) { setRefPick(null); view.current?.focus(); } }}>
          <div className="ct-refpick" role="dialog" aria-label="Reference a card">
            <input ref={refIn} value={refPick.q} placeholder="Find the card to reference — tag, cite, words…" spellCheck={false}
              aria-label="Find the card to reference"
              onChange={(e) => setRefPick({ q: e.target.value, sel: 0 })}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); setRefPick(null); view.current?.focus(); }
                if (e.key === "ArrowDown") { e.preventDefault(); setRefPick((r) => r && { ...r, sel: Math.min(refHits.length - 1, r.sel + 1) }); }
                if (e.key === "ArrowUp") { e.preventDefault(); setRefPick((r) => r && { ...r, sel: Math.max(0, r.sel - 1) }); }
                if (e.key === "Enter") { e.preventDefault(); const h = refHits[refPick.sel]; if (h) void putReference(h); }
              }} />
            <ul>
              {refHits.map((h, n) => (
                <li key={h.key} className={n === refPick.sel ? "on" : ""} onPointerMove={() => { if (n !== refPick.sel) setRefPick({ ...refPick, sel: n }); }} onClick={() => void putReference(h)}>
                  <b>{h.tag}</b>
                  <small className="mono">{h.cite ? h.cite.slice(0, 70) + " · " : ""}{h.file.name}</small>
                </li>
              ))}
              {refPick.q.trim().length >= 2 && !refHits.length && <li className="none">No card in your files says that</li>}
              {refPick.q.trim().length < 2 && <li className="none">It goes in under the line you&apos;re on, with &lt;&lt;FOR REFERENCE---its author&gt;&gt; and its highlighting grey</li>}
            </ul>
          </div>
        </div>
      )}

      {keysOpen && (
        <div className="ct-keys" role="dialog" aria-label="Change the keys">
          <div className="ct-keyshead">
            <b>Keys</b>
            <span>Click a key, then press the new one (two modifiers alone work too, like Ctrl+Alt: press them together and let go). Backspace leaves it with none; Esc keeps it. A key that does nothing here may belong to an extension (chrome://extensions/shortcuts): Chrome gives it to the extension first, except while the cutter is full screen.</span>
            <button type="button" className="dv-btn2" onClick={() => { setKeys({}); saveKeys(owner, {}); setKeyNote("Every key is back to the defaults"); }}>Reset all</button>
            <button type="button" className="dv-btn2 ink" onClick={() => { setKeysOpen(false); setListening(null); view.current?.focus(); }}>Done</button>
          </div>
          <label className="ct-sigrow">
            <span><b>Sign cites as</b><small>Reformat ends the cites it rewrites with this, in place of the original cutter&apos;s initials. Empty keeps theirs.</small></span>
            <input value={sig} placeholder="e.g. elimafia 🕵" spellCheck={false}
              onChange={(e) => { setSig(e.target.value); try { localStorage.setItem(scoped("cutter.sig", owner), e.target.value); } catch { /* private */ } }} />
          </label>
          {keyNote && <p className="ct-keynote">{keyNote}</p>}
          <div className="ct-keylist">
            {groups.map((g) => (
              <section key={g}>
                <h3 className="mono">{g}</h3>
                {ACTIONS.filter((a) => a.group === g).map((a) => (
                  <div key={a.id} className="ct-keyrow">
                    <span className="ct-kl"><b>{a.label}</b>{a.hint && <small>{a.hint}</small>}{caveat(keyFor(keys, a.id)) && <small className="ct-warn">{caveat(keyFor(keys, a.id))}</small>}</span>
                    <button type="button" className={"ct-kbtn" + (listening === a.id ? " wait" : "") + (a.id in keys ? " moved" : "")}
                      onClick={() => { setListening((l) => (l === a.id ? null : a.id)); setKeyNote(""); }}>
                      {listening === a.id ? "Press a key…" : K(a.id) || "none"}
                    </button>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      )}

      {toastMsg && <div className="dv-toast mono" key={toastMsg.n} role="status">{toastMsg.t}</div>}
    </div>
  );
}

function stripDoc(f: CutFile): CutMeta {
  const { doc: _d, html: _h, ...m } = f;
  return m;
}
