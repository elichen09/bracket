"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { EditorState, TextSelection, Plugin, type Command } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { Node as PMNode } from "prosemirror-model";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark, chainCommands } from "prosemirror-commands";
import { schema, surveyPlugin, blankDoc, HIGHLIGHTS, type Tally, type Hl } from "@/lib/docflow/schema";
import * as C from "@/lib/docflow/commands";
import { fromDocsHtml, toDocsHtml, toPlainText } from "@/lib/docflow/io";
import { listDocs, loadDoc, saveDoc, renameDoc, removeDoc, restoreDoc, newId, type DocMeta } from "@/lib/docflow/store";
import { library, find, sendToEvidence, type Entry, type Hit } from "@/lib/flow/cards";
import { openBus, type Bus } from "@/lib/toolsBus";
import { speeches, clock, PREP_DEFAULT } from "@/lib/flow/format";
import { polish } from "@/lib/evidence/polish";
import "./docflow.css";

/**
 * Doc flow — flowing the way a Google Doc gets flowed, with the tool doing
 * the bookkeeping.
 *
 * The page is a document: boxed titles for each side, section headings, and
 * a numbered outline of the round. Their points are red and yours are black,
 * and the colour looks after itself — Tab answers a line, so it goes in a
 * level and changes speaker; Shift+Tab backs out. The numbering is Docs'
 * own, 1. a. i., and every one of their points that nothing has been said
 * under yet is marked, and counted at the top, so a rebuttal can be prepped
 * by clearing the marks.
 *
 * It pastes a flow straight out of Google Docs and copies one back in, and
 * everything is kept in this browser, per account, one flow per round.
 */

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
const K = () => (isMac() ? "⌘" : "Ctrl+");
const A = () => (isMac() ? "⌥" : "Alt+");

interface Section { pos: number; kind: "box" | "head"; text: string; who: string; theirs: number; open: number }
interface SlashState { q: string; x: number; y: number; i: number }
interface Cmd { id: string; group: string; label: string; key?: string; run: () => void }

/** A flow line that updates in place, so indenting slides and a speaker change fades. */
class ItemView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  constructor(node: PMNode) {
    this.dom = document.createElement("div");
    this.dom.className = "df-item";
    this.contentDOM = document.createElement("span");
    this.contentDOM.className = "df-t";
    this.dom.appendChild(this.contentDOM);
    this.set(node);
  }
  set(node: PMNode) {
    this.dom.setAttribute("data-depth", String(node.attrs.depth));
    this.dom.setAttribute("data-who", node.attrs.who);
    if (node.attrs.hl) this.dom.setAttribute("data-hl", node.attrs.hl); else this.dom.removeAttribute("data-hl");
  }
  update(node: PMNode) {
    if (node.type !== schema.nodes.item) return false;
    this.set(node);
    return true;
  }
}

