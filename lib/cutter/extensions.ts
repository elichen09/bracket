import { TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../evidence/docSchema";
import { sections } from "./commands";

/**
 * Extensions: analytics under a block, a page each — the way a 1AR file is
 * written. A pocket names the speech ("1AR"); each block starts a new page,
 * its heading ending in the speech ("AT: T---Fairness---1AR"); under it, the
 * analytics, all bold, the words that matter underlined (Cut does that).
 */

type Cmd = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;
const M = schema.marks;
const SPEECH = /\b(1AC|1NC|2AC|2NC|1NR|1AR|2NR|2AR)\b/i;

/** The speech a block belongs to: the nearest pocket above that names one, or else the file's name. */
export function speechAt(state: EditorState, pos: number, fileName = ""): string {
  let found = "";
  state.doc.forEach((n, p) => {
    if (p > pos || n.type !== schema.nodes.heading || n.attrs.level !== 1) return;
    const m = SPEECH.exec(n.textContent);
    found = m ? m[1].toUpperCase() : "";
  });
  if (found) return found;
  const m = SPEECH.exec(fileName);
  return m ? m[1].toUpperCase() : "";
}

/** A paragraph is an analytic when every bit of its text is bold. */
export const isAnalytic = (n: PMNode) => {
  if (n.type !== schema.nodes.paragraph || !n.textContent.trim()) return false;
  let all = true;
  n.descendants((t) => { if (t.isText && t.text!.trim() && !t.marks.some((m) => m.type === M.strong)) all = false; });
  return all;
};

/**
 * A new extension: a page break, a block heading ending in the speech
 * ("---1AR"), and a line under it that types bold. It goes after the block
 * the cursor is in, and the cursor waits at the start of the heading for
 * "AT: Presumption".
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
    for (let b = state.doc.resolve(start).nodeBefore; b && b.type === schema.nodes.paragraph && !b.textContent.trim(); b = state.doc.resolve(start).nodeBefore) start -= b.nodeSize;
    const nodes: PMNode[] = [];
    const before = start > 0 ? state.doc.resolve(start).nodeBefore : null;
    if (before && before.type !== schema.nodes.pageBreak) nodes.push(schema.nodes.pageBreak.create());
    const head = schema.nodes.heading.create({ level: 3 }, speech ? schema.text("---" + speech) : null);
    nodes.push(head, schema.nodes.paragraph.create());
    const tr = state.tr.replaceWith(start, at, nodes);
    const headAt = start + (nodes.length === 3 ? nodes[0].nodeSize : 0);
    tr.setSelection(TextSelection.create(tr.doc, headAt + 1));
    // its own step in the undo, apart from the typing just before it
    dispatch(closeHistory(tr.scrollIntoView()));
  }
  return true;
};

/** The paragraphs selected become bold analytics — or, if they all are, plain again. */
export const analytic: Cmd = (state, dispatch) => {
  const { from, to } = state.selection;
  const paras: { pos: number; node: PMNode }[] = [];
  state.doc.nodesBetween(from, to, (n, pos) => {
    if (n.type === schema.nodes.paragraph) { paras.push({ pos, node: n }); return false; }
    return true;
  });
  if (!paras.length) return false;
  const all = paras.every((p) => isAnalytic(p.node));
  if (dispatch) {
    const tr = state.tr;
    for (const p of paras) {
      const a = p.pos + 1, b = p.pos + p.node.nodeSize - 1;
      if (all) tr.removeMark(a, b, M.strong); else tr.addMark(a, b, M.strong.create());
    }
    if (!all && state.selection.empty) tr.setStoredMarks([M.strong.create()]);
    if (all && state.selection.empty) tr.setStoredMarks([]);
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
 * Enter that knows what is being written: out of a block or hat heading the
 * next line starts bold — an extension's analytic — from wherever the cursor
 * is in the heading, so its "---1AR" is never split off; and at the end of a
 * bold analytic the next line stays bold. Anywhere else, Enter as usual.
 */
export const enterKeepingAnalytics: Cmd = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock) return false;
  const p = $from.parent;
  // a block heading is never split — wherever the cursor is in it (often just before
  // its "---1AR"), Enter goes to the line under it
  const fromBlock = p.type === schema.nodes.heading && p.attrs.level <= 3 && p.attrs.level >= 2;
  const atEnd = $from.parentOffset === p.content.size;
  if (!fromBlock && !(atEnd && isAnalytic(p))) return false;
  if (dispatch) {
    const at = $from.after();
    const next = state.doc.resolve(at).nodeAfter;
    // an empty line already waiting under it is used, rather than another made
    const tr = next && next.type === schema.nodes.paragraph && !next.content.size ? state.tr : state.tr.insert(at, schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, at + 1));
    tr.setStoredMarks([M.strong.create()]);
    dispatch(tr.scrollIntoView());
  }
  return true;
};
