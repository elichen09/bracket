"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { EditorState, TextSelection, Plugin, type Command } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { Node as PMNode } from "prosemirror-model";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark, chainCommands } from "prosemirror-commands";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  ySyncPlugin, yUndoPlugin, yCursorPlugin, undoCommand, redoCommand,
  initProseMirrorDoc, prosemirrorJSONToYXmlFragment, prosemirrorToYXmlFragment,
} from "y-prosemirror";
import { schema, surveyPlugin, blankDoc, type Hl } from "@/lib/docflow/schema";
import * as C from "@/lib/docflow/commands";
import { fromDocsHtml, toDocsHtml, toPlainText } from "@/lib/docflow/io";
import FlowPicker, { worthAsking, type PickerCurrent } from "./FlowPicker";
import Presence from "./Presence";
import { listDocs, loadDoc, saveDoc, renameDoc, removeDoc, restoreDoc, newId, archiveAll, fetchDoc, type DocMeta } from "@/lib/docflow/store";
import { deleteRound, restoreRound, summarizeDoc, docHasWriting } from "@/lib/pastflows";
import { ACTIONS, ACTION, comboOf, keyLabel, refuse, loadKeys, saveKeys, keyFor, actionFor, bind, type Overrides } from "@/lib/docflow/keys";
import { loadPieces, savePieces, newPieceId, titleFrom, fromDoc, merge, type Piece, type Draft } from "@/lib/docflow/rhetoric";
import { stopsOf, toggleStop, setStop, reorder, clearStops, visionPlugin, visionKey, type Stop } from "@/lib/docflow/vision";
import { openRoom, MATE_COLORS, type Room, type RoomStatus, type Mate } from "@/lib/docflow/room";
import { newCode, tidyCode } from "@/lib/flow/share";
import { library, find, sendToEvidence, blockTags, readBins, setBinUse, type Entry, type Hit, type Tag, type Bins } from "@/lib/flow/cards";
import { openBus, type Bus } from "@/lib/toolsBus";
import { speeches, clock, PREP_DEFAULT } from "@/lib/flow/format";
import { polish } from "@/lib/evidence/polish";
import "./docflow.css";
import "./finish.css";
import ThemePicker from "./ThemePicker";
import Ico from "./Ico";
import { useFitBar } from "./fitBar";
import FullBtn, { useFullscreen } from "./FullBtn";
import { justHopped, markHop } from "@/lib/toolsHop";

/**
 * Doc flow — flowing the way a Google Doc gets flowed, with the tool doing
 * the bookkeeping.
 *
 * The page is a document: boxed titles for each side, section headings, and
 * a numbered outline of the round. Their points are red and yours are black,
 * and the colour looks after itself — Tab answers a line, so it goes in a
 * level and changes speaker; Shift+Tab backs out. The numbering is Docs' own.
 *
 * Beside it is your rhetoric, the things you say every round, ready to drop
 * onto a line or call up with /. A room code puts your partner in the same
 * document, typing into it with you. Every key can be moved.
 *
 * The document is a Yjs CRDT under ProseMirror, so that two people can type
 * into it at once; alone, that costs nothing. What is kept is ProseMirror's
 * JSON, in this browser, per account, one flow per round.
 */

interface Section { pos: number; kind: "box" | "head"; text: string; who: string }
interface SlashState { q: string; x: number; top: number; bottom: number; i: number }
interface SlashItem { id: string; label: string; hint: string; rhetoric?: boolean }
interface Cmd { id: string; group: string; label: string; key?: string; run: () => void }
interface Live { flowId: string; ydoc: Y.Doc; awareness: Awareness; room: Room | null; ready: boolean; code: string }

const RHET_MIME = "application/x-docflow-rhetoric";
const FRAGMENT = "flow";

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

/** Your partner's caret: a thin bar in their colour, their name above it. */
function caret(user: { name: string; color: string }) {
  const el = document.createElement("span");
  el.className = "df-caret";
  el.style.setProperty("--c", user.color);
  const tag = document.createElement("span");
  tag.className = "df-caret-name";
  tag.textContent = user.name;
  el.append("⁠", tag, "⁠");
  return el;
}

const BUILTIN: SlashItem[] = [
  { id: "box-neg", label: "Box — NEG", hint: "a boxed title" },
  { id: "box-aff", label: "Box — AFF", hint: "a boxed title" },
  { id: "box-weigh", label: "Box — Weighing", hint: "a boxed title" },
  { id: "box", label: "Box", hint: "a boxed title of your own" },
  { id: "ov", label: "Heading — OV", hint: "their overview" },
  { id: "head", label: "Heading", hint: "a section: 1--water demand" },
  { id: "theirs", label: "Their point", hint: "a new red line at the top level" },
  { id: "evidence", label: "Evidence…", hint: "search your library by header" },
];

const preview = (text: string) => C.parseLines(text);

/** A new flow is named for the day it was flowed; the title renames it. */
const roundName = () => `Round — ${new Date().toLocaleDateString([], { month: "short", day: "numeric" })}`;

