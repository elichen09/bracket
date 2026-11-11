import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { schema } from "../evidence/docSchema";
import { cardAround, sections } from "./commands";

/**
 * Where a card sent to the speech doc goes: where its cursor is.
 *
 * Not into the middle of a card — a card dropped between a tag and its cite
 * is two broken cards — but at the edge of the one the cursor is in:
 *
 *  - the cursor on an empty line: there, in place of the line;
 *  - in a card: after that card;
 *  - on a block's heading: at the top of the block, under its heading;
 *  - a whole block sent, with the cursor in another block: after that block.
 *
 * A single card sent into a block keeps only its tag and text — its own
 * block heading would split the block it lands in. Before the cursor has
 * been put anywhere in the speech doc, cards go at the end, as they always
 * did. While the cursor is somewhere else (in the search, in a file), a line
 * in the speech doc shows where the next card will land.
 */

interface Mark { aimed: boolean; focused: boolean }
export const placeKey = new PluginKey<Mark>("placeMark");

const H = schema.nodes.heading, P = schema.nodes.paragraph;
const isEmptyLine = (n: PMNode | null | undefined) => !!n && n.type === P && !n.content.size;
/** The whole document is one empty line: a new speech doc. */
const blank = (doc: PMNode) => doc.childCount === 1 && isEmptyLine(doc.firstChild);

export interface Spot { from: number; to: number; inBlock: boolean; where: string }

/** Where a card (or, `whole`, a block) goes now. */
export function spotFor(state: EditorState, whole = false): Spot {
  const doc = state.doc;
  const aimed = placeKey.getState(state)?.aimed ?? true;
  const end: Spot = { from: doc.content.size, to: doc.content.size, inBlock: false, where: "at the end of the speech doc" };
  if (blank(doc)) return { from: 0, to: doc.content.size, inBlock: false, where: "in the speech doc" };
  if (!aimed) return end;
  const $f = state.selection.$from;
  if ($f.depth < 1) return end;
  const top = $f.node(1);
  const here = $f.before(1);
  // the block (h1–h3) the cursor sits under, if any
  let block: { pos: number; level: number; text: string } | null = null;
  doc.forEach((n, p) => { if (p <= here && n.type === H && n.attrs.level < 4) block = { pos: p, level: n.attrs.level, text: n.textContent.trim() }; });
  const b = block as { pos: number; level: number; text: string } | null;
  const under = b ? `under “${b.text.slice(0, 40)}”` : "where your cursor is";
  if (isEmptyLine(top)) return { from: here, to: here + top.nodeSize, inBlock: !!b, where: under };
  if (whole) {
    // a block goes after the block the cursor is in, not inside it
    if (b) { const sec = sections(doc).find((s) => s.pos === b.pos); if (sec) return { from: sec.end, to: sec.end, inBlock: false, where: `after “${b.text.slice(0, 40)}”` }; }
    const c = cardAround(state);
    const at = c?.tag ? c.end : $f.after(1);
    return { from: at, to: at, inBlock: false, where: "where your cursor is" };
  }
  if (top.type === H && top.attrs.level < 4) return { from: $f.after(1), to: $f.after(1), inBlock: true, where: `at the top of “${top.textContent.trim().slice(0, 40)}”` };
  const c = cardAround(state);
  const at = c?.tag ? c.end : $f.after(1);
  return { from: at, to: at, inBlock: !!b, where: c?.tag ? `after “${c.tag.node.textContent.trim().slice(0, 40)}”` : under };
}

/**
 * Put a card in, where `spotFor` says, and leave the cursor at its end — so
 * the next card sent goes after it, in order. Null if the document will not
 * take it (an empty card).
 */
export function placeCard(state: EditorState, nodes: PMNode[], whole: boolean): { tr: Transaction; where: string } | null {
  const spot = spotFor(state, whole);
  let list = nodes;
  // one card into a block: its tag and its text, not a second block heading
  if (!whole && spot.inBlock) list = list.filter((n) => !(n.type === H && n.attrs.level < 4));
  while (list.length && isEmptyLine(list[list.length - 1])) list = list.slice(0, -1);
  if (!list.length) return null;
  const frag = Fragment.from(list);
  const tr = state.tr.replaceWith(spot.from, spot.to, frag);
  const after = spot.from + frag.size;
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, Math.min(after, tr.doc.content.size))), -1));
  tr.setMeta(placeKey, { aimed: true });
  return { tr, where: spot.where };
}

function line(where: string) {
  const el = document.createElement("div");
  el.className = "rm-dropline";
  el.contentEditable = "false";
  el.setAttribute("aria-hidden", "true");
  const t = document.createElement("span");
  t.textContent = "Next card goes here";
  el.title = "Cards you send land here — click in the speech doc to move it";
  el.appendChild(t);
  void where;
  return el;
}

/** The plugin: knows whether the cursor has been put anywhere, and draws the line while it is away. */
export function placePlugin() {
  return new Plugin<Mark>({
    key: placeKey,
    state: {
      init: () => ({ aimed: false, focused: false }),
      apply(tr, prev) {
        const m = tr.getMeta(placeKey) as Partial<Mark> | undefined;
        return m ? { ...prev, ...m } : prev;
      },
    },
    props: {
      decorations(state) {
        const m = placeKey.getState(state);
        if (!m || m.focused || blank(state.doc)) return null;
        const spot = spotFor(state);
        return DecorationSet.create(state.doc, [Decoration.widget(spot.from, () => line(spot.where), { side: -1, key: "drop:" + spot.from, ignoreSelection: true })]);
      },
    },
    view(v) {
      const on = () => { if (!placeKey.getState(v.state)?.focused) v.dispatch(v.state.tr.setMeta(placeKey, { focused: true, aimed: true }).setMeta("addToHistory", false)); };
      const off = () => { if (placeKey.getState(v.state)?.focused) v.dispatch(v.state.tr.setMeta(placeKey, { focused: false }).setMeta("addToHistory", false)); };
      v.dom.addEventListener("focus", on);
      v.dom.addEventListener("blur", off);
      return { destroy() { v.dom.removeEventListener("focus", on); v.dom.removeEventListener("blur", off); } };
    },
  });
}
