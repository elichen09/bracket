import { TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { Fragment, Slice, type Mark, type MarkType, type Node as PMNode } from "prosemirror-model";
import { schema } from "../evidence/docSchema";
import type { CardBrief } from "./store";

/**
 * What the card cutter's keys do, as ProseMirror commands.
 *
 * A card is a tag (heading 4), its cite (the first paragraph under it), and
 * the card's text — everything after that until the next heading. The marks
 * are the ones every cut file uses, so a card cut here pastes into Google
 * Docs or Word as a card, and Evidence reads it like any other: cite is 13pt
 * bold, underline is underline, emphasis is bold and underlined, highlight is
 * a background colour, shrunk text is 8pt.
 *
 * With nothing selected, a mark key works on the word the cursor is in, the
 * way Word does; shrink and condense work on the whole card.
 */

type Cmd = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;

const M = schema.marks;
export const SMALL = "8pt";
const CITE_SIZE = "13pt";

export const HIGHLIGHTS = [
  { name: "Yellow", color: "#ffff00" },
  { name: "Green", color: "#00ff00" },
  { name: "Blue", color: "#00ffff" },
  { name: "Pink", color: "#ff00ff" },
  { name: "Grey", color: "#c0c0c0" },
];

const WORD = /[\p{L}\p{N}'’_-]/u;

/** The word around a position, inside its paragraph. */
function wordAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const $p = state.doc.resolve(pos);
  if (!$p.parent.isTextblock) return null;
  const text = $p.parent.textContent, start = $p.start();
  let a = $p.parentOffset, b = $p.parentOffset;
  while (a > 0 && WORD.test(text[a - 1])) a--;
  while (b < text.length && WORD.test(text[b])) b++;
  if (a === b) return null;
  return { from: start + a, to: start + b };
}

/** What a mark key works on: the selection, or the word the cursor is in. */
function targetOf(state: EditorState): { from: number; to: number } | null {
  const { from, to, empty } = state.selection;
  if (!empty) return { from, to };
  return wordAt(state, from);
}

/** Does every bit of text in the range carry every one of these marks? */
function allHave(doc: PMNode, from: number, to: number, test: (marks: readonly Mark[]) => boolean): boolean {
  let any = false, all = true;
  doc.nodesBetween(from, to, (n) => {
    if (!n.isText) return;
    any = true;
    if (!test(n.marks)) all = false;
  });
  return any && all;
}

const isSmall = (m: Mark) => m.type === M.fontSize && parseFloat(m.attrs.size) < 11;

/** Take shrunk sizes off text that is being made something that is read. */
function unshrink(tr: Transaction, from: number, to: number) {
  tr.doc.nodesBetween(from, to, (n, pos) => {
    if (!n.isText) return;
    const m = n.marks.find(isSmall);
    if (m) tr.removeMark(Math.max(pos, from), Math.min(pos + n.nodeSize, to), m);
  });
}

function toggleSet(marks: Mark[], has: (ms: readonly Mark[]) => boolean, opts: { unshrink?: boolean; drop?: MarkType[] } = {}): Cmd {
  return (state, dispatch) => {
    const r = targetOf(state);
    if (!r) return false;
    if (dispatch) {
      const tr = state.tr;
      if (allHave(state.doc, r.from, r.to, has)) {
        for (const t of opts.drop || marks.map((m) => m.type)) tr.removeMark(r.from, r.to, t);
      } else {
        for (const m of marks) tr.addMark(r.from, r.to, m);
        if (opts.unshrink) unshrink(tr, r.from, r.to);
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export const underline: Cmd = toggleSet([M.underline.create()], (ms) => ms.some((m) => m.type === M.underline), { unshrink: true });

export const emphasis: Cmd = toggleSet(
  [M.strong.create(), M.underline.create()],
  (ms) => ms.some((m) => m.type === M.strong) && ms.some((m) => m.type === M.underline),
  { unshrink: true, drop: [M.strong] },
);

export const cite: Cmd = toggleSet(
  [M.strong.create(), M.fontSize.create({ size: CITE_SIZE })],
  (ms) => ms.some((m) => m.type === M.strong) && ms.some((m) => m.type === M.fontSize && m.attrs.size === CITE_SIZE),
  { drop: [M.strong, M.fontSize] },
);

export const highlight = (color: string): Cmd => toggleSet(
  [M.highlight.create({ color })],
  (ms) => ms.some((m) => m.type === M.highlight && sameColor(m.attrs.color, color)),
  { unshrink: false },
);

function sameColor(a: string, b: string) {
  const norm = (c: string) => {
    const s = String(c).trim().toLowerCase();
    const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s);
    if (rgb) return "#" + [rgb[1], rgb[2], rgb[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("");
    return s;
  };
  return norm(a) === norm(b);
}

/** Back to plain text: every mark off, and the paragraph back to normal. */
export const clear: Cmd = (state, dispatch) => {
  const { from, to, empty, $from } = state.selection;
  const a = empty ? $from.start() : from, b = empty ? $from.end() : to;
  if (dispatch) {
    const tr = state.tr;
    for (const t of Object.values(M)) tr.removeMark(a, b, t);
    tr.setBlockType(a, b, schema.nodes.paragraph);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Pocket, hat, block or tag; the same key again on one makes it a paragraph. */
export const setLevel = (level: number): Cmd => (state, dispatch) => {
  const { from, to } = state.selection;
  let all = true;
  state.doc.nodesBetween(from, to, (n) => {
    if (!n.isTextblock) return;
    if (!(n.type === schema.nodes.heading && n.attrs.level === level)) all = false;
    return false;
  });
  if (dispatch) {
    const tr = state.tr;
    if (all) tr.setBlockType(from, to, schema.nodes.paragraph);
    else tr.setBlockType(from, to, schema.nodes.heading, { level });
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/* ------------------------------------------------------------------ the card around the cursor */

export interface CardSpan {
  tag: { pos: number; node: PMNode } | null;
  /** Where the cite paragraph is, if the card has one. */
  cite: { pos: number; node: PMNode } | null;
  /** The card's text: from after the cite to the next heading. */
  bodyFrom: number;
  bodyTo: number;
  end: number;
}

/** The card the cursor is in — from its tag to the next heading. */
export function cardAround(state: EditorState, pos = state.selection.from): CardSpan | null {
  const doc = state.doc;
  let at = 0, idx = -1;
  const tops: { pos: number; node: PMNode }[] = [];
  doc.forEach((n, p, i) => { tops.push({ pos: p, node: n }); if (p <= pos) { idx = i; at = p; } });
  void at;
  if (idx < 0) return null;
  // back to the tag (a tag, or the start of the run of paragraphs if there is none)
  let start = idx;
  while (start >= 0 && tops[start].node.type !== schema.nodes.heading) start--;
  const tag = start >= 0 && tops[start].node.attrs.level === 4 ? tops[start] : null;
  if (start >= 0 && !tag) return null;           // under a pocket, hat or block, not in a card
  let end = (start < 0 ? 0 : start + 1);
  while (end < tops.length && tops[end].node.type !== schema.nodes.heading) end++;
  const first = start + 1;
  const citeAt = tag && first < end && tops[first].node.type === schema.nodes.paragraph ? tops[first] : null;
  const bodyStart = citeAt ? first + 1 : first;
  const posOf = (i: number) => (i < tops.length ? tops[i].pos : doc.content.size);
  return {
    tag, cite: citeAt,
    bodyFrom: posOf(bodyStart), bodyTo: posOf(end),
    end: posOf(end),
  };
}

/**
 * Shrink: the text that is not underlined goes to 8pt, so what is read
 * stands out. Again, and it comes back.
 */
export const shrink: Cmd = (state, dispatch) => {
  let from: number, to: number;
  if (!state.selection.empty) ({ from, to } = state.selection);
  else {
    const c = cardAround(state);
    if (!c || c.bodyFrom >= c.bodyTo) return false;
    from = c.bodyFrom; to = c.bodyTo;
  }
  const plain: { a: number; b: number; n: PMNode }[] = [];
  state.doc.nodesBetween(from, to, (n, pos) => {
    if (!n.isText || n.marks.some((m) => m.type === M.underline)) return;
    plain.push({ a: Math.max(pos, from), b: Math.min(pos + n.nodeSize, to), n });
  });
  if (!plain.length) return false;
  const shrunk = plain.every((p) => p.n.marks.some(isSmall));
  if (dispatch) {
    const tr = state.tr;
    for (const p of plain) {
      if (shrunk) { const m = p.n.marks.find(isSmall); if (m) tr.removeMark(p.a, p.b, m); }
      else tr.addMark(p.a, p.b, M.fontSize.create({ size: SMALL }));
    }
    dispatch(tr);
  }
  return true;
};

/**
 * Condense: the card's paragraphs into one — what a paste out of a PDF
 * needs, broken at every line. A selection across paragraphs condenses just
 * those.
 */
export const condense: Cmd = (state, dispatch) => {
  let from: number, to: number;
  const { $from, $to, empty } = state.selection;
  if (!empty && $from.parent !== $to.parent) { from = $from.before(1); to = $to.after(1); }
  else {
    const c = cardAround(state);
    if (!c) return false;
    from = c.bodyFrom; to = c.bodyTo;
  }
  const paras: PMNode[] = [];
  state.doc.nodesBetween(from, to, (n) => { if (n.type === schema.nodes.paragraph) paras.push(n); return false; });
  const kept = paras.filter((p) => p.textContent.trim());
  if (kept.length < 2) return false;
  if (dispatch) {
    const parts: PMNode[] = [];
    kept.forEach((p, i) => {
      const nodes: PMNode[] = [];
      p.content.forEach((n) => nodes.push(n));
      // trim the seams, then one space between
      if (nodes.length && nodes[0].isText) { const t = nodes[0].text!.replace(/^\s+/, ""); nodes[0] = t ? schema.text(t, nodes[0].marks) : nodes[0]; if (!t) nodes.shift(); }
      const l = nodes.length - 1;
      if (l >= 0 && nodes[l].isText) { const t = nodes[l].text!.replace(/\s+$/, ""); if (t) nodes[l] = schema.text(t, nodes[l].marks); else nodes.pop(); }
      if (i > 0 && nodes.length) {
        const before = parts[parts.length - 1];
        parts.push(schema.text(" ", before?.marks.filter((m) => m.type !== M.highlight) || []));
      }
      parts.push(...nodes);
    });
    const tr = state.tr.replaceWith(from, to, schema.nodes.paragraph.create(null, parts));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Paste as plain text: each line its own paragraph (F3 joins them). */
export function plainSlice(text: string): Slice {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length === 1) return new Slice(Fragment.from(lines[0] ? schema.text(lines[0]) : []), 0, 0);
  const paras = lines.map((l) => schema.nodes.paragraph.create(null, l ? schema.text(l) : null));
  return new Slice(Fragment.from(paras), 1, 1);
}

/** A new card after this one: an empty tag, a cite line and a line for the card. */
export const newCard: Cmd = (state, dispatch) => {
  const c = cardAround(state);
  const $f = state.selection.$from;
  const at = c ? c.end : $f.depth ? $f.after(1) : state.doc.content.size;
  if (dispatch) {
    const nodes = [
      schema.nodes.heading.create({ level: 4 }),
      schema.nodes.paragraph.create(),
      schema.nodes.paragraph.create(),
    ];
    const tr = state.tr.insert(at, nodes);
    tr.setSelection(TextSelection.create(tr.doc, at + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * A double-clicked word, without the space after it. Windows selects a word
 * and the space that follows it; a highlight or an underline then runs past
 * the word. Only within one paragraph, and never down to nothing.
 */
export function trimmed(state: EditorState): TextSelection | null {
  const { $from, $to, empty } = state.selection;
  if (empty || $from.parent !== $to.parent || !(state.selection instanceof TextSelection)) return null;
  const text = state.doc.textBetween($from.pos, $to.pos);
  const lead = text.length - text.replace(/^\s+/, "").length;
  const trail = text.length - text.replace(/\s+$/, "").length;
  if (!lead && !trail) return null;
  if (lead + trail >= text.length) return null;
  return TextSelection.create(state.doc, $from.pos + lead, $to.pos - trail);
}

/* ------------------------------------------------------------------ cards, in brief */

/** Every card in a document, for the search and for Evidence's index. */
export function briefs(doc: PMNode): CardBrief[] {
  const out: CardBrief[] = [];
  let block = "", cur: CardBrief | null = null, citeNext = false, n = 0;
  doc.forEach((node) => {
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (node.type === schema.nodes.heading) {
      const lv = node.attrs.level;
      if (lv <= 3) { cur = null; if (lv === 3) block = text; else block = ""; return; }
      cur = { i: n++, tag: text, cite: "", block, read: "" };
      out.push(cur);
      citeNext = true;
      return;
    }
    if (!cur || !text) return;
    if (citeNext) { cur.cite = text.slice(0, 300); citeNext = false; return; }
    if (cur.read.length > 2000) return;
    let read = "";
    node.descendants((t) => {
      if (t.isText && t.marks.some((m) => m.type === M.underline || m.type === M.highlight)) read += t.text + " ";
    });
    cur.read += read;
  });
  for (const c of out) c.read = c.read.replace(/\s+/g, " ").trim().slice(0, 2000);
  return out;
}
