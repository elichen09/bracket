import { TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../evidence/docSchema";
import { sections } from "./commands";

/**
 * Extensions: analytics under a block, a page each — the way a 1AR file is
 * written. A pocket names the speech ("1AR"); each block starts a new page,
 * its heading ending in the speech ("AT: T---Fairness---1AR"); under it, the
 * analytics, each one a Heading 4 — bold, 13pt, the tag style — the words
 * that matter underlined (Cut does that). Evidence reads each one as a tag of
 * the block, so they can be found and sent like any other.
 */

type Cmd = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;
const M = schema.marks;
const H = schema.nodes.heading;
const P = schema.nodes.paragraph;
const SPEECH = /\b(1AC|1NC|2AC|2NC|1NR|1AR|2NR|2AR)\b/i;

/** The speech a block belongs to: the nearest pocket above that names one, or else the file's name. */
export function speechAt(state: EditorState, pos: number, fileName = ""): string {
  let found = "";
  state.doc.forEach((n, p) => {
    if (p > pos || n.type !== H || n.attrs.level !== 1) return;
    const m = SPEECH.exec(n.textContent);
    found = m ? m[1].toUpperCase() : "";
  });
  if (found) return found;
  const m = SPEECH.exec(fileName);
  return m ? m[1].toUpperCase() : "";
}

const isTag = (n: PMNode | null | undefined) => !!n && n.type === H && n.attrs.level === 4;

/** A paragraph written as an analytic the old way: every bit of its text bold. */
export const isAnalytic = (n: PMNode) => {
  if (n.type !== P || !n.textContent.trim()) return false;
  let all = true;
  n.descendants((t) => { if (t.isText && t.text!.trim() && !t.marks.some((m) => m.type === M.strong)) all = false; });
  return all;
};

/**
 * Is the top-level line at `index` part of a run of analytics — nothing but
 * Heading 4 lines between it and the block (or hat) heading above?
 */
function inAnalyticRun(doc: PMNode, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const n = doc.child(i);
    if (n.type === H && n.attrs.level <= 3) return n.attrs.level >= 2;
    if (!isTag(n)) return false;
  }
  return false;
}

/**
 * A new extension: a page break, a block heading ending in the speech
 * ("---1AR"), and a Heading 4 line under it for the first analytic. It goes
 * after the block the cursor is in, and the cursor waits at the start of the
 * heading for "AT: Presumption".
 */
export const newExtension = (fileName = ""): Cmd => (state, dispatch) => {
  const from = state.selection.from;
  const $f = state.selection.$from;
  const mine = [...sections(state.doc)].reverse().find((s) => s.pos <= from && s.level <= 3);
  const at = mine ? mine.end : $f.depth ? $f.after(1) : state.doc.content.size;
  const speech = speechAt(state, from, fileName);
  if (dispatch) {
    // empty lines left at the end of the block before are swept up, not pushed onto its page
    let start = at;
    for (let b = state.doc.resolve(start).nodeBefore; b && b.isTextblock && b.type === P && !b.textContent.trim(); b = state.doc.resolve(start).nodeBefore) start -= b.nodeSize;
    const nodes: PMNode[] = [];
    const before = start > 0 ? state.doc.resolve(start).nodeBefore : null;
    if (before && before.type !== schema.nodes.pageBreak) nodes.push(schema.nodes.pageBreak.create());
    nodes.push(H.create({ level: 3 }, speech ? schema.text("---" + speech) : null), H.create({ level: 4 }));
    const tr = state.tr.replaceWith(start, at, nodes);
    const headAt = start + (nodes.length === 3 ? nodes[0].nodeSize : 0);
    tr.setSelection(TextSelection.create(tr.doc, headAt + 1));
    // its own step in the undo, apart from the typing just before it
    dispatch(closeHistory(tr.scrollIntoView()));
  }
  return true;
};

