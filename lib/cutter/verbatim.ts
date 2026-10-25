import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../evidence/docSchema";
import { readHighlight } from "./reference";

/**
 * Verbatimise: the cards as they will be read — just the highlighting.
 *
 * A view, not an edit: nothing in the file changes. Every card keeps its tag
 * and its cite; in the card's text, what is not highlighted is hidden, and a
 * paragraph with no highlighting at all goes altogether. Between two
 * highlighted stretches that the hidden words kept apart, a space, so the
 * words never run together. Headings, and anything not under a tag, stay as
 * they are. While it is on the page is read-only — there is nothing to cut in
 * a view of what is already cut.
 */

export const verbKey = new PluginKey<{ on: boolean; deco: DecorationSet }>("verbatimise");

/** Highlighted to be read — grey is a card kept for reference, not read. */
const isHl = readHighlight;

function gap() {
  const s = document.createElement("span");
  s.className = "ct-vgap";
  s.textContent = " ";
  return s;
}

function build(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  let inCard = false, citeNext = false;
  doc.forEach((node, pos) => {
    if (node.type === schema.nodes.heading) { inCard = node.attrs.level === 4; citeNext = inCard; return; }
    if (!inCard || node.type !== schema.nodes.paragraph) return;
    if (citeNext && node.textContent.trim()) { citeNext = false; return; }        // the cite stays
    let any = false;
    node.descendants((t) => { if (t.isText && isHl(t)) any = true; });
    if (!any) { decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "ct-vhide" })); return; }
    let shown = "", hiddenSince = false;
    node.descendants((t, p) => {
      if (!t.isText) return;
      const from = pos + 1 + p, to = from + t.nodeSize;
      if (isHl(t)) {
        // a space where hidden words stood between two read ones, unless one is there already
        if (hiddenSince && shown && !/\s$/.test(shown) && !/^\s/.test(t.text || "")) decos.push(Decoration.widget(from, gap, { side: -1 }));
        shown += t.text || "";
        hiddenSince = false;
      } else {
        decos.push(Decoration.inline(from, to, { class: "ct-vhide" }));
        hiddenSince = true;
      }
    });
  });
  return DecorationSet.create(doc, decos);
}

export function verbatimPlugin(startOn: boolean) {
  return new Plugin<{ on: boolean; deco: DecorationSet }>({
    key: verbKey,
    state: {
      init: (_, state) => ({ on: startOn, deco: startOn ? build(state.doc) : DecorationSet.empty }),
      apply(tr, prev, _old, state) {
        const m = tr.getMeta(verbKey);
        const on = typeof m === "boolean" ? m : prev.on;
        if (!on) return prev.on ? { on, deco: DecorationSet.empty } : prev;
        if (on !== prev.on || tr.docChanged) return { on, deco: build(state.doc) };
        return prev;
      },
    },
    props: {
      decorations: (s) => verbKey.getState(s)?.deco,
      attributes: (s): Record<string, string> => (verbKey.getState(s)?.on ? { class: "ct-verb" } : {}),
      editable: (s) => !verbKey.getState(s)?.on,
    },
  });
}

export const isVerbatim = (s: EditorState) => !!verbKey.getState(s)?.on;

/**
 * How many words a speech reads from the file: every tag and analytic (Heading
 * 4 — they are said out loud); in a card, what is highlighted; outside one,
 * every word. A pocket, hat or block heading is not read.
 */
export function readWords(doc: PMNode): number {
  const count = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  let n = 0, inCard = false;
  doc.forEach((node) => {
    if (node.type === schema.nodes.heading) {
      inCard = node.attrs.level === 4;
      if (inCard) n += count(node.textContent);
      return;
    }
    if (!inCard) { n += count(node.textContent); return; }
    node.descendants((t) => { if (t.isText && isHl(t)) n += count(t.text || ""); });
  });
  return n;
}
