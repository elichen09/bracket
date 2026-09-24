"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { DOMParser as PMParser, DOMSerializer, type MarkType } from "prosemirror-model";
import { history, undo, redo, undoDepth, redoDepth } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark, setBlockType } from "prosemirror-commands";
import { schema, LEVELS } from "@/lib/evidence/docSchema";
import { scoped, adoptLocal } from "@/lib/owner";
import { ySyncPlugin, yCursorPlugin, yUndoPlugin, undoCommand, redoCommand, initProseMirrorDoc } from "y-prosemirror";

/** The room's send doc, when there is one: the editor binds to it instead of holding its own. */
interface Shared { ydoc: unknown; frag: any; awareness: any }

/** A partner's caret: a bar in their colour, their name over it. */
function caret(user: { name: string; color: string }) {
  const el = document.createElement("span");
  el.className = "evi-caret";
  el.style.setProperty("--c", user.color);
  const tag = document.createElement("span");
  tag.className = "evi-caret-name";
  tag.textContent = user.name;
  el.append("\u2060", tag, "\u2060");
  return el;
}

/**
 * The document panel: a real editor.
 *
 * What it replaces was a contenteditable div that the engine rewrote by hand
 * whenever anything changed. That is where the misbehaviour came from — a
 * redraw threw away the undo history and the cursor, and an editing command
 * could take apart the structure it was being made in.
 *
 * This holds a document instead. Typing is a transaction against a model, so
 * undo and redo are real, the selection survives a change made elsewhere, and
 * "this paragraph is a Block heading" is something the document knows rather
 * than something inferred from tags. The engine no longer touches the panel:
 * it announces a document on `evi:doc` and is told about edits through
 * `EV.setDraft`, which keeps the clipboard, the formatter and the draft store
 * working exactly as they did.
 *
 * Styles are Verbatim's, because that is what a cut file is written in:
 * pocket, hat, block, tag, and normal text at 11pt.
 */

const FONTS = ["Calibri", "Arial", "Times New Roman", "Georgia", "Verdana", "Garamond"];
const SIZES = ["8", "9", "10", "11", "12", "13", "14", "16", "18", "22", "26"];
const ZOOMS = [
  { label: "Fit", value: 0 },
  { label: "50%", value: 0.5 },
  { label: "75%", value: 0.75 },
  { label: "100%", value: 1 },
];

const parser = () => PMParser.fromSchema(schema);
const serializer = () => DOMSerializer.fromSchema(schema);

function docFromHtml(html: string) {
  const holder = document.createElement("div");
  holder.innerHTML = html || "<p></p>";
  return parser().parse(holder);
}

function htmlFromDoc(state: EditorState) {
  const frag = serializer().serializeFragment(state.doc.content);
  const holder = document.createElement("div");
  holder.appendChild(frag);
  return holder.innerHTML;
}