export default function DocFlow({ owner, me, join, open }: { owner?: string; me?: string; join?: string; open?: string }) {
  const root = useRef<HTMLDivElement>(null);
  // the banner: words while they fit, icons when they do not (fitBar.ts)
  const bar = useRef<HTMLElement>(null);
  useFitBar(bar);
  const fs = useFullscreen(root);
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const ycur = useRef<{ ydoc: Y.Doc; awareness: Awareness } | null>(null);
  const bus = useRef<Bus | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [name, setName] = useState("");
  const nameRef = useRef(name);
  nameRef.current = name;
  const [outline, setOutline] = useState<Section[]>([]);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const slashRef = useRef<SlashState | null>(null);
  slashRef.current = slash;
  const slashBox = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<{ q: string; i: number } | null>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const [hits, setHits] = useState<Hit[]>([]);
  const [binsInfo, setBinsInfo] = useState<{ bins: Bins; counts: Record<string, number> } | null>(null);
  const [binTick, setBinTick] = useState(0);
  // a block chosen from the search, open to its cards
  const [pick, setPick] = useState<null | { hit: Hit; tags: Tag[]; sel: number[]; q: string; i: number; back: string }>(null);
  const index = useRef<Entry[] | null>(null);
  const [toastMsg, setToastMsg] = useState<{ text: string; undo?: () => void; n: number } | null>(null);
  const [side, setSide] = useState(true);

  // keys
  const [keys, setKeys] = useState<Overrides>({});
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const [keysOpen, setKeysOpen] = useState(false);
  const [capturing, setCapturing] = useState<string | null>(null);
  const capturingRef = useRef(capturing);
  capturingRef.current = capturing;
  const K = useCallback((id: string) => keyLabel(keyFor(keys, id)), [keys]);

  // rhetoric
  const [pieces, setPieces] = useState<Piece[]>([]);
  const piecesRef = useRef(pieces);
  piecesRef.current = pieces;
  const [rq, setRq] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; title: string; text: string } | null>(null);
  const [importing, setImporting] = useState<null | { drafts: Draft[] | null }>(null);

  // the right panel: open or a rail, and which of its sections are open — per viewer, per browser
  const [ui, setUi] = useState({ right: true, vis: true, rh: true, shut: [] as string[] });
  const uiKey = "docflow.ui:" + (owner || "");
  useEffect(() => { try { const u = JSON.parse(localStorage.getItem(uiKey) || "null"); if (u) setUi((x) => ({ ...x, ...u })); } catch { /* none kept */ } }, [uiKey]);
  const patchUi = useCallback((p: Partial<typeof ui>) => setUi((x) => { const n = { ...x, ...p }; try { localStorage.setItem(uiKey, JSON.stringify(n)); } catch { /* private */ } return n; }), [uiKey]);
  const right = ui.right;
  const setRight = useCallback((f: (r: boolean) => boolean) => setUi((x) => { const n = { ...x, right: f(x.right) }; try { localStorage.setItem(uiKey, JSON.stringify(n)); } catch { /* private */ } return n; }), [uiKey]);

  // round vision
  const [stops, setStops] = useState<Stop[]>([]);
  const [visionAt, setVisionAt] = useState(-1);
  const visionAtRef = useRef(visionAt);
  visionAtRef.current = visionAt;
  const [speaking, setSpeaking] = useState(false);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const [nameEdit, setNameEdit] = useState<{ pos: number; value: string } | null>(null);
  const dragStop = useRef<number | null>(null);

  // the room
  const live = useRef<Live | null>(null);
  const [gate, setGate] = useState(0);
  const [roomStatus, setRoomStatus] = useState<RoomStatus | null>(null);
  const [mates, setMates] = useState<Mate[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  // Which flow? — asked on the way in, unless a link already said
  const [asking, setAsking] = useState<PickerCurrent | null>(null);
  const color = useMemo(() => MATE_COLORS[Math.floor(Math.random() * MATE_COLORS.length)], []);

  /* ------------------------------------------------------------ toast */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((text: string, undoFn?: () => void) => {
    setToastMsg({ text, undo: undoFn, n: Date.now() });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), undoFn ? 4200 : 2400);
  }, []);

  /* ------------------------------------------------------------ what this account keeps */
  useEffect(() => {
    let dead = false;
    setKeys(loadKeys(owner));
    setPieces(loadPieces(owner));
    (async () => {
      // one asked for by Past flows, brought back from there if need be
      const wanted = open ? await fetchDoc(owner, open) : null;
      if (dead) return;
      if (open) {
        try { const u = new URL(location.href); u.searchParams.delete("open"); history.replaceState(null, "", u.toString()); } catch { /* fine */ }
        if (!wanted) toast("That flow is not in Past flows any more");
      }
      let list = listDocs(owner);
      if (!list.length) { saveDoc(owner, newId(), blankDoc().toJSON(), roundName()); list = listDocs(owner); }
      const first = (wanted && list.find((d) => d.id === open)) || list[0];
      setDocs(list);
      setCurrent(first.id);
      setName(first.name);
      archiveAll(owner);
      if (!open && !join && !justHopped()) {
        const json = loadDoc(owner, first.id);
        const cur = { id: first.id, name: first.name, stats: summarizeDoc(first.id, first.name, json, 0, 0).stats, blank: !docHasWriting(json) };
        if (await worthAsking(owner, "doc", cur) && !dead) setAsking(cur);
      }
    })();
    return () => { dead = true; };
    // toast is stable; the flow to open is read once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);

  const run = useCallback((cmd: Command) => {
    const v = view.current;
    if (!v) return false;
    const ok = cmd(v.state, v.dispatch, v);
    v.focus();
    return ok;
  }, []);

  /* ------------------------------------------------------------ outline: boxes and headings */
  const outlineOf = useCallback((doc: PMNode) => {
    const secs: Section[] = [];
    doc.forEach((n, pos) => {
      if (n.type === schema.nodes.box || n.type === schema.nodes.head) {
        secs.push({ pos, kind: n.type === schema.nodes.box ? "box" : "head", text: n.textContent || (n.type === schema.nodes.box ? "Untitled box" : "Untitled heading"), who: n.attrs.who });
      }
    });
    setOutline(secs);
  }, []);

  /* ------------------------------------------------------------ the slash menu's contents */
  const slashList = useCallback((q: string): SlashItem[] => {
    const s = q.toLowerCase();
    const built = BUILTIN.filter((x) => !s || x.label.toLowerCase().includes(s) || x.id.includes(s));
    const mine = piecesRef.current
      .filter((p) => !s || p.title.toLowerCase().includes(s) || p.text.toLowerCase().includes(s))
      .map((p) => ({ id: "r:" + p.id, label: p.title, hint: (p.group ? p.group + " · " : "") + p.text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 1).join(""), rhetoric: true }));
    // what you wrote yourself first once you are typing a name
    return s ? [...mine, ...built] : [...built, ...mine];
  }, []);

  /* ------------------------------------------------------------ the editor, one per flow */
  useEffect(() => {
    if (!current || !mount.current) return;
    const lv = live.current && live.current.flowId === current ? live.current : null;
    if (lv && !lv.ready) return; // joining: the flow has not arrived yet

    let ydoc: Y.Doc, awareness: Awareness;
    if (lv) ({ ydoc, awareness } = lv);
    else {
      ydoc = new Y.Doc();
      awareness = new Awareness(ydoc);
      const json = loadDoc(owner, current);
      try { prosemirrorJSONToYXmlFragment(schema, json || blankDoc().toJSON(), ydoc.getXmlFragment(FRAGMENT)); }
      catch { prosemirrorJSONToYXmlFragment(schema, blankDoc().toJSON(), ydoc.getXmlFragment(FRAGMENT)); }
    }
    awareness.setLocalStateField("user", { name: me || "Partner", color });
    ycur.current = { ydoc, awareness };
    const frag = ydoc.getXmlFragment(FRAGMENT);
    const { doc, mapping } = initProseMirrorDoc(frag, schema);

    const slashPlugin = new Plugin({
      view: () => ({
        update(v) {
          const { $from, empty } = v.state.selection;
          const text = $from.parent.textContent;
          if (empty && $from.depth === 1 && text.startsWith("/") && $from.parentOffset === text.length && text.length < 40) {
            const c = v.coordsAtPos($from.pos);
            const q = text.slice(1).toLowerCase();
            setSlash((s) => ({ q, x: c.left, top: c.top, bottom: c.bottom, i: s && s.q === q ? s.i : 0 }));
          } else if (slashRef.current) setSlash(null);
        },
      }),
      props: {
        handleKeyDown(_v, e) {
          const s = slashRef.current;
          if (!s) return false;
          const items = slashList(s.q);
          if (!items.length) return false;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setSlash({ ...s, i: (s.i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length });
            return true;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            const it = items[Math.min(s.i, items.length - 1)];
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

    // Only the keys a document always has. Everything else is in the key
    // table, handled on the window, so it can be moved.
    const km = keymap({
      Enter: C.enter,
      Backspace: chainCommands(C.backspace, baseKeymap.Backspace),
      "Mod-b": toggleMark(schema.marks.strong),
      "Mod-i": toggleMark(schema.marks.em),
      "Mod-u": toggleMark(schema.marks.underline),
      "Mod-z": undoCommand,
      "Mod-y": redoCommand,
      "Shift-Mod-z": redoCommand,
    });

    let dropAt: HTMLElement | null = null;
    const clearDrop = () => { if (dropAt) { dropAt.classList.remove("df-drop"); dropAt.removeAttribute("data-drop"); dropAt = null; } };
    const blockAt = (vw: EditorView, e: DragEvent | MouseEvent) => {
      const hit = vw.posAtCoords({ left: e.clientX, top: e.clientY });
      if (!hit) return -1;
      const $p = vw.state.doc.resolve(Math.min(hit.pos, vw.state.doc.content.size));
      return $p.depth >= 1 ? $p.index(0) : Math.min($p.index(0), vw.state.doc.childCount - 1);
    };

    const state = EditorState.create({
      schema,
      doc,
      plugins: [
        ySyncPlugin(frag, { mapping }),
        yCursorPlugin(awareness, { cursorBuilder: caret, selectionBuilder: (u: { color: string }) => ({ style: `background-color: ${u.color}26`, class: "df-sel" }) }),
        yUndoPlugin(),
        slashPlugin, km, keymap(baseKeymap), surveyPlugin, herePlugin, visionPlugin,
      ],
    });
    const v = new EditorView({ mount: mount.current }, {
      state,
      attributes: { spellcheck: "false", autocorrect: "off", autocapitalize: "off" },
      nodeViews: { item: (node) => new ItemView(node) },
      transformPastedHTML: (html) => fromDocsHtml(html),
      handleDrop(vw, e) {
        const de = e as DragEvent;
        const id = de.dataTransfer?.getData(RHET_MIME);
        clearDrop();
        if (!id) return false;
        const p = piecesRef.current.find((x) => x.id === id);
        if (!p) return true;
        e.preventDefault();
        const i = blockAt(vw, de);
        if (i < 0) return true;
        C.insertLines(preview(p.text), i)(vw.state, vw.dispatch);
        vw.focus();
        toast(`“${p.title}” is in`);
        return true;
      },
      handleDOMEvents: {
        dragover(vw, e) {
          if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes(RHET_MIME)) return false;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          const i = blockAt(vw, e);
          const dom = i >= 0 ? (vw.nodeDOM(C.posOf(vw.state.doc, i)) as HTMLElement | null) : null;
          if (dom !== dropAt) {
            clearDrop();
            if (dom && dom.classList) {
              const n = vw.state.doc.child(i);
              dom.classList.add("df-drop");
              dom.setAttribute("data-drop", n.content.size === 0 ? "fill" : n.type === schema.nodes.item ? "answer" : "after");
              dropAt = dom;
            }
          }
          return true;
        },
        dragleave(vw, e) {
          const to = e.relatedTarget as Node | null;
          if (!to || !vw.dom.contains(to)) clearDrop();
          return false;
        },
        // The number in front of a line is a switch: click it and the line
        // changes speaker.
        mousedown(vw, e) {
          const t = e.target as HTMLElement;
          const item = t.closest && (t.closest(".df-item") as HTMLElement | null);
          if (!item || t.closest(".df-t")) return false;
          const text = item.querySelector(".df-t") as HTMLElement;
          if (!text || e.clientX >= text.getBoundingClientRect().left - 2) return false;
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
          outlineOf(next.doc);
          setStops(stopsOf(next.doc));
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => {
            saveDoc(owner, current, next.doc.toJSON());
            setDocs(listDocs(owner));
          }, 400);
        }
      },
    });
    view.current = v;
    outlineOf(doc);
    setStops(stopsOf(doc));
    setVisionAt(-1);
    if (lv) saveDoc(owner, current, doc.toJSON());
    // Somewhere to start typing: the first empty line, or the end.
    let at = doc.content.size - 1;
    doc.forEach((n, pos) => { if (n.type === schema.nodes.item && n.content.size === 0 && at === doc.content.size - 1) at = pos + 1; });
    try { v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(Math.max(1, at))))); } catch { /* an empty flow */ }
    v.focus();
    return () => {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; saveDoc(owner, current, v.state.doc.toJSON()); }
      clearDrop();
      v.destroy();
      view.current = null;
      ycur.current = null;
      if (!live.current || live.current.ydoc !== ydoc) { awareness.destroy(); ydoc.destroy(); }
    };
    // chooseSlash and toast read through refs; the editor is rebuilt only for another flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, owner, gate, outlineOf, slashList]);

  /* ------------------------------------------------------------ the rest of the page */
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
    const { $from } = v.state.selection;
    const clear = () => v.dispatch(v.state.tr.delete($from.start(), $from.end()));
    if (id === "evidence") { clear(); openPanel("/"); return; }
    if (id.startsWith("r:")) {
      const p = piecesRef.current.find((x) => x.id === id.slice(2));
      if (!p) return;
      clear();
      run(C.insertLines(preview(p.text)));
      return;
    }
    const cmd = ({
      "box-neg": C.setBlock("box", { who: "us" }, "NEG"),
      "box-aff": C.setBlock("box", { who: "them" }, "AFF"),
      "box-weigh": C.setBlock("box", { who: "us" }, "Weighing"),
      box: C.setBlock("box", { who: "us" }, ""),
      ov: C.setBlock("head", { who: "them" }, "OV"),
      head: C.setBlock("head", { who: "them" }, ""),
      theirs: C.setBlock("item", { depth: 0, who: "them" }, ""),
    } as Record<string, Command>)[id];
    if (cmd) run(cmd);
  }

  // keep the chosen slash item in view as the arrows move through a long list
  useEffect(() => {
    const el = slashBox.current?.querySelector(".on") as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [slash?.i, slash?.q]);

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

  /* ------------------------------------------------------------ round vision */
  const noVision = useCallback(() => `No round vision yet — ${keyLabel(keyFor(keysRef.current, "stop")) || "the command panel"} marks a line`, []);

  /** Go to a stop. Speaking, the page moves and the cursor stays out of the way; otherwise the cursor goes there too. */
  const goStop = useCallback((i: number, speakingNow = speakingRef.current) => {
    const v = view.current;
    if (!v) return;
    const list = stopsOf(v.state.doc);
    const s = list[i];
    if (!s) { toast(list.length ? `There is no stop ${i + 1}` : noVision()); return; }
    const node = v.state.doc.nodeAt(s.pos)!;
    let tr = v.state.tr.setMeta(visionKey, s.pos);
    if (!speakingNow) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(s.pos + node.nodeSize - 1), -1));
    v.dispatch(tr);
    const dom = v.nodeDOM(s.pos) as HTMLElement | null;
    if (dom && dom.classList) {
      dom.scrollIntoView({ block: "center", behavior: "smooth" });
      dom.classList.remove("df-flash"); void dom.offsetWidth; dom.classList.add("df-flash");
    }
    if (speakingNow) v.dom.blur(); else v.focus();
    setVisionAt(i);
  }, [toast, noVision]);

  const step = useCallback((d: 1 | -1) => {
    const v = view.current;
    if (!v) return;
    const n = stopsOf(v.state.doc).length;
    if (!n) { toast(noVision()); return; }
    const at = visionAtRef.current;
    const next = at < 0 ? (d > 0 ? 0 : n - 1) : at + d;
    if (next < 0 || next >= n) { toast(d > 0 ? "That was the last stop" : "That was the first stop"); return; }
    goStop(next);
  }, [goStop, toast, noVision]);

  const speak = useCallback((on: boolean) => {
    const v = view.current;
    if (on && (!v || !stopsOf(v.state.doc).length)) { toast(noVision()); return; }
    setSpeaking(on);
    speakingRef.current = on;
    if (on) {
      goStop(visionAtRef.current >= 0 ? visionAtRef.current : 0, true);
      toast("Page Down or Space for the next stop · Esc to stop");
    } else if (v) { v.dispatch(v.state.tr.setMeta(visionKey, null)); setVisionAt(-1); v.focus(); }
  }, [goStop, toast, noVision]);

  /** Mark the line the cursor is in, and put its name up to be changed. */
  const markStop = useCallback(() => {
    const v = view.current;
    if (!v) return;
    const before = stopsOf(v.state.doc).length;
    toggleStop(v.state, v.dispatch);
    const after = stopsOf(v.state.doc);
    if (after.length > before) {
      const pos = v.state.selection.$from.before(1);
      const s = after.find((x) => x.pos === pos);
      patchUi({ right: true, vis: true });
      if (s) setNameEdit({ pos, value: s.name });
      toast(`Stop ${after.length} — name it, or Enter to keep “${s?.name}”`);
    } else { toast("Taken out of round vision"); v.focus(); }
  }, [patchUi, toast]);

  const commitStopName = useCallback((back = true) => {
    const ne = nameEdit;
    setNameEdit(null);
    const v = view.current;
    if (!ne || !v) return;
    setStop(ne.pos, ne.value)(v.state, v.dispatch);
    if (back) v.focus();
  }, [nameEdit]);

  const visRef = useRef({ step, speak });
  visRef.current = { step, speak };

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
    const { blob, filename } = await flowDocx(v.state.doc, nameRef.current);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
    toast("Saved " + filename);
  }, [toast]);

  /* ------------------------------------------------------------ the room */
  const leaveRoom = useCallback((quiet = false) => {
    const lv = live.current;
    if (!lv) return;
    lv.room?.leave();
    live.current = null;
    setRoomStatus(null); setMates([]);
    if (!quiet) toast(`Left room ${lv.code} — the flow stays here`);
  }, [toast]);

  const roomHandlers = useCallback((lv: Live) => ({
    onStatus: (s: RoomStatus, detail?: string) => { if (live.current === lv) setRoomStatus(s); if (s === "error") toast("The room would not connect" + (detail ? ` — ${detail}` : "")); },
    onMates: (m: Mate[]) => { if (live.current === lv) setMates(m); },
    onTitle: (t: string) => { renameDoc(owner, lv.flowId, t); setDocs(listDocs(owner)); if (live.current === lv) setName(t); },
  }), [owner, toast]);

  const startRoom = useCallback(() => {
    const y = ycur.current;
    if (!y || !current) return;
    leaveRoom(true);
    const code = newCode(5);
    const lv: Live = { flowId: current, ydoc: y.ydoc, awareness: y.awareness, room: null, ready: true, code };
    live.current = lv;
    setRoomStatus("joining");
    lv.room = openRoom({
      code, ydoc: y.ydoc, awareness: y.awareness, title: () => nameRef.current, fresh: false,
      ...roomHandlers(lv),
      onSynced: () => {},
      onSeed: () => {},
    });
    setShareOpen(true);
  }, [current, leaveRoom, roomHandlers]);

  const joinRoom = useCallback((raw: string) => {
    const code = tidyCode(raw);
    if (code.length < 4) { toast("That code is too short"); return; }
    leaveRoom(true);
    const id = newId();
    saveDoc(owner, id, blankDoc().toJSON(), `Room ${code}`);
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    const lv: Live = { flowId: id, ydoc, awareness, room: null, ready: false, code };
    live.current = lv;
    setRoomStatus("joining");
    setDocs(listDocs(owner));
    setCurrent(id); setName(`Room ${code}`);
    lv.room = openRoom({
      code, ydoc, awareness, title: () => nameRef.current, fresh: true,
      ...roomHandlers(lv),
      onSeed: () => { prosemirrorToYXmlFragment(blankDoc(), ydoc.getXmlFragment(FRAGMENT)); },
      onSynced: (title) => {
        if (live.current !== lv) return;
        lv.ready = true;
        if (title) { renameDoc(owner, id, title); setName(title); }
        setDocs(listDocs(owner));
        setGate((g) => g + 1);
        toast(title ? `In room ${code} — flowing “${title}” together` : `Room ${code} was empty — you started it`);
      },
    });
    setShareOpen(false); setJoinCode("");
  }, [owner, leaveRoom, roomHandlers, toast]);

  // a link with a room code in it goes straight in
  const joined = useRef(false);
  useEffect(() => {
    if (!join || joined.current || !docs.length) return;
    joined.current = true;
    joinRoom(join);
  }, [join, docs.length, joinRoom]);
  useEffect(() => () => { live.current?.room?.leave(); }, []);

  const copyLink = useCallback(async () => {
    const lv = live.current;
    if (!lv) return;
    const url = `${location.origin}/tools/docflow?join=${lv.code}`;
    try { await navigator.clipboard.writeText(url); toast("Link copied — send it to your partner"); } catch { toast(url); }
  }, [toast]);

  /* ------------------------------------------------------------ flows: new, open, rename, delete */
  const newFlow = useCallback(() => {
    leaveRoom(true);
    const id = newId();
    const n = roundName();
    saveDoc(owner, id, blankDoc().toJSON(), n);
    setDocs(listDocs(owner));
    setCurrent(id); setName(n);
    toast("New flow — " + n);
  }, [owner, toast, leaveRoom]);
  const openFlow = useCallback((d: DocMeta) => {
    if (d.id === current) return;
    if (live.current) leaveRoom();
    setCurrent(d.id); setName(d.name);
  }, [current, leaveRoom]);
  const commitName = useCallback((id: string, value: string) => {
    const v = value.trim() || "Untitled flow";
    renameDoc(owner, id, v);
    setDocs(listDocs(owner));
    if (id === current) setName(v);
    if (live.current && live.current.flowId === id) live.current.room?.rename(v);
  }, [owner, current]);
  const deleteFlow = useCallback(async (d: DocMeta) => {
    if (live.current && live.current.flowId === d.id) leaveRoom(true);
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const gone = removeDoc(owner, d.id);
    const rec = await deleteRound(owner, d.id);
    let list = listDocs(owner);
    if (!list.length) { saveDoc(owner, newId(), blankDoc().toJSON(), roundName()); list = listDocs(owner); }
    setDocs(list);
    if (d.id === current) { setCurrent(list[0].id); setName(list[0].name); }
    toast(`Deleted “${d.name}”`, gone ? () => {
      restoreDoc(owner, gone.meta, gone.json);
      if (rec) restoreRound(owner, rec);
      setDocs(listDocs(owner)); setCurrent(gone.meta.id); setName(gone.meta.name);
    } : undefined);
  }, [owner, current, toast, leaveRoom]);

  /* ------------------------------------------------------------ rhetoric */
  const putPieces = useCallback((list: Piece[]) => { setPieces(list); savePieces(owner, list); }, [owner]);
  const saveEditing = useCallback(() => {
    if (!editing) return;
    const text = editing.text.replace(/\s+$/, "");
    if (!text.trim()) { setEditing(null); return; }
    const title = editing.title.trim() || titleFrom(text);
    const now = Date.now();
    if (editing.id) putPieces(piecesRef.current.map((p) => (p.id === editing.id ? { ...p, title, text, updated: now } : p)));
    else putPieces([{ id: newPieceId(), title, text, updated: now }, ...piecesRef.current]);
    setEditing(null);
    toast(`Kept “${title}” — type /${title.split(/\s+/)[0].toLowerCase()} to use it`);
  }, [editing, putPieces, toast]);
  const deletePiece = useCallback((p: Piece) => {
    const before = piecesRef.current;
    putPieces(before.filter((x) => x.id !== p.id));
    toast(`Deleted “${p.title}”`, () => putPieces(before));
  }, [putPieces, toast]);
  const usePiece = useCallback((p: Piece) => {
    if (!view.current) return;
    run(C.insertLines(preview(p.text)));
    toast(`“${p.title}” is in`);
  }, [run, toast]);
  const keepSelection = useCallback(() => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection;
    const text = C.linesText(v.state.doc, from, to);
    if (!text.trim()) { toast("Select the lines to keep first"); return; }
    setRight(() => true);
    patchUi({ rh: true });
    setEditing({ id: null, title: titleFrom(text), text });
  }, [toast, setRight, patchUi]);
  const shownPieces = useMemo(() => {
    const q = rq.trim().toLowerCase();
    return q ? pieces.filter((p) => p.title.toLowerCase().includes(q) || p.text.toLowerCase().includes(q)) : pieces;
  }, [pieces, rq]);

  const grouped = useMemo(() => {
    const order: string[] = [];
    const m = new Map<string, Piece[]>();
    shownPieces.forEach((p) => { const g = p.group || ""; if (!m.has(g)) { m.set(g, []); order.push(g); } m.get(g)!.push(p); });
    order.sort((a, b) => (a === "" ? -1 : b === "" ? 1 : 0));
    return order.map((g) => ({ g, items: m.get(g)! }));
  }, [shownPieces]);
  const deleteGroup = useCallback((g: string) => {
    const before = piecesRef.current;
    const n = before.filter((p) => p.group === g).length;
    putPieces(before.filter((p) => p.group !== g));
    toast(`Deleted “${g}” — ${n} piece${n === 1 ? "" : "s"}`, () => putPieces(before));
  }, [putPieces, toast]);
  const takeImport = useCallback(() => {
    if (!importing?.drafts) return;
    const before = piecesRef.current;
    const { list, added, updated } = merge(before, importing.drafts);
    putPieces(list);
    setImporting(null);
    toast(`${added} new${updated ? `, ${updated} updated` : ""} — type / and a name to use one`, () => putPieces(before));
  }, [importing, putPieces, toast]);
  const pieceCard = (p: Piece) => (
    <div key={p.id} className="rp" draggable
      onDragStart={(e) => { e.dataTransfer.setData(RHET_MIME, p.id); e.dataTransfer.setData("text/plain", p.text); e.dataTransfer.effectAllowed = "copy"; e.currentTarget.classList.add("lift"); }}
      onDragEnd={(e) => e.currentTarget.classList.remove("lift")}
      onMouseDown={(e) => { if ((e.target as HTMLElement).closest("button")) return; e.preventDefault(); }}
      onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; usePiece(p); }}
      title="Click to put it at the cursor · drag it onto a line">
      <div className="rp-h">
        <b>{p.title}</b>
        <span className="rp-act">
          <button type="button" onClick={() => setEditing({ id: p.id, title: p.title, text: p.text })} aria-label={`Edit ${p.title}`} title="Edit">✎</button>
          <button type="button" onClick={() => deletePiece(p)} aria-label={`Delete ${p.title}`} title="Delete">×</button>
        </span>
      </div>
      <div className="rp-lines">
        {preview(p.text).slice(0, 4).map((l, i) => <div key={i} style={{ paddingLeft: l.d * 12 }}>{l.text}</div>)}
      </div>
    </div>
  );

  /* ------------------------------------------------------------ the command panel, and evidence */
  // read the library afresh each time: bins may have changed in Evidence since
  const openPanel = useCallback((q = "") => { index.current = null; setPanel({ q, i: 0 }); }, []);
  const closePanel = useCallback(() => { setPanel(null); setPick(null); view.current?.focus(); }, []);

  /** Every action in the key table, by id. */
  const act = useCallback((id: string) => {
    const hl = (h: Hl) => run(C.highlight(h));
    switch (id) {
      case "tab": return run(C.tab);
      case "outdent": return run(C.outdent);
      case "next": return run(C.nextPoint);
      case "answer": return run(C.answer);
      case "who": return run(C.toggleWho);
      case "up": return run(moveLine(-1));
      case "down": return run(moveLine(1));
      case "hl-yellow": return hl("yellow");
      case "hl-green": return hl("green");
      case "hl-cyan": return hl("cyan");
      case "hl-pink": return hl("pink");
      case "box-neg": return run(C.setBlock("box", { who: "us" }, "NEG"));
      case "box-aff": return run(C.setBlock("box", { who: "them" }, "AFF"));
      case "box-weigh": return run(C.setBlock("box", { who: "us" }, "Weighing"));
      case "head": return run(C.setBlock("head", { who: "them" }, ""));
      case "keep": return keepSelection();
      case "import": setRight(() => true); patchUi({ rh: true }); return setImporting({ drafts: null });
      case "stop": return markStop();
      case "stop-next": return step(1);
      case "stop-prev": return step(-1);
      case "speak": return speak(!speakingRef.current);
      case "rhetoric": return setRight((r) => !r);
      case "commands": return panelRef.current ? closePanel() : openPanel();
      case "evidence": return openPanel("/");
      case "share": return setShareOpen((s) => !s);
      case "keys": return setKeysOpen(true);
      case "copy": return copyForDocs();
      case "docx": return saveDocx();
    }
    const m = id.match(/^stop-(\d)$/);
    if (m) return goStop(Number(m[1]) - 1);
    return undefined;
    // moveLine is a plain function of its argument
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, keepSelection, closePanel, openPanel, copyForDocs, saveDocx, markStop, step, speak, goStop, patchUi, setRight]);
  const actRef = useRef(act);
  actRef.current = act;

  const commands: Cmd[] = useMemo(() => [
    ...ACTIONS.filter((a) => !["tab", "outdent", "commands"].includes(a.id) && !/^stop-\d$/.test(a.id)).map((a) => ({
      id: a.id, group: a.group, label: a.id === "rhetoric" ? (right ? "Hide the right panel" : "Show the right panel") : a.id === "speak" && speaking ? "Stop speaking" : a.label,
      key: keyLabel(keyFor(keys, a.id)) || undefined, run: () => { act(a.id); },
    })),
    ...stops.map((s, i) => ({ id: "go-stop-" + s.pos, group: "Round vision", label: "Go to · " + s.name, key: i < 9 ? keyLabel(keyFor(keys, "stop-" + (i + 1))) || undefined : undefined, run: () => goStop(i) })),
    ...(stops.length ? [{ id: "clear-stops", group: "Round vision", label: "Clear round vision", run: () => { const v = view.current; if (v && confirm("Take every stop out of round vision?")) { clearStops(v.state, v.dispatch); setVisionAt(-1); } } }] : []),
    ...pieces.map((p) => ({ id: "r-" + p.id, group: "Rhetoric", label: "Put in · " + p.title, run: () => usePiece(p) })),
    { id: "new", group: "Flows", label: "New flow", run: () => newFlow() },
    { id: "past", group: "Flows", label: "Past flows — every round you have flowed", run: () => { location.href = "/tools/flows"; } },
    ...docs.filter((d) => d.id !== current).slice(0, 8).map((d) => ({ id: "go-" + d.id, group: "Flows", label: "Open · " + d.name, run: () => openFlow(d) })),
    ...(current ? [{ id: "delete", group: "Flows", label: "Delete this flow", run: () => { const d = docs.find((x) => x.id === current); if (d) deleteFlow(d); } }] : []),
    { id: "side", group: "View", label: side ? "Hide the flows list" : "Show the flows list", run: () => setSide((s) => !s) },
  ], [keys, act, right, speaking, stops, goStop, pieces, usePiece, newFlow, docs, current, openFlow, deleteFlow, side]);

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
  }, [panel, evMode, answering, owner, binTick]);

  // the Evidence bins, switchable from the search mid-round
  useEffect(() => {
    if (!evMode) return;
    let dead = false;
    readBins(owner).then((b) => { if (!dead) setBinsInfo(b); });
    return () => { dead = true; };
  }, [evMode, owner, binTick]);
  const flipBin = useCallback(async (id: string, on: boolean) => {
    await setBinUse(owner, id, !on);
    bus.current?.post({ kind: "bins-changed" });
    index.current = null;
    setBinTick((t) => t + 1);
  }, [owner]);

  /** Answer with some of a block's cards (or all of them), and send those cards along. */
  const answerFrom = useCallback(async (h: Hit, lines: string[], picks: number[] | undefined, send: boolean) => {
    setPanel(null); setPick(null);
    run(C.answerWith(lines));
    const what = `${lines.length} answer${lines.length === 1 ? "" : "s"}`;
    if (!send) { toast(`${what} from “${h.title}”`); return; }
    const ok = await sendToEvidence(owner, h, picks);
    if (ok) { bus.current?.post({ kind: "send-changed", title: h.title }); toast(`${what} from “${h.title}” — and ${picks ? (picks.length === 1 ? "that card is" : "those cards are") : "the block is"} in your send doc`); }
    else toast(`${what} from “${h.title}” — Evidence could not send it`);
  }, [owner, run, toast]);

  /** A block chosen from the search opens to its cards, to take one, several or all. */
  const takeHit = useCallback(async (h: Hit, send: boolean) => {
    const tags = await blockTags(owner, h.id);
    if (!tags.length) {
      const entry = (index.current || []).find((e) => e.id === h.id);
      answerFrom(h, entry && entry.a && entry.a.length ? entry.a : [h.title], undefined, send);
      return;
    }
    setPick({ hit: h, tags, sel: [], q: "", i: 1, back: panel?.q || "/" });
  }, [owner, answerFrom, panel]);

  const pickRows = useMemo(() => {
    if (!pick) return [];
    const f = pick.q.trim().toLowerCase();
    const rows: { all: boolean; tag: Tag | null }[] = [{ all: true, tag: null }];
    pick.tags.filter((t) => !f || (t.title + " " + t.cite).toLowerCase().includes(f)).forEach((t) => rows.push({ all: false, tag: t }));
    return rows;
  }, [pick]);
  const togglePick = (i: number) => {
    if (!pick) return;
    const row = pickRows[i];
    if (!row) return;
    let sel = pick.sel.slice();
    if (row.all) sel = sel.length === pick.tags.length ? [] : pick.tags.map((t) => t.i);
    else if (row.tag) sel = sel.includes(row.tag.i) ? sel.filter((x) => x !== row.tag!.i) : [...sel, row.tag.i];
    setPick({ ...pick, sel, i });
  };
  const commitPick = (send: boolean, at = pick?.i ?? 0) => {
    if (!pick) return;
    const row = pickRows[at];
    let picks = pick.sel.slice();
    if (!picks.length && row) picks = row.all ? pick.tags.map((t) => t.i) : row.tag ? [row.tag.i] : [];
    if (!picks.length) return;
    picks.sort((a, b) => a - b);
    const lines = picks.map((i) => pick.tags.find((t) => t.i === i)!.title);
    answerFrom(pick.hit, lines, picks.length === pick.tags.length ? undefined : picks, send);
  };

  const panelKey = (e: React.KeyboardEvent) => {
    if (!panel) return;
    if (pick) {
      const n = pickRows.length;
      if (e.key === "Escape") { e.preventDefault(); setPanel({ q: pick.back, i: 0 }); setPick(null); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (n) setPick({ ...pick, i: (pick.i + (e.key === "ArrowDown" ? 1 : -1) + n) % n }); return; }
      if (e.key === "Tab" || (e.key === " " && !pick.q)) { e.preventDefault(); togglePick(pick.i); return; }
      if (e.key === "Enter") { e.preventDefault(); commitPick(!e.shiftKey); }
      return;
    }
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

  /* ------------------------------------------------------------ the keys, all of them, on the window */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".fpick")) return;   // Which flow? has the keys
      // choosing a new key for something
      const cap = capturingRef.current;
      if (cap) {
        if (["Control", "Shift", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        if (e.key === "Escape") { setCapturing(null); return; }
        const spec = (e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey ? null : comboOf(e);
        if (spec) { const why = refuse(spec); if (why) { toast(why); return; } }
        const { next, moved } = bind(keysRef.current, cap, spec);
        setKeys(next); saveKeys(owner, next); setCapturing(null);
        toast(spec
          ? `${ACTION.get(cap)?.label} — ${keyLabel(spec)}` + (moved ? ` (taken from “${ACTION.get(moved)?.label}”)` : "")
          : `${ACTION.get(cap)?.label} has no key now`);
        return;
      }
      // Mid-speech, the keys a presentation clicker sends walk the vision too.
      if (speakingRef.current && !panelRef.current) {
        const t = document.activeElement as HTMLElement | null;
        const typing = !!t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA");
        if (e.key === "PageDown" || (e.key === " " && !e.shiftKey && !typing)) { e.preventDefault(); e.stopPropagation(); visRef.current.step(1); return; }
        if (e.key === "PageUp" || (e.key === " " && e.shiftKey && !typing)) { e.preventDefault(); e.stopPropagation(); visRef.current.step(-1); return; }
        if (e.key === "Escape" && !slashRef.current) { e.preventDefault(); e.stopPropagation(); visRef.current.speak(false); return; }
      }
      const spec = comboOf(e);
      if (!spec) return;
      const id = actionFor(keysRef.current, spec);
      if (!id) return;
      const a = ACTION.get(id)!;
      const ed = view.current?.dom;
      const inDoc = !!ed && ed.contains(document.activeElement);
      if (a.scope === "doc" && !inDoc) return;
      // with a menu open under the cursor, its own keys come first
      if (slashRef.current && /^(Enter|Tab|↑|↓|Escape|shift\+Tab)$/.test(spec)) return;
      if (a.scope === "any" && !inDoc && !/mod|alt/.test(spec)) {
        const t = document.activeElement as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      }
      e.preventDefault(); e.stopPropagation();
      actRef.current(id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [owner, toast]);

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
  const slashItems = slash ? slashList(slash.q) : [];
  // the menu opens below the line, or above it when the line is near the bottom
  const slashPos = (() => {
    if (!slash || typeof window === "undefined") return null;
    const below = window.innerHeight - slash.bottom - 16;
    const above = slash.top - 16;
    const up = below < 260 && above > below;
    const room = Math.max(160, Math.min(380, up ? above : below));
    const left = Math.max(12, Math.min(slash.x, window.innerWidth - 332));
    return up ? { left, bottom: window.innerHeight - slash.top + 6, maxHeight: room } : { left, top: slash.bottom + 6, maxHeight: room };
  })();
  const roomCode = live.current?.code || "";
  const waiting = !!live.current && live.current.flowId === current && !live.current.ready;
  const inRoom = !!roomStatus;

  return (
    <div className={"dfl" + (side ? "" : " noside")} ref={root}>
      <header className="dtop" ref={bar}>
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
        <div className="dgap" />
        <div className="dsharewrap">
          <button type="button" className={"dbtn droom" + (inRoom ? " live " + roomStatus : "")} onClick={() => setShareOpen((s) => !s)}>
            {inRoom ? (
              <>
                <i className="pulse" />
                <span className="mono">{roomCode}</span>
                {mates.length ? (
                  <span className="dfaces">{mates.slice(0, 3).map((m) => <b key={m.client} style={{ background: m.color }} title={m.name}>{m.name.slice(0, 1).toUpperCase()}</b>)}</span>
                ) : <small>{roomStatus === "joining" ? "connecting" : "waiting"}</small>}
              </>
            ) : <><Ico n="share" /><span className="lbl">Share</span></>}
          </button>
          <Presence show={!!shareOpen}>{shareOpen && (
            <div className="dsharepop" role="dialog" aria-label="Flow with your partner">
              {inRoom ? (
                <>
                  <div className="dsp-h mono">Room</div>
                  <div className="dsp-code mono">{roomCode}</div>
                  <p className="dsp-p">Your partner types this code in Doc flow, or opens the link. You are both writing this flow.</p>
                  <div className="dsp-mates">
                    <span className="mate"><b style={{ background: color }}>{(me || "Y").slice(0, 1).toUpperCase()}</b>{me || "You"} <small>you</small></span>
                    {mates.map((m) => <span className="mate" key={m.client}><b style={{ background: m.color }}>{m.name.slice(0, 1).toUpperCase()}</b>{m.name}</span>)}
                    {!mates.length && <span className="mate dim">Waiting for your partner…</span>}
                  </div>
                  <div className="dsp-row">
                    <button type="button" className="dbtn ink" onClick={copyLink}>Copy link</button>
                    <button type="button" className="dbtn" onClick={() => { leaveRoom(); setShareOpen(false); }}>Leave</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="dsp-h mono">Flow with your partner</div>
                  <p className="dsp-p">Start a room on this flow and read out the code. Whatever either of you types shows up for both.</p>
                  <button type="button" className="dbtn ink wide" onClick={startRoom}>Start a room on “{name || "this flow"}”</button>
                  <div className="dsp-or mono">or join theirs</div>
                  <form className="dsp-row" onSubmit={(e) => { e.preventDefault(); joinRoom(joinCode); }}>
                    <input className="mono" value={joinCode} onChange={(e) => setJoinCode(tidyCode(e.target.value))} placeholder="CODE" maxLength={8} aria-label="Room code" autoFocus />
                    <button type="submit" className="dbtn">Join</button>
                  </form>
                </>
              )}
            </div>
          )}</Presence>
        </div>
        <button type="button" className="dbtn ink" onClick={() => openPanel()} title={"Commands" + (K("commands") ? " (" + K("commands") + ")" : "")}><Ico n="command" /><span className="lbl">Commands</span> {K("commands") && <kbd>{K("commands")}</kbd>}</button>
        <button type="button" className="dbtn" onClick={copyForDocs} title="Copy for Docs — numbered, red and highlighted, as a Doc"><Ico n="copy" /><span className="lbl">Copy for Docs</span></button>
        <button type="button" className="dbtn" onClick={saveDocx} title="Save as .docx"><Ico n="export" /><span className="lbl">.docx</span></button>
        <a className="dbtn nosplit" href="/tools/evidence" target="break-evidence" title="Open Evidence beside this"><Ico n="cards" /><span className="lbl">Evidence ↗</span></a>
        <FullBtn className="dbtn" full={fs.full} toggle={fs.toggle} />
        <a className="dbtn splitlink" href="/tools/split?a=docflow" onClick={markHop} title="Split screen — Doc flow beside another tool"><Ico n="split" /><span className="lbl">Split ◫</span></a>
        <ThemePicker />
      </header>

      <div className="dbody">
        <aside className="dside" aria-label="Your flows and this flow's outline">
          <div className="dsec dnav">
            <button type="button" className="dnew" onClick={newFlow} title="Start a new flow — this one stays in Past flows">+ New flow</button>
            <Link className="dpast" href="/tools/flows" title="Every round you have flowed, Doc and Grid">Past flows <span aria-hidden="true">→</span></Link>
            {live.current?.flowId === current && <span className="dlive mono"><i />Shared · {live.current?.code}</span>}
          </div>
          <div className="dsec grow">
            <div className="dsh mono"><span>On this flow</span></div>
            {outline.length ? (
              <ul className="dout">
                {outline.map((s) => (
                  <li key={s.pos} className={s.kind + " " + s.who}>
                    <button type="button" onClick={() => jump(s.pos)}><span>{s.text}</span></button>
                  </li>
                ))}
              </ul>
            ) : <p className="dnone">Boxes and headings you add show up here to jump between.</p>}
          </div>
          <div className="dkeys mono">
            {[["tab", "answer"], ["outdent", "back out"], ["next", "their next point"], ["who", "swap speaker"], ["hl-yellow", "highlight"], ["stop", "mark a stop"], ["stop-next", "next stop"], ["keep", "keep as rhetoric"]]
              .filter(([id]) => K(id))
              .map(([id, what]) => <span key={id}><kbd>{K(id)}</kbd> {what}</span>)}
            <span><kbd>/</kbd> boxes, rhetoric, evidence</span>
            <button type="button" className="dkedit" onClick={() => setKeysOpen(true)}>Change keys</button>
          </div>
        </aside>

        <main className="dpage">
          <div className="dpaper">
            <input className="dtitle" value={name} placeholder="Untitled flow" spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onBlur={(e) => current && commitName(current, e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); view.current?.focus(); } }} />
            {waiting && (
              <div className="dwait">
                <i className="spin" />
                <b>Joining room <span className="mono">{roomCode}</span></b>
                <small>Your partner&apos;s flow will appear here.</small>
              </div>
            )}
            <div className="ddoc" ref={mount} key={current + ":" + gate} />
          </div>
        </main>

        <aside className={"dright" + (right ? "" : " rail")} aria-label="Round vision and rhetoric">
          {!right ? (
            <div className="drail">
              <button type="button" className="drail-open" onClick={() => setRight(() => true)} title={K("rhetoric") ? `Open the panel — ${K("rhetoric")}` : "Open the panel"}>«</button>
              <button type="button" className="drail-l" onClick={() => patchUi({ right: true, vis: true })}><span className="mono">Round vision</span>{stops.length ? <em>{stops.length}</em> : null}</button>
              <button type="button" className="drail-l" onClick={() => patchUi({ right: true, rh: true })}><span className="mono">Rhetoric</span>{pieces.length ? <em>{pieces.length}</em> : null}</button>
            </div>
          ) : (
            <>
              <section className={"dvs" + (ui.vis ? " open" : "")}>
                <div className="dsech">
                  <button type="button" className="dsect mono" onClick={() => patchUi({ vis: !ui.vis })} aria-expanded={ui.vis}>
                    <i className="chev" />Round vision{stops.length ? <em>{stops.length}</em> : null}
                  </button>
                  {stops.length > 0 && (
                    <button type="button" className={"dsmall mono" + (speaking ? " on" : "")} onClick={() => speak(!speaking)}>{speaking ? "Stop" : "Speak ▸"}</button>
                  )}
                  <button type="button" className="dfold" onClick={() => setRight(() => false)} title="Fold the panel away" aria-label="Fold the panel away">»</button>
                </div>
                {ui.vis && (
                  <div className="dvbody">
                    {stops.length ? (
                      <ol className="dvlist">
                        {stops.map((s, i) => (
                          <li key={s.pos} className={"vs " + s.who + (i === visionAt ? " now" : "")} draggable={!nameEdit}
                            style={{ ["--i" as any]: Math.min(i, 10) }}
                            onDragStart={(e) => { dragStop.current = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.name); e.currentTarget.classList.add("lift"); }}
                            onDragEnd={(e) => { dragStop.current = null; e.currentTarget.classList.remove("lift"); }}
                            onDragOver={(e) => { if (dragStop.current === null) return; e.preventDefault(); e.currentTarget.classList.add("over"); }}
                            onDragLeave={(e) => e.currentTarget.classList.remove("over")}
                            onDrop={(e) => {
                              e.preventDefault(); e.currentTarget.classList.remove("over");
                              const from = dragStop.current; dragStop.current = null;
                              if (from === null || from === i) return;
                              const order = stops.map((x) => x.pos);
                              const [m] = order.splice(from, 1);
                              order.splice(i, 0, m);
                              run(reorder(order));
                              setVisionAt(-1);
                            }}>
                            <button type="button" className="vs-n mono" onClick={() => goStop(i)} title={i < 9 && K("stop-" + (i + 1)) ? `Go — ${K("stop-" + (i + 1))}` : "Go"}>{i + 1}</button>
                            {nameEdit && nameEdit.pos === s.pos ? (
                              <input className="vs-in" autoFocus value={nameEdit.value} maxLength={60} spellCheck={false}
                                onFocus={(e) => e.currentTarget.select()}
                                onChange={(e) => setNameEdit({ pos: s.pos, value: e.target.value })}
                                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitStopName(); } if (e.key === "Escape") { e.preventDefault(); setNameEdit(null); view.current?.focus(); } }}
                                onBlur={() => commitStopName(false)} />
                            ) : (
                              <button type="button" className="vs-b" onClick={() => goStop(i)} onDoubleClick={() => setNameEdit({ pos: s.pos, value: s.name })}>
                                <b>{s.name}</b>
                                {(s.under || (s.text && s.text !== s.name)) && <small>{[s.under, s.text && s.text !== s.name ? s.text : ""].filter(Boolean).join(" · ")}</small>}
                              </button>
                            )}
                            <span className="vs-act">
                              <button type="button" onClick={() => setNameEdit({ pos: s.pos, value: s.name })} title="Rename" aria-label={`Rename ${s.name}`}>✎</button>
                              <button type="button" onClick={() => { run(setStop(s.pos, null)); setVisionAt(-1); }} title="Take out" aria-label={`Take ${s.name} out`}>×</button>
                            </span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <div className="dvnone">
                        Put the cursor on a line you will go to in your speech and press {K("stop") ? <kbd>{K("stop")}</kbd> : "the mark key"}. Name it, mark the rest, drag them into order — then <b>Speak</b> and walk it with Page Down{K("stop-next") ? <> or <kbd>{K("stop-next")}</kbd></> : null}.
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className={"drs" + (ui.rh ? " open" : "")}>
                <div className="dsech">
                  <button type="button" className="dsect mono" onClick={() => patchUi({ rh: !ui.rh })} aria-expanded={ui.rh}>
                    <i className="chev" />Rhetoric{pieces.length ? <em>{pieces.length}</em> : null}
                  </button>
                  <button type="button" className="dsmall mono" onClick={() => { patchUi({ rh: true }); setImporting({ drafts: null }); }} title="Paste a Google Doc of rhetoric">Paste a doc</button>
                  <button type="button" className="dsmall mono" onClick={() => { patchUi({ rh: true }); setEditing({ id: null, title: "", text: "" }); }} title="Write a new piece">+ New</button>
                </div>
                {ui.rh && (
                  <>
                    {pieces.length > 3 && (
                      <div className="drqw"><input className="drq" value={rq} onChange={(e) => setRq(e.target.value)} placeholder="Find…" spellCheck={false} /></div>
                    )}
                    <div className="drlist">
                      {importing && (
                        <div className="rp editing rpi">
                          {!importing.drafts ? (
                            <>
                              <b className="rpi-h">Paste a Google Doc</b>
                              <small className="rpi-p">Headings become pieces, the way Evidence reads a cut file: each block is a piece, the heading above it names its group, and a tag under a block is one of its lines.</small>
                              <textarea className="rpi-drop" autoFocus rows={4} value="" placeholder="Click here, then Ctrl+V"
                                onChange={() => {}}
                                onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setImporting(null); } }}
                                onPaste={(e) => {
                                  e.preventDefault();
                                  const drafts = fromDoc(e.clipboardData.getData("text/html"), e.clipboardData.getData("text/plain"));
                                  if (!drafts.length) { toast("Nothing in that to keep"); return; }
                                  setImporting({ drafts });
                                }} />
                              <div className="rp-row"><button type="button" className="dbtn" onClick={() => setImporting(null)}>Cancel</button></div>
                            </>
                          ) : (
                            <>
                              <b className="rpi-h">{importing.drafts.length} piece{importing.drafts.length === 1 ? "" : "s"} in that doc</b>
                              <ul className="rpi-list">
                                {importing.drafts.slice(0, 80).map((d, i) => (
                                  <li key={i} style={{ ["--i" as any]: Math.min(i, 12) }}>
                                    <b>{d.title}</b>
                                    <small>{d.group ? d.group + " · " : ""}{d.text.split("\n").length} line{d.text.split("\n").length === 1 ? "" : "s"}</small>
                                  </li>
                                ))}
                              </ul>
                              <div className="rp-row">
                                <button type="button" className="dbtn ink" onClick={takeImport}>Keep them</button>
                                <button type="button" className="dbtn" onClick={() => setImporting({ drafts: null })}>Paste again</button>
                                <button type="button" className="dbtn" onClick={() => setImporting(null)}>Cancel</button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      {editing && (
                        <form className="rp editing" onSubmit={(e) => { e.preventDefault(); saveEditing(); }}>
                          <input autoFocus value={editing.title} placeholder="Name it — Probability weighing"
                            onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
                          <textarea value={editing.text} rows={Math.min(14, Math.max(5, editing.text.split("\n").length + 1))}
                            placeholder={"One line per flow line.\n  Two spaces in, and it goes under the line above."}
                            spellCheck={false}
                            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); saveEditing(); return; }
                              if (e.key === "Escape") { e.preventDefault(); setEditing(null); return; }
                              if (e.key === "Tab") {
                                // Tab indents the line, as it does in the flow
                                e.preventDefault();
                                const ta = e.currentTarget;
                                const st = ta.selectionStart, val = ta.value;
                                const ls = val.lastIndexOf("\n", st - 1) + 1;
                                let next: string, caretAt: number;
                                if (e.shiftKey) { const cut = val.slice(ls, ls + 2) === "  " ? 2 : 0; next = val.slice(0, ls) + val.slice(ls + cut); caretAt = st - cut; }
                                else { next = val.slice(0, ls) + "  " + val.slice(ls); caretAt = st + 2; }
                                setEditing({ ...editing, text: next });
                                requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = Math.max(ls, caretAt); });
                              }
                            }} />
                          <div className="rp-row">
                            <button type="submit" className="dbtn ink">Keep it</button>
                            <button type="button" className="dbtn" onClick={() => setEditing(null)}>Cancel</button>
                            <small className="mono">Ctrl+Enter</small>
                          </div>
                        </form>
                      )}
                      {grouped.map(({ g, items }) => {
                        const shut = !rq.trim() && !!g && ui.shut.includes(g);
                        return (
                          <div key={g || "·"} className={"rgw" + (shut ? " shut" : "")}>
                            {g && (
                              <div className="rg">
                                <button type="button" className="rg-b" onClick={() => patchUi({ shut: shut ? ui.shut.filter((x) => x !== g) : [...ui.shut, g] })} aria-expanded={!shut}>
                                  <i className="chev" /><span>{g}</span><em className="mono">{items.length}</em>
                                </button>
                                <button type="button" className="rg-x" onClick={() => deleteGroup(g)} title="Delete this group" aria-label={`Delete the group ${g}`}>×</button>
                              </div>
                            )}
                            {!shut && items.map(pieceCard)}
                          </div>
                        );
                      })}
                      {!pieces.length && !editing && !importing && (
                        <div className="drnone">
                          <b>Write it once.</b>
                          <p>Weighing, framing, the frontline you always need. Keep it here, then drag it onto a line, click it, or type <kbd>/</kbd> and its name.</p>
                          <p>Already in a Google Doc? <button type="button" className="drlink" onClick={() => setImporting({ drafts: null })}>Paste the doc</button> and its headings become pieces.</p>
                          <p>Or select lines in your flow and press {K("keep") ? <kbd>{K("keep")}</kbd> : "Keep"} to keep them.</p>
                        </div>
                      )}
                      {pieces.length > 0 && !shownPieces.length && <p className="dnone">Nothing called that.</p>}
                    </div>
                    <div className="drfoot mono">
                      <button type="button" onClick={keepSelection}>Keep selected lines{K("keep") && <kbd>{K("keep")}</kbd>}</button>
                    </div>
                  </>
                )}
              </section>
            </>
          )}
        </aside>
      </div>

      {speaking && stops[visionAt] && (
        <div className="dspeak" role="status">
          <div className="sp-bar"><i style={{ transform: `scaleX(${(visionAt + 1) / stops.length})` }} /></div>
          <div className="sp-in">
            <button type="button" className="sp-arrow" onClick={() => step(-1)} aria-label="Previous stop">‹</button>
            <div className="spk" key={visionAt}>
              <span className="sp-n mono">{visionAt + 1} / {stops.length}</span>
              <b>{stops[visionAt].name}</b>
              {stops[visionAt].under && <small>{stops[visionAt].under}</small>}
            </div>
            <button type="button" className="sp-arrow" onClick={() => step(1)} aria-label="Next stop">›</button>
          </div>
          <button type="button" className="sp-done mono" onClick={() => speak(false)}>Done · Esc</button>
        </div>
      )}

      {slash && slashItems.length > 0 && slashPos && (
        <div className="dslash" ref={slashBox} style={slashPos}>
          {slashItems.map((it, i) => (
            <button type="button" key={it.id} className={(i === slash.i ? "on" : "") + (it.rhetoric ? " rh" : "")}
              onMouseDown={(e) => { e.preventDefault(); chooseSlash(it.id); }}>
              <b>{it.label}</b><small>{it.rhetoric ? "rhetoric · " + it.hint : it.hint}</small>
            </button>
          ))}
        </div>
      )}

      <Presence show={!!panel}>{panel && (
        <div className="dscrim" onMouseDown={(e) => { if (e.target === e.currentTarget) closePanel(); }}>
          <div className={"dpal" + (evMode ? " ev" : "") + (pick ? " pick" : "")}>
            <div className="dpin">
              <span className="glyph mono">{pick ? "✓" : evMode ? "/" : "›"}</span>
              {pick ? (
                <input autoFocus key="pick" value={pick.q} placeholder="Filter the cards in this block"
                  onChange={(e) => setPick({ ...pick, q: e.target.value, i: 1 })} onKeyDown={panelKey} spellCheck={false} />
              ) : (
                <input autoFocus key="q" value={panel.q} placeholder="Run a command — or / to answer from your evidence"
                  onChange={(e) => setPanel({ q: e.target.value, i: 0 })} onKeyDown={panelKey} spellCheck={false} />
              )}
            </div>
            {pick ? (
              <div className="dpsrc"><b className="ink">{pick.hit.title}</b> · {pick.sel.length ? `${pick.sel.length} picked` : "Enter takes the card you are on"}{answering ? <> · answering <b>{answering}</b></> : null}</div>
            ) : evMode && answering && <div className="dpsrc">Answering <b>{answering}</b></div>}
            {evMode && !pick && binsInfo && binsInfo.bins.list.length > 0 && (
              <div className="dpbins mono" onMouseDown={(e) => e.preventDefault()}>
                <span className="pb-l">Bins this round</span>
                {[...binsInfo.bins.list.map((b) => ({ id: b.id, name: b.name, on: b.on })),
                  ...(binsInfo.counts[""] ? [{ id: "", name: "Unsorted", on: binsInfo.bins.loose }] : [])].map((b) => (
                  <button type="button" key={b.id || "loose"} className={"pbin" + (b.on ? " on" : "")} onClick={() => flipBin(b.id, b.on)}
                    title={b.on ? "Searched this round — click to leave it out" : "Left out — click to search it"}>
                    <i />{b.name}<em>{binsInfo.counts[b.id] || 0}</em>
                  </button>
                ))}
              </div>
            )}
            <ul>
              {pick ? pickRows.map((r, i) => {
                const ticked = r.all ? pick.sel.length === pick.tags.length : !!r.tag && pick.sel.includes(r.tag.i);
                return (
                  <li key={r.all ? "all" : r.tag!.i} className={(i === pick.i ? "on" : "") + (r.all ? " all" : "")} onMouseEnter={() => setPick({ ...pick, i })}
                    onMouseDown={(e) => { e.preventDefault(); if ((e.target as HTMLElement).closest(".ck") || e.ctrlKey) togglePick(i); else commitPick(!e.shiftKey, i); }}>
                    <span className={"ck" + (ticked ? " on" : "")} aria-hidden="true" />
                    <span className="lb">{r.all ? `Every card in the block — all ${pick.tags.length}` : r.tag!.title}<small>{r.all ? pick.hit.title : r.tag!.cite}</small></span>
                  </li>
                );
              }) : evMode
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
              {pick
                ? <><span><kbd>Space</kbd> or <kbd>Tab</kbd> pick more than one</span>
                  <button type="button" className="dgo" onClick={() => commitPick(true)}><kbd>Enter</kbd> answer + send{pick.sel.length ? ` ${pick.sel.length}` : ""}</button>
                  <button type="button" className="dgo" onClick={() => commitPick(false)}><kbd>Shift+Enter</kbd> answer only</button>
                  <span><kbd>Esc</kbd> back</span></>
                : evMode
                ? <><span><kbd>Enter</kbd> open the block&apos;s cards</span><span><kbd>Esc</kbd> close</span></>
                : <><span><kbd>↑↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>/</kbd> your evidence</span><span><kbd>Esc</kbd> close</span></>}
            </div>
          </div>
        </div>
      )}</Presence>

      <Presence show={!!keysOpen}>{keysOpen && (
        <div className="dscrim" onMouseDown={(e) => { if (e.target === e.currentTarget) { setKeysOpen(false); setCapturing(null); view.current?.focus(); } }}>
          <div className="dpal dkeyed" role="dialog" aria-label="Keys">
            <div className="dkh">
              <b>Keys</b>
              <small>Click a key, then press the new one. Backspace leaves it with none.</small>
              <button type="button" className="dbtn" onClick={() => { setKeys({}); saveKeys(owner, {}); setCapturing(null); toast("Every key is back to how it started"); }}>Reset all</button>
              <button type="button" className="dbtn ink" onClick={() => { setKeysOpen(false); setCapturing(null); view.current?.focus(); }}>Done</button>
            </div>
            <div className="dkl">
              {Array.from(new Set(ACTIONS.map((a) => a.group))).map((g) => (
                <div key={g} className="dkg">
                  <div className="dkgh mono">{g}</div>
                  {ACTIONS.filter((a) => a.group === g).map((a) => {
                    const k = keyFor(keys, a.id);
                    const changed = a.id in keys;
                    return (
                      <div key={a.id} className={"dkr" + (capturing === a.id ? " cap" : "")}>
                        <span>{a.label}</span>
                        <button type="button" className={"dkk mono" + (changed ? " changed" : "") + (k ? "" : " none")} onClick={() => setCapturing((c) => (c === a.id ? null : a.id))}>
                          {capturing === a.id ? "press a key…" : k ? keyLabel(k) : "no key"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
              <div className="dkg">
                <div className="dkgh mono">Always</div>
                {[["Enter", "Next line"], ["Ctrl+Z / Ctrl+Y", "Undo / redo"], ["Ctrl+B / I / U", "Bold, italic, underline"], ["/", "Boxes, rhetoric, evidence"]].map(([k, l]) => (
                  <div key={k} className="dkr fixed"><span>{l}</span><span className="dkk mono">{k}</span></div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}</Presence>

      <Presence show={!!asking}>{asking && (
        <FlowPicker owner={owner} kind="doc" current={asking}
          onClose={() => { setAsking(null); view.current?.focus(); }}
          onNew={() => { setAsking(null); newFlow(); }}
          onOpen={async (id) => {
            setAsking(null);
            const nm = await fetchDoc(owner, id);
            if (!nm) { toast("That flow is not in Past flows any more"); return; }
            setDocs(listDocs(owner));
            openFlow({ id, name: nm, updated: Date.now() });
            toast(`Opened “${nm}”`);
          }} />
      )}</Presence>

      <Presence show={!!toastMsg}>{toastMsg && (
        <div className="dtoast mono" key={toastMsg.n} style={{ ["--life" as any]: toastMsg.undo ? "4200ms" : "2400ms" }}>
          {toastMsg.text}
          {toastMsg.undo && <button type="button" onClick={() => { toastMsg.undo?.(); setToastMsg(null); }}>Undo</button>}
        </div>
      )}</Presence>
    </div>
  );
}
