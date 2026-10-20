"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { DOMParser as PMParser, DOMSerializer, type Node as PMNode } from "prosemirror-model";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { schema } from "@/lib/evidence/docSchema";
import { listFiles, getFile, putFile, dropFile, newFileId, type CutMeta, type CutFile } from "@/lib/cutter/store";
import * as C from "@/lib/cutter/commands";
import { ACTIONS, ACTION, comboOf, keyLabel, keyFor, actionFor, bind, refuse, caveat, loadKeys, saveKeys, watchChords, type Overrides } from "@/lib/cutter/keys";
import { docxToHtml } from "@/lib/cutter/docxIn";
import { sanitize } from "@/lib/viewer/doc";
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
const when = (t: number) => {
  const d = new Date(t), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
};
const countWords = (doc: PMNode) => (doc.textContent.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

interface Head { level: number; text: string; pos: number }

/** The keys along the top of the page, the ones used most first. */
const STRIP = ["underline", "emphasis", "highlight", "shrink", "cite", "tag", "block", "hat", "pocket", "clear", "condense"];
/** What only makes sense with the cursor in the document. */
const IN_DOC = new Set(["pocket", "hat", "block", "tag", "cite", "underline", "emphasis", "highlight", "clear", "shrink", "condense", "paste", "new-card"]);

export default function Cutter({ owner }: { owner?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const view = useRef<EditorView | null>(null);
  const qIn = useRef<HTMLInputElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const bus = useRef<Bus | null>(null);

  const [files, setFiles] = useState<CutMeta[]>([]);
  const [cur, setCur] = useState<CutFile | null>(null);
  const curRef = useRef<CutFile | null>(null);
  curRef.current = cur;
  const [name, setName] = useState("");
  const [state, setStateTag] = useState<"saved" | "saving" | "dirty">("saved");
  const [heads, setHeads] = useState<Head[]>([]);
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
  const hlRef = useRef(hl);
  hlRef.current = hl;
  const [toastMsg, setToastMsg] = useState<{ t: string; n: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const saveT = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, [owner]);
  useEffect(() => { try { localStorage.setItem(scoped("cutter.hl", owner), hl); } catch { /* private */ } }, [hl, owner]);

  // ---- the outline, read off the document ------------------------------------
  const readHeads = useCallback(() => {
    const v = view.current;
    if (!v) return;
    const out: Head[] = [];
    v.state.doc.forEach((n, pos) => { if (n.type === schema.nodes.heading) out.push({ level: n.attrs.level, text: n.textContent.trim() || "(empty)", pos }); });
    setHeads(out);
    const from = v.state.selection.from;
    let i = -1;
    out.forEach((h, k) => { if (h.pos <= from) i = k; });
    setAt(i);
  }, []);

  // ---- saving ---------------------------------------------------------------
  const save = useCallback(async (quiet = true) => {
    if (saveT.current) { clearTimeout(saveT.current); saveT.current = null; }
    const v = view.current, f = curRef.current;
    if (!v || !f) return;
    setStateTag("saving");
    const doc = v.state.doc;
    const next: CutFile = {
      ...f,
      doc: doc.toJSON(),
      html: toHtml(doc),
      cards: C.briefs(doc),
      words: countWords(doc),
      updated: Date.now(),
    };
    try {
      await putFile(owner, next);
      curRef.current = next;
      setCur(next);
      setFiles((l) => [{ ...stripDoc(next) }, ...l.filter((x) => x.id !== next.id)]);
      setStateTag("saved");
      bus.current?.post({ kind: "cutter-changed", id: next.id });
      if (!quiet) toast("Saved — and in Evidence's search");
    } catch (e) {
      setStateTag("dirty");
      toast("Could not save: " + (e as Error).message);
    }
  }, [owner, toast]);
  const saveSoon = useCallback(() => {
    setStateTag("dirty");
    if (saveT.current) clearTimeout(saveT.current);
    saveT.current = setTimeout(() => { void save(); }, 700);
  }, [save]);
  // nothing lost on the way out
  useEffect(() => {
    const out = () => { if (saveT.current) void save(); };
    window.addEventListener("pagehide", out);
    return () => { window.removeEventListener("pagehide", out); out(); };
  }, [save]);

  // ---- the editor -----------------------------------------------------------
  const stateFor = useCallback((f: CutFile) => {
    let doc: PMNode;
    try { doc = f.doc ? schema.nodeFromJSON(f.doc as object) : fromHtml(f.html); } catch { doc = fromHtml(f.html); }
    return EditorState.create({
      doc,
      plugins: [
        history(),
        keymap({
          "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo,
          "Mod-b": toggleMark(schema.marks.strong), "Mod-i": toggleMark(schema.marks.em), "Mod-u": toggleMark(schema.marks.underline),
        }),
        keymap(baseKeymap),
      ],
    });
  }, []);

  useEffect(() => {
    if (!mount.current || view.current) return;
    const v = new EditorView({ mount: mount.current }, {
      state: EditorState.create({ schema }),
      attributes: { class: "ct-sheet", spellcheck: "false" },
      dispatchTransaction(tr) {
        const s = v.state.apply(tr);
        v.updateState(s);
        if (tr.docChanged) saveSoon();
        if (tr.docChanged || tr.selectionSet) readHeads();
      },
      handleDOMEvents: {
        // the word, not the word and the space after it
        dblclick: () => {
          setTimeout(() => {
            // the browser has moved the selection; have ProseMirror read it before trimming it
            try { (v as any).domObserver?.flush?.(); } catch { /* it reads it on its own soon enough */ }
            const s = C.trimmed(v.state);
            if (s) v.dispatch(v.state.tr.setSelection(s));
          }, 0);
          return false;
        },
      },
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
  }, [saveSoon, readHeads]);

  const open = useCallback(async (id: string, then?: (v: EditorView) => void) => {
    if (saveT.current) await save();
    const f = await getFile(owner, id);
    const v = view.current;
    if (!f || !v) return;
    v.updateState(stateFor(f));
    curRef.current = f;
    setCur(f);
    setName(f.name);
    setStateTag("saved");
    readHeads();
    try { localStorage.setItem(scoped("cutter.last", owner), id); } catch { /* private */ }
    if (then) requestAnimationFrame(() => then(v));
  }, [owner, save, stateFor, readHeads]);

  const create = useCallback(async (fileName: string, html = "<h4></h4><p></p>") => {
    if (saveT.current) await save();
    const doc = fromHtml(html);
    const f: CutFile = {
      id: newFileId(), name: fileName, doc: doc.toJSON(), html: toHtml(doc),
      cards: C.briefs(doc), words: countWords(doc), created: Date.now(), updated: Date.now(),
    };
    await putFile(owner, f);
    setFiles((l) => [stripDoc(f), ...l]);
    bus.current?.post({ kind: "cutter-changed", id: f.id });
    await open(f.id, (v) => { v.focus(); v.dispatch(v.state.tr.setSelection(TextSelection.atStart(v.state.doc))); });
    return f;
  }, [owner, open, save]);

  // the files, and the last one open
  useEffect(() => {
    let gone = false;
    bus.current = openBus(owner, () => {});
    (async () => {
      const l = await listFiles(owner);
      if (gone) return;
      if (!l.length) {
        setFiles([]);
        await create("My first file");
        return;
      }
      setFiles(l);
      let last = "";
      try { last = localStorage.getItem(scoped("cutter.last", owner)) || ""; } catch { /* private */ }
      await open(l.some((f) => f.id === last) ? last : l[0].id);
    })();
    return () => { gone = true; bus.current?.close(); bus.current = null; };
  }, [owner]); // eslint-disable-line react-hooks/exhaustive-deps

  const rename = useCallback(async (n: string) => {
    const f = curRef.current;
    const clean = n.replace(/\s+/g, " ").trim();
    if (!f || !clean || clean === f.name) { setName(f?.name || ""); return; }
    const next = { ...f, name: clean, updated: Date.now() };
    curRef.current = next;
    setCur(next);
    setFiles((l) => l.map((x) => (x.id === f.id ? { ...x, name: clean } : x)));
    await save();
  }, [save]);

  const remove = useCallback(async (id: string) => {
    const f = files.find((x) => x.id === id);
    if (!f || !window.confirm(`Delete “${f.name}”? Its cards leave Evidence too.`)) return;
    await dropFile(owner, id);
    bus.current?.post({ kind: "cutter-changed", id });
    const rest = files.filter((x) => x.id !== id);
    setFiles(rest);
    if (curRef.current?.id === id) {
      if (saveT.current) { clearTimeout(saveT.current); saveT.current = null; }
      curRef.current = null;
      if (rest.length) await open(rest[0].id); else await create("Untitled file");
    }
    toast(`Deleted “${f.name}”`);
  }, [files, owner, open, create, toast]);

  // ---- the commands ---------------------------------------------------------
  const run = useCallback((id: string) => {
    const v = view.current;
    if (!v) return;
    const exec = (cmd: (s: EditorState, d?: EditorView["dispatch"]) => boolean) => { cmd(v.state, v.dispatch); v.focus(); };
    switch (id) {
      case "pocket": return exec(C.setLevel(1));
      case "hat": return exec(C.setLevel(2));
      case "block": return exec(C.setLevel(3));
      case "tag": return exec(C.setLevel(4));
      case "cite": return exec(C.cite);
      case "underline": return exec(C.underline);
      case "emphasis": return exec(C.emphasis);
      case "highlight": return exec(C.highlight(hlRef.current));
      case "clear": return exec(C.clear);
      case "shrink": return exec(C.shrink);
      case "condense": return exec(C.condense);
      case "new-card": return exec(C.newCard);
      case "hl-next": {
        const i = C.HIGHLIGHTS.findIndex((h) => h.color === hlRef.current);
        const n = C.HIGHLIGHTS[(i + 1) % C.HIGHLIGHTS.length];
        setHl(n.color);
        toast(`Highlighter: ${n.name}`);
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
      case "save": void save(false); return;
      case "find": setTab("files"); requestAnimationFrame(() => { qIn.current?.focus(); qIn.current?.select(); }); return;
      case "new-file": void create("Untitled file"); return;
    }
  }, [save, create, toast]);

  // every key, before the page does anything with it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (listeningRef.current) return;                        // the Keys panel is taking one
      const spec = comboOf(e);
      if (!spec) return;
      const id = actionFor(keysRef.current, spec);
      if (!id) return;
      const v = view.current;
      const inDoc = !!v && (v.hasFocus() || (document.activeElement === document.body && !!curRef.current));
      if (IN_DOC.has(id) && !inDoc) return;
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
      const v = view.current;
      const inDoc = !!v && (v.hasFocus() || (document.activeElement === document.body && !!curRef.current));
      if (IN_DOC.has(id) && !inDoc) return;
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

  /** Bring the n-th tag of the open file to the top, with the cursor in it. */
  const goTag = useCallback((v: EditorView, n: number) => {
    let k = -1, pos = -1;
    v.state.doc.forEach((node, p) => { if (pos < 0 && node.type === schema.nodes.heading && node.attrs.level === 4 && ++k === n) pos = p; });
    if (pos < 0) return;
    goPos(v, pos);
  }, []);
  const goPos = (v: EditorView, pos: number) => {
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos + 1)));
    v.focus();
    const dom = v.nodeDOM(pos) as HTMLElement | null;
    if (dom && pane.current) {
      pane.current.scrollTo({ top: dom.getBoundingClientRect().top - pane.current.getBoundingClientRect().top + pane.current.scrollTop - 24 });
      dom.classList.remove("ct-flash"); void dom.offsetWidth; dom.classList.add("ct-flash");
    }
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

  const download = useCallback(async () => {
    const v = view.current, f = curRef.current;
    if (!v || !f) return;
    try {
      const [{ elementsFromHtml }, { downloadDocx }] = await Promise.all([import("@/lib/evidence/engine") as Promise<any>, import("@/lib/evidence/docx")]);
      await downloadDocx(elementsFromHtml(toHtml(v.state.doc)), f.name);
    } catch (e) { toast("Could not make the .docx: " + (e as Error).message); }
  }, [toast]);

  // ---- drawing --------------------------------------------------------------
  const K = (id: string) => keyLabel(keyFor(keys, id));
  const groups = useMemo(() => Array.from(new Set(ACTIONS.map((a) => a.group))), []);
  const cardsHere = cur ? (cur.cards || []).length : 0;

  return (
    <div className="dvw cutw" ref={root} style={{ ["--ct-hl" as string]: hl }}
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
        <button type="button" className="dv-btn" onClick={() => void create("Untitled file")} title={`New file${K("new-file") ? ` (${K("new-file")})` : ""}`}><Ico n="doc" /><span className="lbl">New file</span></button>
        <button type="button" className="dv-btn" onClick={() => fileIn.current?.click()} disabled={busy} title="Open a .docx (or a web page, or text) as a file of your own"><Ico n="import" /><span className="lbl">{busy ? "Opening…" : "Open .docx"}</span></button>
        <button type="button" className="dv-btn" onClick={() => void download()} title="Download this file as a .docx — Word and Google Docs open it"><Ico n="export" /><span className="lbl">.docx</span></button>
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
            <button key={id} type="button" className={"ct-key ct-" + id} onMouseDown={(e) => e.preventDefault()} onClick={() => run(id)}
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
        <aside className="dv-side">
          <div className="dv-tabs mono" role="tablist">
            <button type="button" role="tab" className={tab === "files" ? "on" : ""} aria-selected={tab === "files"} onClick={() => setTab("files")}>Files <em>{files.length}</em></button>
            <button type="button" role="tab" className={tab === "outline" ? "on" : ""} aria-selected={tab === "outline"} onClick={() => setTab("outline")}>Outline <em>{heads.length}</em></button>
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
                    <div key={f.id} className={"ct-file" + (cur?.id === f.id ? " on" : "")}>
                      <button type="button" className="ct-open" onClick={() => void open(f.id, (v) => v.focus())}>
                        <b>{f.name}</b>
                        <small className="mono">{f.cards.length} card{f.cards.length === 1 ? "" : "s"} · {when(f.updated)}</small>
                      </button>
                      <button type="button" className="ct-x" onClick={() => void remove(f.id)} aria-label={`Delete ${f.name}`} title="Delete this file">×</button>
                    </div>
                  ))
                )}
              </div>
              <p className="ct-note">Every file here is in Evidence&apos;s search as well, kept up to date as you cut.</p>
            </div>
          ) : (
            <div className="dv-outline">
              <div className="dv-olist">
                {heads.length ? heads.map((h, i) => (
                  <button key={i} type="button" className={`dv-orow l${h.level}` + (i === at ? " on" : "")} style={{ ["--d" as string]: h.level - 1 }}
                    onClick={() => view.current && goPos(view.current, h.pos)}>
                    <span className="t">{h.text}</span>
                  </button>
                )) : <p className="dv-none">No headings yet. {K("tag")} makes a line a tag, {K("block")} a block.</p>}
              </div>
            </div>
          )}
        </aside>

        <main className="dv-pane" ref={pane}>
          <div className="dv-paper ct-paper">
            <div ref={mount} />
          </div>
        </main>
      </div>

      {keysOpen && (
        <div className="ct-keys" role="dialog" aria-label="Change the keys">
          <div className="ct-keyshead">
            <b>Keys</b>
            <span>Click a key, then press the new one (two modifiers alone work too, like Ctrl+Alt: press them together and let go). Backspace leaves it with none; Esc keeps it. A key that does nothing here may belong to an extension (chrome://extensions/shortcuts): Chrome gives it to the extension first, except while the cutter is full screen.</span>
            <button type="button" className="dv-btn2" onClick={() => { setKeys({}); saveKeys(owner, {}); setKeyNote("Every key is back to the defaults"); }}>Reset all</button>
            <button type="button" className="dv-btn2 ink" onClick={() => { setKeysOpen(false); setListening(null); view.current?.focus(); }}>Done</button>
          </div>
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