/**
 * The lines selected become analytics — Heading 4 — or, if they all are,
 * plain paragraphs again. Bold paragraphs written the old way become Heading
 * 4 with their bold taken off (the heading is bold already).
 */
export const analytic: Cmd = (state, dispatch) => {
  const { from, to } = state.selection;
  const lines: { pos: number; node: PMNode }[] = [];
  state.doc.nodesBetween(from, to, (n, pos) => {
    if (n.isTextblock) { if (n.type === P || isTag(n)) lines.push({ pos, node: n }); return false; }
    return true;
  });
  if (!lines.length) return false;
  const all = lines.every((l) => isTag(l.node));
  if (dispatch) {
    const tr = state.tr;
    for (const l of lines) {
      const a = l.pos + 1, b = l.pos + l.node.nodeSize - 1;
      if (all) tr.setBlockType(l.pos, l.pos + l.node.nodeSize, P);
      else { tr.removeMark(a, b, M.strong); tr.setBlockType(l.pos, l.pos + l.node.nodeSize, H, { level: 4 }); }
    }
    tr.setStoredMarks([]);
    dispatch(tr);
  }
  return true;
};

/** A page break here, as Word does it: above the line at its start, splitting it anywhere else. */
export const pageBreak: Cmd = (state, dispatch) => {
  if (!state.selection.$from.parent.isTextblock) return false;
  if (dispatch) {
    const tr = state.tr;
    if (!state.selection.empty) tr.deleteSelection();
    const $p = tr.selection.$from;
    if ($p.parentOffset === 0) tr.insert($p.before(), schema.nodes.pageBreak.create());
    else {
      tr.split($p.pos);
      tr.insert(tr.selection.$from.before(), schema.nodes.pageBreak.create());
    }
    dispatch(closeHistory(tr.scrollIntoView()));
  }
  return true;
};

/**
 * Enter that knows what is being written.
 *
 * In a block or hat heading — wherever the cursor is, often just before its
 * "---1AR", which is never split off — Enter goes to the line under it, a
 * Heading 4: an extension's first analytic, or a card's tag.
 *
 * At the end of a Heading 4: if an empty line is waiting under it (a new
 * card's cite line), Enter goes there; if the Heading 4 is one of a run of
 * them straight under a block — analytics — the next line is another; on an
 * empty one, Enter turns it back into plain text, so two Enters end the run.
 *
 * At the end of a bold analytic written the old way, the next line stays
 * bold. Anywhere else, Enter as usual.
 */
export const enterKeepingAnalytics: Cmd = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.depth !== 1) return false;
  const p = $from.parent;
  const doc = state.doc;
  const after = $from.after();
  const next = doc.resolve(after).nodeAfter;
  const atEnd = $from.parentOffset === p.content.size;

  /** Into the line under this one: the empty one waiting there, as `make`, or a new one. */
  const down = (make: "tag" | "plain-bold") => {
    if (!dispatch) return true;
    const tr = state.tr;
    if (next && next.isTextblock && !next.content.size && (next.type === P || isTag(next))) {
      if (make === "tag" && !isTag(next)) tr.setBlockType(after, after + next.nodeSize, H, { level: 4 });
    } else {
      tr.insert(after, make === "tag" ? H.create({ level: 4 }) : P.create());
    }
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    tr.setStoredMarks(make === "plain-bold" ? [M.strong.create()] : []);
    dispatch(tr.scrollIntoView());
    return true;
  };

  if (p.type === H && p.attrs.level >= 2 && p.attrs.level <= 3) return down("tag");

  if (isTag(p) && atEnd) {
    if (!p.content.size) {
      if (dispatch) dispatch(state.tr.setBlockType($from.before(), after, P));
      return true;
    }
    if (next && next.type === P && !next.content.size) {
      if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(doc, after + 1)).scrollIntoView());
      return true;
    }
    if (inAnalyticRun(doc, $from.index(0))) return down("tag");
    return false;
  }

  if (atEnd && isAnalytic(p)) return down("plain-bold");
  return false;
};