/** The block the cursor is in, and blocks with nothing in them, for the hint and the glow. */
const herePlugin = new Plugin({
  props: {
    decorations(state) {
      const decos: Decoration[] = [];
      const { $from } = state.selection;
      const i = $from.depth >= 1 ? $from.index(0) : -1;
      let pos = 0;
      state.doc.forEach((n, _off, idx) => {
        const cls = [idx === i ? "df-here" : "", n.content.size === 0 ? "df-empty" : ""].filter(Boolean).join(" ");
        if (cls) decos.push(Decoration.node(pos, pos + n.nodeSize, { class: cls }));
        pos += n.nodeSize;
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
});

const SLASH = [
  { id: "box-neg", label: "Box — NEG", hint: "a boxed title", run: () => C.setBlock("box", { who: "us" }, "NEG") },
  { id: "box-aff", label: "Box — AFF", hint: "a boxed title", run: () => C.setBlock("box", { who: "them" }, "AFF") },
  { id: "box-weigh", label: "Box — Weighing", hint: "a boxed title", run: () => C.setBlock("box", { who: "us" }, "Weighing") },
  { id: "box", label: "Box", hint: "a boxed title of your own", run: () => C.setBlock("box", { who: "us" }, "") },
  { id: "ov", label: "Heading — OV", hint: "their overview", run: () => C.setBlock("head", { who: "them" }, "OV") },
  { id: "head", label: "Heading", hint: "a section: 1--water demand", run: () => C.setBlock("head", { who: "them" }, "") },
  { id: "theirs", label: "Their point", hint: "a new red line at the top level", run: () => C.setBlock("item", { depth: 0, who: "them" }, "") },
  { id: "para", label: "Paragraph", hint: "prose — a pre-written block", run: () => C.setBlock("para", {}, "") },
  { id: "evidence", label: "Evidence…", hint: "search your library by header", run: null as null | (() => Command) },
];

export default function DocFlow({ owner, me }: { owner?: string; me?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const bus = useRef<Bus | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openCursor = useRef(-1);

  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [tally, setTally] = useState<Tally>({ theirs: 0, open: 0, ours: 0, openAt: [] });
  const [bump, setBump] = useState(0);
  const [outline, setOutline] = useState<Section[]>([]);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const slashRef = useRef<SlashState | null>(null);
  slashRef.current = slash;
  const [panel, setPanel] = useState<{ q: string; i: number } | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const index = useRef<Entry[] | null>(null);
  const [toastMsg, setToastMsg] = useState<{ text: string; undo?: () => void; n: number } | null>(null);
  const [side, setSide] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);

  /* ------------------------------------------------------------ toast */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((text: string, undoFn?: () => void) => {
    setToastMsg({ text, undo: undoFn, n: Date.now() });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), undoFn ? 4200 : 2200);
  }, []);

  /* ------------------------------------------------------------ the flows this account keeps */
  useEffect(() => {
    let list = listDocs(owner);
    if (!list.length) {
      const id = newId();
      saveDoc(owner, id, blankDoc().toJSON(), "Round 1");
      list = listDocs(owner);
    }
    setDocs(list);
    setCurrent(list[0].id);
    setName(list[0].name);
  }, [owner]);

  const run = useCallback((cmd: Command) => {
    const v = view.current;
    if (!v) return false;
    const ok = cmd(v.state, v.dispatch, v);
    v.focus();
    return ok;
  }, []);

  /* ------------------------------------------------------------ outline: boxes, headings, what is open under each */
  const survey = useCallback((doc: PMNode) => {
    const secs: Section[] = [];
    let sec: Section | null = null;
    const items: PMNode[] = [];
    doc.forEach((n, pos, i) => {
      if (n.type === schema.nodes.box || n.type === schema.nodes.head) {
        sec = { pos, kind: n.type === schema.nodes.box ? "box" : "head", text: n.textContent || (n.type === schema.nodes.box ? "Untitled box" : "Untitled heading"), who: n.attrs.who, theirs: 0, open: 0 };
        secs.push(sec);
        return;
      }
      if (n.type === schema.nodes.item && sec && n.attrs.who === "them" && n.textContent.trim()) {
        sec.theirs++;
        const next = i + 1 < doc.childCount ? doc.child(i + 1) : null;
        if (!(next && next.type === schema.nodes.item && next.attrs.depth > n.attrs.depth)) sec.open++;
      }
      items.push(n);
    });
    setOutline(secs);
  }, []);

  /* ------------------------------------------------------------ the editor, one per flow */
  useEffect(() => {
    if (!current || !mount.current) return;
    const json = loadDoc(owner, current);
    let doc: PMNode;
    try { doc = json ? PMNode.fromJSON(schema, json) : blankDoc(); } catch { doc = blankDoc(); }

    let lastOpen = -1;
    const onTally = (t: Tally) => {
      setTally(t);
      if (lastOpen !== -1 && t.open !== lastOpen) setBump((b) => b + 1);
      lastOpen = t.open;
    };

    const slashPlugin = new Plugin({
      view: () => ({
        update(v) {
          const { $from, empty } = v.state.selection;
          const node = $from.parent;
          const text = node.textContent;
          if (empty && $from.depth === 1 && text.startsWith("/") && $from.parentOffset === text.length && !/\s/.test(text)) {
            const c = v.coordsAtPos($from.pos);
            const box = root.current?.getBoundingClientRect();
            setSlash((s) => ({ q: text.slice(1).toLowerCase(), x: c.left - (box?.left || 0), y: c.bottom - (box?.top || 0) + 6, i: s && s.q === text.slice(1).toLowerCase() ? s.i : 0 }));
          } else if (slashRef.current) setSlash(null);
        },
      }),
      props: {
        handleKeyDown(v, e) {
          const s = slashRef.current;
          if (!s) return false;
          const items = SLASH.filter((x) => !s.q || x.label.toLowerCase().includes(s.q) || x.id.includes(s.q));
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setSlash({ ...s, i: (s.i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length) });
            return true;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            const it = items[s.i];
            if (!it) return false;
            e.preventDefault();
            chooseSlash(it.id);
            return true;
          }
          if (e.key === "Escape") { setSlash(null); return true; }
          return false;
        },
      },
    });

    const km = keymap({
      Enter: C.enter,
      "Shift-Enter": C.answer,
      Tab: C.tab,
      "Shift-Tab": C.outdent,
      "Mod-Enter": C.nextPoint,
      Backspace: chainCommands(C.backspace, baseKeymap.Backspace),
      "Mod-b": toggleMark(schema.marks.strong),
      "Mod-i": toggleMark(schema.marks.em),
      "Mod-u": toggleMark(schema.marks.underline),
      "Mod-z": undo,
      "Mod-y": redo,
      "Shift-Mod-z": redo,
      "Alt-t": C.toggleWho,
      "Alt-y": C.highlight("yellow"),
      "Alt-g": C.highlight("green"),
      "Alt-b": C.highlight("cyan"),
      "Alt-p": C.highlight("pink"),
      "Alt-ArrowUp": moveLine(-1),
      "Alt-ArrowDown": moveLine(1),
    });

    const state = EditorState.create({
      doc,
      plugins: [history(), slashPlugin, km, keymap(baseKeymap), surveyPlugin(onTally), herePlugin],
    });
    const v = new EditorView({ mount: mount.current }, {
      state,
      nodeViews: { item: (node) => new ItemView(node) },
      transformPastedHTML: (html) => fromDocsHtml(html),
      handleDOMEvents: {
        // The number in front of a line is a switch: click it and the line
        // changes speaker.
        mousedown(vw, e) {
          const t = e.target as HTMLElement;
          const item = t.closest && (t.closest(".df-item") as HTMLElement | null);
          if (!item || t.closest(".df-t")) return false;
          const text = item.querySelector(".df-t") as HTMLElement;
          if (!text || (e as MouseEvent).clientX >= text.getBoundingClientRect().left - 2) return false;
          const pos = vw.posAtDOM(text, 0) - 1;
          const node = vw.state.doc.nodeAt(pos);
          if (!node || node.type !== schema.nodes.item) return false;
          e.preventDefault();
          vw.dispatch(vw.state.tr.setNodeMarkup(pos, null, { ...node.attrs, who: node.attrs.who === "them" ? "us" : "them" }));
          return true;
        },
      },
      dispatchTransaction(tr) {
        const next = v.state.apply(tr);
        v.updateState(next);
        if (tr.docChanged) {
          survey(next.doc);
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => {
            saveDoc(owner, current, next.doc.toJSON());
            setDocs(listDocs(owner));
          }, 400);
        }
      },
    });
    view.current = v;
    survey(doc);
    // Somewhere to start typing: the end of the first empty line, or the end.
    let at = doc.content.size - 1;
    doc.forEach((n, pos) => { if (n.type === schema.nodes.item && n.content.size === 0 && at === doc.content.size - 1) at = pos + 1; });
    v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(Math.max(1, at)))));
    v.focus();
    return () => {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveDoc(owner, current, v.state.doc.toJSON()); }
      v.destroy();
      view.current = null;
    };
    // chooseSlash reads state through refs; the editor is rebuilt only for a different flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, owner, survey]);

  /* ------------------------------------------------------------ the rest of the room */
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const off = polish(el);
    bus.current = openBus(owner, () => {});
    return () => { off(); bus.current?.close(); };
  }, [owner]);

  /** Move the line the cursor is in up or down past its neighbour. */
  function moveLine(dir: -1 | 1): Command {
    return (state, dispatch) => {
      const i = state.selection.$from.index(0);
      const j = i + dir;
      if (j < 0 || j >= state.doc.childCount) return true;
      if (!dispatch) return true;
      const a = C.posOf(state.doc, Math.min(i, j));
      const first = state.doc.child(Math.min(i, j));
      const second = state.doc.child(Math.max(i, j));
      const offset = state.selection.from - C.posOf(state.doc, i);
      let tr = state.tr.replaceWith(a, a + first.nodeSize + second.nodeSize, [second, first]);
      const newStart = dir < 0 ? a : a + second.nodeSize;
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tr.doc.content.size, newStart + offset))));
      dispatch(tr.scrollIntoView());
      return true;
    };
  }

  function chooseSlash(id: string) {
    const v = view.current;
    if (!v) return;
    setSlash(null);
    if (id === "evidence") {
      // clear the "/..." first, then search
      const { $from } = v.state.selection;
      v.dispatch(v.state.tr.delete($from.start(), $from.end()));
      openPanel("/");
      return;
    }
    const it = SLASH.find((x) => x.id === id);
    if (it && it.run) run(it.run());
  }

  /* ------------------------------------------------------------ jumping */
  const jump = useCallback((pos: number) => {
    const v = view.current;
    if (!v) return;
    const $p = v.state.doc.resolve(Math.min(v.state.doc.content.size, pos + 1));
    v.dispatch(v.state.tr.setSelection(TextSelection.near($p)).scrollIntoView());
    v.focus();
    const dom = v.nodeDOM(pos) as HTMLElement | null;
    if (dom && dom.classList) { dom.classList.remove("df-flash"); void dom.offsetWidth; dom.classList.add("df-flash"); }
  }, []);
  const nextOpen = useCallback(() => {
    const v = view.current;
    if (!v) return;
    const at = tally.openAt;
    if (!at.length) { toast("Everything of theirs has an answer"); return; }
    const here = v.state.selection.from;
    const next = at.find((p) => p > here) ?? at[0];
    openCursor.current = next;
    jump(next);
  }, [tally.openAt, jump, toast]);

  /* ------------------------------------------------------------ copy and save */
  const copyForDocs = useCallback(async () => {
    const v = view.current;
    if (!v) return;
    const html = toDocsHtml(v.state.doc);
    const text = toPlainText(v.state.doc);
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      })]);
      toast("Copied — paste it into a Google Doc");
    } catch {
      try { await navigator.clipboard.writeText(text); toast("Copied as text"); } catch { toast("The clipboard said no"); }
    }
  }, [toast]);
  const saveDocx = useCallback(async () => {
    const v = view.current;
    if (!v) return;
    const { flowDocx } = await import("@/lib/docflow/docx");
    const { blob, filename } = await flowDocx(v.state.doc, name);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
    toast("Saved " + filename);
  }, [name, toast]);

  /* ------------------------------------------------------------ flows: new, open, rename, delete */
  const newFlow = useCallback(() => {
    const id = newId();
    const n = `Round ${docs.length + 1}`;
    saveDoc(owner, id, blankDoc().toJSON(), n);
    setDocs(listDocs(owner));
    setCurrent(id); setName(n);
    toast("New flow — " + n);
  }, [docs.length, owner, toast]);
  const openFlow = useCallback((d: DocMeta) => {
    if (d.id === current) return;
    setCurrent(d.id); setName(d.name);
  }, [current]);
  const commitName = useCallback((id: string, value: string) => {
    const v = value.trim() || "Untitled flow";
    renameDoc(owner, id, v);
    setDocs(listDocs(owner));
    if (id === current) setName(v);
    setRenaming(null);
  }, [owner, current]);
  const deleteFlow = useCallback((d: DocMeta) => {
    const gone = removeDoc(owner, d.id);
    let list = listDocs(owner);
    if (!list.length) { const id = newId(); saveDoc(owner, id, blankDoc().toJSON(), "Round 1"); list = listDocs(owner); }
    setDocs(list);
    if (d.id === current) { setCurrent(list[0].id); setName(list[0].name); }
    toast(`Deleted “${d.name}”`, gone ? () => { restoreDoc(owner, gone.meta, gone.json); setDocs(listDocs(owner)); setCurrent(gone.meta.id); setName(gone.meta.name); } : undefined);
  }, [owner, current, toast]);

  /* ------------------------------------------------------------ the command panel, and evidence */
  const openPanel = useCallback((q = "") => { setPanel({ q, i: 0 }); }, []);
  const closePanel = useCallback(() => { setPanel(null); view.current?.focus(); }, []);

  const commands: Cmd[] = useMemo(() => [
    { id: "next", group: "Flow", label: "Their next point", key: K() + "Enter", run: () => run(C.nextPoint) },
    { id: "answer", group: "Flow", label: "Answer this line", key: "Shift+Enter", run: () => run(C.answer) },
    { id: "who", group: "Flow", label: "Swap who said it", key: A() + "T", run: () => run(C.toggleWho) },
    { id: "open", group: "Flow", label: "Next thing of theirs with no answer", key: A() + "N", run: () => nextOpen() },
    { id: "evidence", group: "Evidence", label: "Answer this from your evidence", key: K() + "/", run: () => openPanel("/") },
    ...(Object.keys(HIGHLIGHTS) as Hl[]).map((h) => ({ id: "hl-" + h, group: "Highlight", label: `Highlight ${HIGHLIGHTS[h].label.toLowerCase()}`, key: A() + ({ yellow: "Y", green: "G", cyan: "B", pink: "P" } as Record<Hl, string>)[h], run: () => run(C.highlight(h)) })),
    { id: "box-neg", group: "Insert", label: "Box — NEG", run: () => run(C.setBlock("box", { who: "us" }, "NEG")) },
    { id: "box-aff", group: "Insert", label: "Box — AFF", run: () => run(C.setBlock("box", { who: "them" }, "AFF")) },
    { id: "box-weigh", group: "Insert", label: "Box — Weighing", run: () => run(C.setBlock("box", { who: "us" }, "Weighing")) },
    { id: "head", group: "Insert", label: "Heading", run: () => run(C.setBlock("head", { who: "them" }, "")) },
    { id: "para", group: "Insert", label: "Paragraph", run: () => run(C.setBlock("para", {}, undefined)) },
    { id: "copy", group: "Out", label: "Copy for Google Docs", run: () => copyForDocs() },
    { id: "docx", group: "Out", label: "Save as .docx", run: () => saveDocx() },
    { id: "new", group: "Flows", label: "New flow", run: () => newFlow() },
    ...docs.filter((d) => d.id !== current).map((d) => ({ id: "go-" + d.id, group: "Flows", label: "Open · " + d.name, run: () => openFlow(d) })),
    { id: "side", group: "View", label: side ? "Hide the side panel" : "Show the side panel", run: () => setSide((s) => !s) },
  ], [run, nextOpen, openPanel, copyForDocs, saveDocx, newFlow, docs, current, openFlow, side]);

  const evMode = !!panel && panel.q.startsWith("/");
  const listed: Cmd[] = useMemo(() => {
    if (!panel || evMode) return [];
    const q = panel.q.trim().toLowerCase();
    return commands.filter((c) => !q || c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }, [panel, evMode, commands]);

  // evidence mode: the current line is what is being answered
  const answering = useMemo(() => {
    if (!evMode) return "";
    const v = view.current;
    return v ? v.state.selection.$from.parent.textContent.trim() : "";
  }, [evMode]);
  useEffect(() => {
    if (!panel || !evMode) { setHits([]); return; }
    let dead = false;
    (async () => {
      if (index.current === null) index.current = await library(owner);
      if (dead) return;
      const q = panel.q.slice(1).trim() || answering;
      setHits(q ? find(index.current || [], q, 20) : []);
    })();
    return () => { dead = true; };
  }, [panel, evMode, answering, owner]);

  const takeHit = useCallback(async (h: Hit, send: boolean) => {
    setPanel(null);
    const entry = (index.current || []).find((e) => e.id === h.id);
    const tags = entry && entry.a && entry.a.length ? entry.a : [h.title];
    run(C.answerWith(tags));
    if (!send) { toast(`${tags.length} answer${tags.length === 1 ? "" : "s"} from “${h.title}”`); return; }
    const ok = await sendToEvidence(owner, h);
    if (ok) { bus.current?.post({ kind: "send-changed", title: h.title }); toast(`Answered from “${h.title}” — and it is in your send doc`); }
    else toast(`Answered from “${h.title}” — Evidence could not send it`);
  }, [owner, run, toast]);

  const panelKey = (e: React.KeyboardEvent) => {
    if (!panel) return;
    const n = evMode ? hits.length : listed.length;
    if (e.key === "Escape") { e.preventDefault(); closePanel(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setPanel({ ...panel, i: (panel.i + (e.key === "ArrowDown" ? 1 : -1) + n) % n });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (evMode) { const h = hits[panel.i]; if (h) takeHit(h, !e.shiftKey); return; }
      const c = listed[panel.i];
      if (c) { setPanel(null); setTimeout(() => c.run(), 0); }
    }
  };

  /* ------------------------------------------------------------ keys that work anywhere on the page */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (mod && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); panel ? closePanel() : openPanel(); return; }
      if (mod && e.key === "/") { e.preventDefault(); openPanel("/"); return; }
      if (e.altKey && !mod && e.code === "KeyN") { e.preventDefault(); nextOpen(); return; }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [panel, openPanel, closePanel, nextOpen]);

  /* ------------------------------------------------------------ the clock */
  const SP = useMemo(() => speeches("pro"), []);
  const [sp, setSp] = useState(0);
  const [left, setLeft] = useState<number>(SP[0].secs);
  const [running, setRunning] = useState<null | "sp" | "pro" | "con">(null);
  const [prep, setPrep] = useState({ pro: PREP_DEFAULT, con: PREP_DEFAULT });
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      if (running === "sp") setLeft((s) => { if (s <= 1) { setRunning(null); toast(SP[sp].long + " — time"); return 0; } return s - 1; });
      else setPrep((p) => { const k = running; if (p[k] <= 1) { setRunning(null); toast((k === "pro" ? "Pro" : "Con") + " is out of prep"); return { ...p, [k]: 0 }; } return { ...p, [k]: p[k] - 1 }; });
    }, 1000);
    return () => clearInterval(t);
  }, [running, sp, SP, toast]);
  const toSpeech = (i: number) => { const n = (i + SP.length) % SP.length; setSp(n); setLeft(SP[n].secs); setRunning(null); };

  /* ------------------------------------------------------------ drawing */
  const slashItems = slash ? SLASH.filter((x) => !slash.q || x.label.toLowerCase().includes(slash.q) || x.id.includes(slash.q)) : [];

  return (
    <div className={"dfl" + (side ? "" : " noside")} ref={root}>
      <header className="dtop">
        <Link className="back mono" href="/tools" title="Back to the tools">←</Link>
        <div className="brand mono">Doc flow</div>
        <div className="dclock mono" role="group" aria-label="Speech clock">
          <button type="button" onClick={() => toSpeech(sp - 1)} aria-label="The speech before">‹</button>
          <button type="button" className="sp" onClick={() => toSpeech(sp + 1)} title={SP[sp].long}>{SP[sp].name}</button>
          <button type="button" onClick={() => toSpeech(sp + 1)} aria-label="The speech after">›</button>
          <span className={"tm" + (left <= 30 ? " low" : "") + (running === "sp" ? " on" : "")}>{clock(left)}</span>
          <button type="button" className={"play" + (running === "sp" ? " on" : "")} onClick={() => setRunning((r) => (r === "sp" ? null : "sp"))} aria-label="Start or pause">{running === "sp" ? "❚❚" : "▶"}</button>
          <button type="button" onClick={() => { setLeft(SP[sp].secs); setRunning(null); }} aria-label="Reset">↺</button>
          <button type="button" className={"pp" + (running === "pro" ? " on" : "")} onClick={() => setRunning((r) => (r === "pro" ? null : "pro"))}>Pro prep {clock(prep.pro)}</button>
          <button type="button" className={"pp" + (running === "con" ? " on" : "")} onClick={() => setRunning((r) => (r === "con" ? null : "con"))}>Con prep {clock(prep.con)}</button>
        </div>
        <div className="spacer" />
        <button type="button" key={bump} className={"tally mono" + (tally.open ? " has" : " clear")} onClick={nextOpen}
          title={`${A()}N goes to the next one`}>
          <i className="dot" />
          {tally.open ? `${tally.open} unanswered` : "all answered"}
          <span className="of">{tally.theirs} of theirs</span>
        </button>
        <button type="button" className="dbtn ink" onClick={() => openPanel()}>Commands <kbd>{K()}K</kbd></button>
        <button type="button" className="dbtn" onClick={copyForDocs} title="Numbered, red and highlighted, as a Doc">Copy for Docs</button>
        <button type="button" className="dbtn" onClick={saveDocx}>.docx</button>
        <a className="dbtn" href="/tools/evidence" target="break-evidence" title="Open Evidence beside this">Evidence ↗</a>
      </header>

      <div className="dbody">
        <aside className="dside" aria-label="Your flows and this flow's outline">
          <div className="dsec">
            <div className="dsh mono"><span>Your flows</span><button type="button" onClick={newFlow} title="A new flow">+ New</button></div>
            <ul className="dlist">
              {docs.map((d) => (
                <li key={d.id} className={d.id === current ? "on" : ""}>
                  {renaming === d.id ? (
                    <input autoFocus defaultValue={d.name} maxLength={60}
                      onBlur={(e) => commitName(d.id, e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") commitName(d.id, (e.target as HTMLInputElement).value); if (e.key === "Escape") setRenaming(null); }} />
                  ) : (
                    <button type="button" className="dname" onClick={() => (d.id === current ? setRenaming(d.id) : openFlow(d))}
                      title={d.id === current ? "Click again to rename" : "Open"}>
                      <span>{d.name}</span>
                      <small className="mono">{new Date(d.updated).toLocaleDateString([], { month: "short", day: "numeric" })}</small>
                    </button>
                  )}
                  <button type="button" className="dx" onClick={() => deleteFlow(d)} aria-label={`Delete ${d.name}`} title="Delete this flow">×</button>
                </li>
              ))}
            </ul>
          </div>
          <div className="dsec grow">
            <div className="dsh mono"><span>On this flow</span></div>
            {outline.length ? (
              <ul className="dout">
                {outline.map((s) => (
                  <li key={s.pos} className={s.kind + " " + s.who}>
                    <button type="button" onClick={() => jump(s.pos)}>
                      <span>{s.text}</span>
                      {s.theirs ? <small className={"mono" + (s.open ? " open" : "")}>{s.open ? `${s.open} open` : "✓"}</small> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="dnone">Boxes and headings you add show up here to jump between.</p>}
          </div>
          <div className="dkeys mono">
            <span><kbd>Tab</kbd> answer</span>
            <span><kbd>Shift+Tab</kbd> back out</span>
            <span><kbd>{K()}Enter</kbd> their next point</span>
            <span><kbd>/</kbd> boxes, headings, evidence</span>
            <span><kbd>{A()}T</kbd> or click a number — swap speaker</span>
            <span><kbd>{A()}Y</kbd><kbd>{A()}G</kbd> highlight</span>
          </div>
        </aside>

        <main className="dpage">
          <div className="dpaper">
            <input className="dtitle" value={name} placeholder="Untitled flow" spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onBlur={(e) => current && commitName(current, e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); view.current?.focus(); } }} />
            <div className="ddoc" ref={mount} />
          </div>
        </main>
      </div>

      {slash && slashItems.length > 0 && (
        <div className="dslash" style={{ left: slash.x, top: slash.y }}>
          {slashItems.map((it, i) => (
            <button type="button" key={it.id} className={i === slash.i ? "on" : ""}
              onMouseDown={(e) => { e.preventDefault(); chooseSlash(it.id); }}>
              <b>{it.label}</b><small>{it.hint}</small>
            </button>
          ))}
        </div>
      )}

      {panel && (
        <div className="dscrim" onMouseDown={(e) => { if (e.target === e.currentTarget) closePanel(); }}>
          <div className={"dpal" + (evMode ? " ev" : "")}>
            <div className="dpin">
              <span className="glyph mono">{evMode ? "/" : "›"}</span>
              <input autoFocus value={panel.q} placeholder="Run a command — or / to answer from your evidence"
                onChange={(e) => setPanel({ q: e.target.value, i: 0 })} onKeyDown={panelKey} spellCheck={false} />
            </div>
            {evMode && answering && <div className="dpsrc">Answering <b>{answering}</b></div>}
            <ul>
              {evMode
                ? (hits.length ? hits.map((h, i) => (
                  <li key={(h.id || "") + i} className={i === panel.i ? "on" : ""} onMouseEnter={() => setPanel({ ...panel, i })}
                    onMouseDown={(e) => { e.preventDefault(); takeHit(h, !e.shiftKey); }}>
                    <span className="lb">{h.title}<small>/{h.trigger}{h.path ? " · " + h.path : ""}{h.cards ? ` · ${h.cards} card${h.cards === 1 ? "" : "s"}` : ""}</small></span>
                  </li>
                )) : <li className="empty">{index.current && !index.current.length ? "Nothing in your Evidence library yet." : "Type what you are answering."}</li>)
                : listed.map((c, i) => (
                  <li key={c.id} className={i === panel.i ? "on" : ""} onMouseEnter={() => setPanel({ ...panel, i })}
                    onMouseDown={(e) => { e.preventDefault(); setPanel(null); setTimeout(() => c.run(), 0); }}>
                    <span className="lb">{c.label}<small>{c.group}</small></span>{c.key && <kbd>{c.key}</kbd>}
                  </li>
                ))}
            </ul>
            <div className="dpfoot mono">
              {evMode
                ? <><span><kbd>Enter</kbd> answer + send the block</span><span><kbd>Shift+Enter</kbd> answer only</span><span><kbd>Esc</kbd> close</span></>
                : <><span><kbd>↑↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>/</kbd> your evidence</span><span><kbd>Esc</kbd> close</span></>}
            </div>
          </div>
        </div>
      )}

      {toastMsg && (
        <div className="dtoast mono" key={toastMsg.n} style={{ ["--life" as any]: toastMsg.undo ? "4200ms" : "2200ms" }}>
          {toastMsg.text}
          {toastMsg.undo && <button type="button" onClick={() => { toastMsg.undo?.(); setToastMsg(null); }}>Undo</button>}
        </div>
      )}
    </div>
  );
}
