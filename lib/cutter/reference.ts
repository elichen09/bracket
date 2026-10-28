import { TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { schema, isBlankBackground } from "../evidence/docSchema";
import { cardAround } from "./commands";

/**
 * Cards for reference: a card put in an extension to point at, not to read.
 * Its tag stays, a line under the tag says whose card it is —
 * <<FOR REFERENCE---Lange 23>> — and its highlighting goes grey — the colour every debater reads as "not read in
 * this speech". Verbatimise and the read count leave grey out.
 */

type Cmd = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;
const M = schema.marks;
const H = schema.nodes.heading;
const P = schema.nodes.paragraph;

export const GREY = "#c0c0c0";
export const MARKER = "<<FOR REFERENCE>>";

/** Grey, whatever way it is written: the three channels within a step of each other. */
export function isGrey(color: string): boolean {
  const s = String(color || "").trim().toLowerCase();
  let r: number, g: number, b: number;
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s);
  if (rgb) [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number);
  else {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
    if (!m) return false;
    const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
    [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  return Math.max(r, g, b) - Math.min(r, g, b) <= 16 && r < 0xf0;
}

/** A highlight that is read: any colour but grey (and not the white a paste leaves behind). */
export const readHighlight = (n: PMNode) => n.marks.some((m) => m.type === M.highlight && !isGrey(m.attrs.color) && !isBlankBackground(m.attrs.color));

const isMarker = (n: PMNode | null | undefined) => !!n && n.type === P && /^<<\s*for reference\b.*>>$/i.test(n.textContent.trim());

/**
 * Whose card it is, from its cite: the bold part at its start (what Cite
 * makes — "Steele 14"), or failing that its words up to the year.
 */
export function shortCite(cite: PMNode | null | undefined): string {
  if (!cite || !cite.textContent.trim()) return "";
  let bold = "", done = false;
  cite.forEach((t) => {
    if (done || !t.isText) return;
    if (t.marks.some((m) => m.type === M.strong)) bold += t.text;
    else if (bold.trim()) done = true;
  });
  const tidy = (s: string) => s.replace(/\s+/g, " ").replace(/[.,;:\s]+$/, "").trim();
  // "Connor **Steele 14.**": the bold surname and year is what a debater says
  if (bold.trim() && bold.trim().length <= 60) return tidy(bold);
  const m = /^\s*(.{1,50}?\b(?:\d{4}|\d{2}))\b/.exec(cite.textContent);
  return tidy(m ? m[1] : cite.textContent.split(/\s+/).slice(0, 2).join(" "));
}

/** The line under a reference's tag. */
export const markerFor = (author: string) => (author ? `<<FOR REFERENCE---${author}>>` : MARKER);

/** Every highlight in [from, to) as `color`. */
function recolour(tr: Transaction, doc: PMNode, from: number, to: number, color: string) {
  doc.nodesBetween(from, to, (n, pos) => {
    if (!n.isText) return;
    const m = n.marks.find((x) => x.type === M.highlight);
    if (!m) return;
    const a = Math.max(pos, from), b = Math.min(pos + n.nodeSize, to);
    tr.removeMark(a, b, M.highlight);
    tr.addMark(a, b, M.highlight.create({ color }));
  });
}

/**
 * The card the cursor is in becomes a reference: its highlighting grey and
 * <<FOR REFERENCE>> under its tag. Again, and it is a card to read once
 * more, in the highlighter's colour. With a selection, just that stretch
 * goes grey (or back) — for a card cut down to the lines that matter.
 */
export const referenceCard = (color: string): Cmd => (state, dispatch) => {
  const { from, to, empty } = state.selection;
  const card = cardAround(state);
  let a: number, b: number;
  if (!empty) { a = from; b = to; }
  else if (card?.tag) { a = card.tag.pos; b = card.end; }
  else return false;

  let any = false, allGrey = true;
  state.doc.nodesBetween(a, b, (n) => {
    if (!n.isText) return;
    const m = n.marks.find((x) => x.type === M.highlight);
    if (!m) return;
    any = true;
    if (!isGrey(m.attrs.color)) allGrey = false;
  });
  const markerAt = card?.tag ? card.tag.pos + card.tag.node.nodeSize : -1;
  const hasMarker = markerAt >= 0 && isMarker(state.doc.nodeAt(markerAt));
  if (!any && !(empty && card?.tag)) return false;

  if (dispatch) {
    const tr = state.tr;
    const back = any ? allGrey : hasMarker;                 // a reference already: back to a card
    if (any) recolour(tr, state.doc, a, b, back ? color : GREY);
    if (empty && card?.tag) {
      if (back && hasMarker) tr.delete(markerAt, markerAt + state.doc.nodeAt(markerAt)!.nodeSize);
      if (!back && !hasMarker) tr.insert(markerAt, P.create(null, schema.text(markerFor(shortCite(card.cite?.node)))));
    }
    dispatch(closeHistory(tr.scrollIntoView()));
  }
  return true;
};

/**
 * The i-th card of a document, made a reference: its tag, <<FOR REFERENCE>>,
 * and its text with the highlighting grey. The cite is left behind — the
 * card is being pointed at, and its cite was read when it was first read.
 */
export function referenceNodes(doc: PMNode, i: number): PMNode[] | null {
  const top: { pos: number; node: PMNode }[] = [];
  doc.forEach((node, pos) => top.push({ pos, node }));
  let k = -1, at = -1;
  top.forEach((t, j) => { if (at < 0 && t.node.type === H && t.node.attrs.level === 4 && ++k === i) at = j; });
  if (at < 0) return null;
  const out: PMNode[] = [top[at].node];
  let citeSkipped = false, author = "";
  for (let j = at + 1; j < top.length && top[j].node.type !== H; j++) {
    const n = top[j].node;
    // its cite stays behind, all but whose it is; a reference already says whose in its marker
    if (!citeSkipped && n.type === P && n.textContent.trim()) {
      citeSkipped = true;
      if (isMarker(n)) author = (/---(.+?)>>\s*$/.exec(n.textContent) || [])[1] || "";
      else author = shortCite(n);
      continue;
    }
    if (n.type !== P) continue;
    out.push(greyed(n));
  }
  out.splice(1, 0, P.create(null, schema.text(markerFor(author))));
  return out;
}

/** A paragraph with every highlight in it grey. */
function greyed(p: PMNode): PMNode {
  const kids: PMNode[] = [];
  p.forEach((c) => {
    if (!c.isText) { kids.push(c); return; }
    const marks = c.marks.map((m) => (m.type === M.highlight ? M.highlight.create({ color: GREY }) : m));
    kids.push(c.mark(marks));
  });
  return P.create(p.attrs, Fragment.fromArray(kids), p.marks);
}

/** Put a reference in after the line the cursor is on — or in place of it, if it is empty. */
export const insertReference = (nodes: PMNode[]): Cmd => (state, dispatch) => {
  const $f = state.selection.$from;
  if (!$f.depth) return false;
  const line = $f.node(1);
  const start = $f.before(1), end = $f.after(1);
  if (dispatch) {
    const empty = line.isTextblock && !line.content.size;
    const tr = empty ? state.tr.replaceWith(start, end, nodes) : state.tr.insert(end, nodes);
    const at = empty ? start : end;
    const size = nodes.reduce((s, n) => s + n.nodeSize, 0);
    tr.setSelection(TextSelection.near(tr.doc.resolve(at + size)));
    dispatch(closeHistory(tr.scrollIntoView()));
  }
  return true;
};