export default function DocEditor({ host, width, owner }: { host: React.RefObject<HTMLDivElement>; width: number; owner?: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const save = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quiet = useRef(false);                 // a change we made ourselves
  const [read, setRead] = useState(false);
  const readRef = useRef(false);               // for callbacks that outlive a render
  const [draft, setDraft] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [drop, setDrop] = useState("");          // the SpeechDrop row, when open
  const [room, setRoom] = useState("");
  const [sending, setSending] = useState(false);
  const [, force] = useState(0);
  const [shared, setShared] = useState<Shared | null>(null);
  const sharedRef = useRef<Shared | null>(null);
  sharedRef.current = shared;

  /** Hand the document back to the engine, which owns saving and the clipboard. */
  const push = useCallback(() => {
    const v = view.current;
    if (!v || readRef.current) return;         // the read view is not a draft
    const EV = (window as any).EV;
    if (!EV?.setDraft) return;
    quiet.current = true;
    EV.setDraft(htmlFromDoc(v.state), v.dom.textContent || "");
    quiet.current = false;
  }, []);

  // ---- the editor itself -------------------------------------------------
  useEffect(() => {
    if (!mount.current || view.current) return;
    const bound = shared && !read ? shared : null;
    const fmt = {
      "Mod-b": toggleMark(schema.marks.strong),
      "Mod-i": toggleMark(schema.marks.em),
      "Mod-u": toggleMark(schema.marks.underline),
    };
    const start = bound ? initProseMirrorDoc(bound.frag, schema) : null;
    const state = bound && start ? EditorState.create({
      schema,
      doc: start.doc,
      plugins: [
        ySyncPlugin(bound.frag, { mapping: start.mapping }),
        yCursorPlugin(bound.awareness, { cursorBuilder: caret, selectionBuilder: (u: { color: string }) => ({ style: `background-color: ${u.color}2e`, class: "evi-sel" }) }),
        yUndoPlugin(),
        keymap({ "Mod-z": undoCommand, "Mod-y": redoCommand, "Shift-Mod-z": redoCommand, ...fmt }),
        keymap(baseKeymap),
      ],
    }) : EditorState.create({
      doc: docFromHtml("<p></p>"),
      plugins: [
        history(),
        keymap({
          "Mod-z": undo,
          "Mod-y": redo,
          "Shift-Mod-z": redo,
          "Mod-b": toggleMark(schema.marks.strong),
          "Mod-i": toggleMark(schema.marks.em),
          "Mod-u": toggleMark(schema.marks.underline),
        }),
        keymap(baseKeymap),
      ],
    });
    // `mount` makes the element we rendered the editable document itself,
    // rather than ProseMirror adding its own div inside it — so the page is
    // the editor rather than a box round one.
    const v = new EditorView({ mount: mount.current }, {
      state,
      editable: () => !read,
      dispatchTransaction(tr) {
        const next = v.state.apply(tr);
        v.updateState(next);
        force((n) => n + 1);                    // the toolbar follows the cursor
        // A document handed to us by the engine is not an edit of the draft.
        // Saving it would let the read view, or a rebuild, overwrite what was
        // written — which is exactly how switching tabs used to lose it.
        // a shared doc is kept by the room, not saved from here
        if (!tr.docChanged || tr.getMeta("external") || bound) return;
        if (save.current) clearTimeout(save.current);
        save.current = setTimeout(push, 250);
      },
    });
    view.current = v;
    // The engine announced the document before this existed, so ask again.
    if (!bound) (window as any).EV?.renderDoc?.();
    return () => { v.destroy(); view.current = null; };
  }, [push, read, shared]);

  // ---- joining or leaving a room's send doc ---------------------------------
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setShared((window as any).EV?.sharedDoc?.() || null);
    const onShared = (e: Event) => setShared(((e as CustomEvent).detail as Shared) || null);
    el.addEventListener("evi:shared", onShared);
    return () => el.removeEventListener("evi:shared", onShared);
  }, [host]);

  // ---- what the engine says the document is ------------------------------
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onDoc = (e: Event) => {
      const { html, read: isRead, draft: isDraft, shared: isShared } = (e as CustomEvent).detail || {};
      readRef.current = !!isRead;
      setRead(!!isRead);
      setDraft(!!isDraft);
      const v = view.current;
      // the room's send doc is already in the editor, bound
      if (!v || quiet.current || isShared || html == null) return;
      const current = htmlFromDoc(v.state);
      if (current === html) return;             // nothing to do; keep the cursor
      const doc = docFromHtml(html || "");
      const tr = v.state.tr.replaceWith(0, v.state.doc.content.size, doc.content);
      tr.setMeta("addToHistory", false);        // not the writer's edit to undo
      tr.setMeta("external", true);             // and not theirs to save either
      if (save.current) clearTimeout(save.current);
      v.dispatch(tr);
    };
    el.addEventListener("evi:doc", onDoc);
    return () => el.removeEventListener("evi:doc", onDoc);
  }, [host]);

  // ---- commands ----------------------------------------------------------
  const run = useCallback((cmd: Command) => {
    const v = view.current;
    if (!v) return;
    cmd(v.state, v.dispatch, v);
    v.focus();
  }, []);

  const markActive = (type: MarkType) => {
    const v = view.current;
    if (!v) return false;
    const { from, $from, to, empty } = v.state.selection;
    return empty ? !!type.isInSet(v.state.storedMarks || $from.marks()) : v.state.doc.rangeHasMark(from, to, type);
  };

  /** A mark that carries a value — a size, a face — replaces rather than toggles. */
  const setValueMark = useCallback((type: MarkType, attrs: Record<string, string>) => {
    const v = view.current;
    if (!v) return;
    const { from, to, empty } = v.state.selection;
    const tr = v.state.tr;
    if (empty) tr.addStoredMark(type.create(attrs));
    else tr.removeMark(from, to, type).addMark(from, to, type.create(attrs));
    v.dispatch(tr);
    v.focus();
  }, []);

  const level = (() => {
    const v = view.current;
    if (!v) return 0;
    const node = v.state.selection.$from.parent;
    return node.type === schema.nodes.heading ? node.attrs.level : 0;
  })();

  /**
   * Changing the style changes the type of the paragraph and the marks on it.
   *
   * A block heading arrives from a cut file underlined — an underline *mark*
   * on the text, because that is what Google Docs exports — and the mark has
   * no reason to know it was only there because the line was a heading. So a
   * style sets what its level is: bold at its own size, with the underline
   * and strike taken off. A tag is a Heading 4, bold, 13pt, and nothing else.
   */
  const SIZE: Record<number, string> = { 1: "26pt", 2: "22pt", 3: "16pt", 4: "13pt" };

  const setLevel = (l: number) => {
    const v = view.current;
    if (!v) return;
    const { $from, $to } = v.state.selection;
    const from = $from.start(), to = $to.end();

    let tr = v.state.tr;
    if (l === 0) tr.setBlockType(from, to, schema.nodes.paragraph);
    else {
      tr.setBlockType(from, to, schema.nodes.heading, { level: l });
      tr.removeMark(from, to, schema.marks.underline);
      tr.removeMark(from, to, schema.marks.strike);
      tr.addMark(from, to, schema.marks.strong.create());
      tr.removeMark(from, to, schema.marks.fontSize);
      tr.addMark(from, to, schema.marks.fontSize.create({ size: SIZE[l] }));
    }
    v.dispatch(tr);
    v.focus();
  };

  const clearMarks = () => {
    const v = view.current;
    if (!v) return;
    const { from, to, empty } = v.state.selection;
    if (empty) return;
    const tr = v.state.tr;
    Object.values(schema.marks).forEach((m) => tr.removeMark(from, to, m));
    v.dispatch(tr);
    v.focus();
  };

  /** The room code is the same one all weekend, so it is remembered. */
  useEffect(() => {
    try { setRoom(adoptLocal("evidence.room", owner) || ""); } catch { /* private */ }
  }, []);

  /** The document as a file, built once and then either saved or sent. */
  const file = useCallback(async () => {
    const v = view.current;
    const EV = (window as any).EV;
    if (!v || !EV?.elementsFromHtml) return null;
    const { buildDocx } = await import("@/lib/evidence/docx");
    const elements = EV.elementsFromHtml(htmlFromDoc(v.state));
    const name = (EV.docTitle && EV.docTitle(EV.state.settings)) || "send doc";
    return buildDocx(elements, name);
  }, []);

  /**
   * Straight into the round's SpeechDrop room. It goes by way of the site's
   * own server, because a browser will not post to speechdrop.net from here.
   */
  const toSpeechDrop = useCallback(async () => {
    const code = room.trim();
    if (!code) { setDrop("A room code, please."); return; }
    setSending(true);
    setDrop("Sending…");
    try {
      const made = await file();
      if (!made) throw new Error("nothing to send");
      try { localStorage.setItem(scoped("evidence.room", owner), code); } catch { /* private */ }
      const body = new FormData();
      body.append("room", code);
      body.append("file", made.blob, made.filename);
      const res = await fetch("/api/tools/speechdrop", { method: "POST", body });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "that didn't work");
      setDrop(`In room ${j.room} — ${j.files} file${j.files === 1 ? "" : "s"} there now.`);
    } catch (err: any) {
      setDrop(err?.message || String(err));
    } finally { setSending(false); }
  }, [file, room]);

  /** The file, for the breaks and the box that a paste cannot carry. */
  const saveDocx = useCallback(async () => {
    const v = view.current;
    const EV = (window as any).EV;
    if (!v || !EV?.elementsFromHtml) return;
    try {
      (window as any).__docxStarted = true;
      const { downloadDocx } = await import("@/lib/evidence/docx");
      const elements = EV.elementsFromHtml(htmlFromDoc(v.state));
      const name = (EV.docTitle && EV.docTitle(EV.state.settings)) || "send doc";
      (window as any).__docxSize = await downloadDocx(elements, name);
    } catch (err: any) {
      // Writing a file is the one thing here that can fail on its own, so say
      // so rather than leaving a button that appears to do nothing.
      (window as any).__docxError = String(err && err.message ? err.message : err);
      console.error("docx export failed:", err);
      alert("Could not write the .docx: " + ((err && err.message) || err));
    }
  }, []);

  const insertBreak = () => {
    const v = view.current;
    if (!v) return;
    const tr = v.state.tr.replaceSelectionWith(schema.nodes.pageBreak.create());
    v.dispatch(tr.scrollIntoView());
    v.focus();
  };

  // Fit zooms the page to the panel; the rest are the usual fixed steps.
  const scale = zoom || Math.max(0.3, Math.min(1.1, (width - 34) / 816));
  const v = view.current;
  const isShared = !!shared && !read;
  const canUndo = v ? (isShared ? !!undoCommand(v.state) : undoDepth(v.state) > 0) : false;
  const canRedo = v ? (isShared ? !!redoCommand(v.state) : redoDepth(v.state) > 0) : false;

  const Btn = ({ on, label, title, act, style }: {
    on?: boolean; label: React.ReactNode; title: string; act: () => void; style?: React.CSSProperties;
  }) => (
    <button type="button" className={"fbtn" + (on ? " on" : "")} title={title} style={style}
      onMouseDown={(e) => e.preventDefault()} onClick={act}>{label}</button>
  );

  return (
    <>
      <div className="docbar">
        <Btn label="↶" title="Undo — Ctrl+Z" act={() => run(isShared ? undoCommand : undo)} style={canUndo ? undefined : { opacity: .35 }} />
        <Btn label="↷" title="Redo — Ctrl+Y" act={() => run(isShared ? redoCommand : redo)} style={canRedo ? undefined : { opacity: .35 }} />
        <span className="fdiv" />

        <select className="fsel style" value={level} title="Style"
          onMouseDown={(e) => e.stopPropagation()} onChange={(e) => setLevel(Number(e.target.value))}>
          {LEVELS.map((l) => <option key={l.level} value={l.level}>{l.name}</option>)}
        </select>
        <select className="fsel" defaultValue="" title="Font"
          onChange={(e) => { if (e.target.value) setValueMark(schema.marks.fontFamily, { font: e.target.value }); e.target.value = ""; }}>
          <option value="" disabled>Font</option>
          {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
        </select>
        <select className="fsel narrow" defaultValue="" title="Size"
          onChange={(e) => { if (e.target.value) setValueMark(schema.marks.fontSize, { size: e.target.value + "pt" }); e.target.value = ""; }}>
          <option value="" disabled>Size</option>
          {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <span className="fdiv" />
        <Btn on={markActive(schema.marks.strong)} label="B" title="Bold — Ctrl+B"
          act={() => run(toggleMark(schema.marks.strong))} style={{ fontWeight: 700 }} />
        <Btn on={markActive(schema.marks.em)} label="I" title="Italic — Ctrl+I"
          act={() => run(toggleMark(schema.marks.em))} style={{ fontStyle: "italic", fontFamily: "Georgia, serif" }} />
        <Btn on={markActive(schema.marks.underline)} label="U" title="Underline — Ctrl+U"
          act={() => run(toggleMark(schema.marks.underline))} style={{ textDecoration: "underline" }} />
        <Btn on={markActive(schema.marks.strike)} label="S" title="Strike through"
          act={() => run(toggleMark(schema.marks.strike))} style={{ textDecoration: "line-through" }} />
        <Btn on={markActive(schema.marks.highlight)} label={<i />} title="Highlight"
          act={() => run(toggleMark(schema.marks.highlight, { color: "#ffff00" }))} />
        <Btn label={<>T<sub>x</sub></>} title="Clear the formatting on the selection" act={clearMarks} />

        <span className="fdiv" />
        <Btn label="⏎" title="Page break — shown here; Docs drops these on paste" act={insertBreak} />
        <button type="button" className="fbtn wide" data-act="format"
          title="Title it, drop the analytics, renumber, take out the white space">Format</button>
        <button type="button" className="fbtn wide" onClick={saveDocx}
          title="Download as .docx — keeps the page breaks and the cover's box, which a paste cannot">.docx</button>
        <button type="button" className={"fbtn wide" + (drop ? " on" : "")}
          onClick={() => setDrop(drop ? "" : "open")}
          title="Put this document straight into a SpeechDrop room">SpeechDrop</button>
        <select className="fsel narrow zoom" value={zoom} title="Zoom"
          onChange={(e) => setZoom(Number(e.target.value))}>
          {ZOOMS.map((z) => <option key={z.label} value={z.value}>{z.label}</option>)}
        </select>
      </div>

      {drop && (
        <div className="droprow">
          <input value={room} placeholder="room code" maxLength={16} spellCheck={false}
            onChange={(e) => setRoom(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") toSpeechDrop(); }} />
          <button type="button" className="fbtn wide" disabled={sending} onClick={toSpeechDrop}>
            {sending ? "Sending…" : "Send"}
          </button>
          {drop !== "open" && <span className="msg">{drop}</span>}
        </div>
      )}

      {draft && (
        <div className="docnote">
          {read ? "Read from your draft" : "Your draft — new cards join the end"}
          <button className="link" data-act="docReset">Rebuild</button>
        </div>
      )}

      <div id="docbody">
        <div className="paper" style={{ zoom: scale }}>
          <div className={"sheet" + (read ? " reading" : "")} ref={mount} />
        </div>
      </div>
    </>
  );
}
