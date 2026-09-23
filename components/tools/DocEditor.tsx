"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { DOMParser as PMParser, DOMSerializer, type MarkType } from "prosemirror-model";
import { history, undo, redo, undoDepth, redoDepth } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark, setBlockType } from "prosemirror-commands";
import { schema, LEVELS } from "@/lib/evidence/docSchema";

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

export default function DocEditor({ host, width }: { host: React.RefObject<HTMLDivElement>; width: number }) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const save = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quiet = useRef(false);                 // a change we made ourselves
  const [read, setRead] = useState(false);
  const readRef = useRef(false);               // for callbacks that outlive a render
  const [draft, setDraft] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [, force] = useState(0);

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
    const state = EditorState.create({
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
        if (!tr.docChanged || tr.getMeta("external")) return;
        if (save.current) clearTimeout(save.current);
        save.current = setTimeout(push, 250);
      },
    });
    view.current = v;
    // The engine announced the document before this existed, so ask again.
    (window as any).EV?.renderDoc?.();
    return () => { v.destroy(); view.current = null; };
  }, [push, read]);

  // ---- what the engine says the document is ------------------------------
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onDoc = (e: Event) => {
      const { html, read: isRead, draft: isDraft } = (e as CustomEvent).detail || {};
      readRef.current = !!isRead;
      setRead(!!isRead);
      setDraft(!!isDraft);
      const v = view.current;
      if (!v || quiet.current) return;
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

  const setLevel = (l: number) => {
    run(l === 0
      ? setBlockType(schema.nodes.paragraph)
      : setBlockType(schema.nodes.heading, { level: l }));
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
  const canUndo = v ? undoDepth(v.state) > 0 : false;
  const canRedo = v ? redoDepth(v.state) > 0 : false;

  const Btn = ({ on, label, title, act, style }: {
    on?: boolean; label: React.ReactNode; title: string; act: () => void; style?: React.CSSProperties;
  }) => (
    <button type="button" className={"fbtn" + (on ? " on" : "")} title={title} style={style}
      onMouseDown={(e) => e.preventDefault()} onClick={act}>{label}</button>
  );

  return (
    <>
      <div className="docbar">
        <Btn label="↶" title="Undo — Ctrl/⌘+Z" act={() => run(undo)} style={canUndo ? undefined : { opacity: .35 }} />
        <Btn label="↷" title="Redo — Ctrl/⌘+Y" act={() => run(redo)} style={canRedo ? undefined : { opacity: .35 }} />
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
        <Btn on={markActive(schema.marks.strong)} label="B" title="Bold — Ctrl/⌘+B"
          act={() => run(toggleMark(schema.marks.strong))} style={{ fontWeight: 700 }} />
        <Btn on={markActive(schema.marks.em)} label="I" title="Italic — Ctrl/⌘+I"
          act={() => run(toggleMark(schema.marks.em))} style={{ fontStyle: "italic", fontFamily: "Georgia, serif" }} />
        <Btn on={markActive(schema.marks.underline)} label="U" title="Underline — Ctrl/⌘+U"
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
        <select className="fsel narrow zoom" value={zoom} title="Zoom"
          onChange={(e) => setZoom(Number(e.target.value))}>
          {ZOOMS.map((z) => <option key={z.label} value={z.value}>{z.label}</option>)}
        </select>
      </div>

      {draft && (
        <div className="docnote">Your draft — new cards join the end
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
