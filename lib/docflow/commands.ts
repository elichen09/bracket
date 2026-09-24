import { TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import type { Node as PMNode, NodeType } from "prosemirror-model";
import { schema, MAX_DEPTH, type Who, type Hl } from "./schema";

/**
 * What the keys do to a flow.
 *
 * The rules are the ones a debater already follows by hand in a Google Doc:
 *
 *   Enter        the next line, at the same level, from the same speaker
 *   Tab          answer it — one level in, and the other speaker
 *   Shift+Tab    back out a level, and back to whoever speaks at that level
 *   Ctrl+Enter   their next point: a new top-level line after this one's answers
 *
 * "Who speaks at that level" is read off the lines above, not stored
 * anywhere: a line takes the speaker of the line above it at the same depth,
 * or the opposite of the line it answers. So a flow stays red, black, red
 * down the levels without anyone choosing a colour.
 */

const T = schema.nodes;
const flip = (w: Who): Who => (w === "them" ? "us" : "them");

/** Where the i-th block of the document starts. */
export function posOf(doc: PMNode, i: number) {
  let pos = 0;
  for (let k = 0; k < i && k < doc.childCount; k++) pos += doc.child(k).nodeSize;
  return pos;
}

/** Who speaks at `depth` for a line at block index `i`. */
export function whoFor(doc: PMNode, i: number, depth: number): Who {
  for (let j = i - 1; j >= 0; j--) {
    const n = doc.child(j);
    if (n.type !== T.item) break;
    const d = n.attrs.depth as number;
    if (d === depth) return n.attrs.who;           // a line alongside: same speaker
    if (d < depth) return flip(n.attrs.who);       // the line it answers: the other one
  }
  return depth === 0 ? "them" : "us";
}

/** The top-level blocks the selection touches, by index. */
function span(state: EditorState) {
  const { $from, $to } = state.selection;
  return { i0: $from.index(0), i1: $to.index(0) };
}

/* ---------------------------------------------------------------- depth */

function changeDepth(delta: 1 | -1): Command {
  return (state, dispatch) => {
    const { i0, i1 } = span(state);
    const tr = state.tr;
    let changed = false;
    for (let i = i0; i <= i1; i++) {
      const node = tr.doc.child(i);
      // A paragraph that is tabbed becomes an answer to the line above it.
      if (node.type === T.para && delta > 0) {
        const prev = i > 0 ? tr.doc.child(i - 1) : null;
        const d = prev && prev.type === T.item ? Math.min(MAX_DEPTH, prev.attrs.depth + 1) : 0;
        tr.setNodeMarkup(posOf(tr.doc, i), T.item, { depth: d, who: whoFor(tr.doc, i, d), hl: null });
        changed = true;
        continue;
      }
      if (node.type !== T.item) continue;
      const d = node.attrs.depth as number;
      const nd = d + delta;
      if (nd < 0 || nd > MAX_DEPTH) continue;
      if (delta > 0) {
        // never more than one level under the line above it
        const prev = i > 0 ? tr.doc.child(i - 1) : null;
        const cap = prev && prev.type === T.item ? (prev.attrs.depth as number) + 1 : 0;
        if (nd > cap) continue;
      }
      tr.setNodeMarkup(posOf(tr.doc, i), null, { ...node.attrs, depth: nd, who: whoFor(tr.doc, i, nd) });
      changed = true;
    }
    if (changed && dispatch) dispatch(tr.scrollIntoView());
    // Tab is always taken, so it never leaves the page for the next button.
    return true;
  };
}
export const indent = changeDepth(1);
export const outdent = changeDepth(-1);

/* ---------------------------------------------------------------- enter */

function splitAs(tr: Transaction, type: NodeType, attrs: Record<string, unknown> | null) {
  return tr.split(tr.selection.from, 1, [{ type, attrs: attrs || undefined }]);
}

export const enter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if ($from.depth !== 1) return false;
  const node = $from.parent;
  const i = $from.index(0);

  if (node.type === T.item) {
    if (node.content.size === 0) {
      // An empty line: up a level, the way a list in Docs does — and off the
      // top of the list into prose.
      if (node.attrs.depth > 0) return outdent(state, dispatch);
      if (dispatch) dispatch(state.tr.setNodeMarkup($from.before(), T.para));
      return true;
    }
    if (dispatch) {
      let tr = state.tr;
      if (!empty) tr = tr.deleteSelection();
      tr = splitAs(tr, T.item, { depth: node.attrs.depth, who: node.attrs.who, hl: null });
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  if (node.type === T.box || node.type === T.head) {
    if (!dispatch) return true;
    let tr = state.tr;
    if ($from.parentOffset < node.content.size) {
      dispatch(splitAs(tr, node.type, node.attrs).scrollIntoView());
      return true;
    }
    // After a title, the first thing written is one of their points.
    const at = $from.after();
    tr = tr.insert(at, T.item.create({ depth: 0, who: "them", hl: null }));
    tr = tr.setSelection(TextSelection.create(tr.doc, at + 1));
    dispatch(tr.scrollIntoView());
    return true;
  }

  if (node.type === T.para) {
    if (dispatch) {
      let tr = state.tr;
      if (!empty) tr = tr.deleteSelection();
      dispatch(splitAs(tr, T.para, null).scrollIntoView());
    }
    return true;
  }
  void i;
  return false;
};

/** Their next point: a new top-level line after everything said under this one. */
export const nextPoint: Command = (state, dispatch) => {
  const doc = state.doc;
  let j = state.selection.$to.index(0) + 1;
  while (j < doc.childCount && doc.child(j).type === T.item && doc.child(j).attrs.depth > 0) j++;
  if (!dispatch) return true;
  const at = posOf(doc, j);
  let tr = state.tr.insert(at, T.item.create({ depth: 0, who: "them", hl: null }));
  tr = tr.setSelection(TextSelection.create(tr.doc, at + 1));
  dispatch(tr.scrollIntoView());
  return true;
};

/** An answer to this line: one level in, straight under it. */
export const answer: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.depth !== 1 || $from.parent.type !== T.item) return false;
  const i = $from.index(0);
  const d = Math.min(MAX_DEPTH, ($from.parent.attrs.depth as number) + 1);
  if (!dispatch) return true;
  const at = $from.after();
  let tr = state.tr.insert(at, T.item.create({ depth: d, who: flip($from.parent.attrs.who), hl: null }));
  tr = tr.setSelection(TextSelection.create(tr.doc, at + 1));
  void i;
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Tab. At the end of a line you have just written, it starts the answer to
 * that line — which is almost always what comes next, and where Docs would
 * only type a tab character. At the start of a line, or on an empty one, it
 * indents the line itself, the way Docs does.
 */
export const tab: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (empty && $from.depth === 1) {
    const node = $from.parent;
    if (node.type === T.item && node.content.size > 0 && $from.parentOffset === node.content.size) {
      return answer(state, dispatch);
    }
  }
  return indent(state, dispatch);
};

/** Backspace at the start of an indented line brings it out a level first. */
export const backspace: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 1 || $from.parentOffset > 0) return false;
  const node = $from.parent;
  if (node.type === T.item && node.attrs.depth > 0) return outdent(state, dispatch);
  return false;
};

/* ---------------------------------------------------------------- who, and highlighting */

/** Swap who said it, for every line, title and heading the selection touches. */
export const toggleWho: Command = (state, dispatch) => {
  const { i0, i1 } = span(state);
  const tr = state.tr;
  for (let i = i0; i <= i1; i++) {
    const n = tr.doc.child(i);
    if (n.type === T.item || n.type === T.box || n.type === T.head) {
      tr.setNodeMarkup(posOf(tr.doc, i), null, { ...n.attrs, who: flip(n.attrs.who) });
    }
  }
  if (dispatch) dispatch(tr);
  return true;
};

/**
 * Highlight. With nothing selected, the whole line — which is how a flow is
 * highlighted, a line at a time. With words selected inside one line, just
 * those words. The same colour again takes it off.
 */
export function highlight(hl: Hl): Command {
  return (state, dispatch) => {
    const { from, to, empty, $from, $to } = state.selection;
    const oneBlock = $from.index(0) === $to.index(0);
    if (!empty && oneBlock) {
      const type = schema.marks.mark;
      const has = state.doc.rangeHasMark(from, to, type) &&
        (() => { let same = true; state.doc.nodesBetween(from, to, (n) => { n.marks.forEach((m) => { if (m.type === type && m.attrs.hl !== hl) same = false; }); }); return same; })();
      if (dispatch) {
        const tr = state.tr.removeMark(from, to, type);
        if (!has) tr.addMark(from, to, type.create({ hl }));
        dispatch(tr);
      }
      return true;
    }
    const { i0, i1 } = span(state);
    const tr = state.tr;
    let all = true;
    for (let i = i0; i <= i1; i++) { const n = tr.doc.child(i); if (n.type === T.item && n.attrs.hl !== hl) all = false; }
    for (let i = i0; i <= i1; i++) {
      const n = tr.doc.child(i);
      if (n.type === T.item) tr.setNodeMarkup(posOf(tr.doc, i), null, { ...n.attrs, hl: all ? null : hl });
    }
    if (dispatch) dispatch(tr);
    return true;
  };
}

/* ---------------------------------------------------------------- turning a line into something else */

/**
 * Turn the block the cursor is in into another kind, keeping its words — or,
 * if it holds only a slash command, into an empty one of that kind with
 * `text` in it.
 */
export function setBlock(kind: "box" | "head" | "item" | "para", attrs: Record<string, unknown> = {}, text?: string): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    if ($from.depth !== 1) return false;
    const i = $from.index(0);
    const at = $from.before();
    const node = $from.parent;
    const type = T[kind];
    let base: Record<string, unknown> = {};
    if (kind === "item") {
      const d = (attrs.depth as number) ?? 0;
      base = { depth: d, who: attrs.who ?? whoFor(state.doc, i, d), hl: null };
    } else if (kind === "box" || kind === "head") base = { who: attrs.who ?? (kind === "box" ? "us" : "them") };
    if (!dispatch) return true;
    let tr = state.tr.setNodeMarkup(at, type, kind === "para" ? null : { ...base, ...attrs });
    if (text !== undefined) {
      tr = tr.replaceWith(at + 1, at + 1 + node.content.size, text ? schema.text(text) : []);
    }
    const end = at + 1 + tr.doc.child(i).content.size;
    // A title or a heading is followed by somewhere to write under it.
    if ((kind === "box" || kind === "head") && text) {
      const after = at + tr.doc.child(i).nodeSize;
      const nextIsLine = i + 1 < tr.doc.childCount && tr.doc.child(i + 1).type === T.item && tr.doc.child(i + 1).content.size === 0;
      if (!nextIsLine) tr = tr.insert(after, T.item.create({ depth: 0, who: "them", hl: null }));
      tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
    } else {
      tr = tr.setSelection(TextSelection.create(tr.doc, end));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Lines under the current one, as answers: one level in, the other speaker. */
export function answerWith(lines: string[]): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    if ($from.depth !== 1 || !lines.length) return false;
    const node = $from.parent;
    const i = $from.index(0);
    const isLine = node.type === T.item;
    const d = isLine ? Math.min(MAX_DEPTH, (node.attrs.depth as number) + 1) : 0;
    const w: Who = isLine ? flip(node.attrs.who) : "us";
    if (!dispatch) return true;
    // after this line's existing answers, so new ones follow what is there
    let j = i + 1;
    const doc = state.doc;
    while (isLine && j < doc.childCount && doc.child(j).type === T.item && doc.child(j).attrs.depth >= d) j++;
    let at = posOf(doc, j);
    let tr = state.tr;
    lines.forEach((ln) => {
      const n = T.item.create({ depth: d, who: w, hl: null }, ln ? schema.text(ln) : undefined);
      tr = tr.insert(at, n);
      at += n.nodeSize;
    });
    tr = tr.setSelection(TextSelection.create(tr.doc, at - 1));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export const EMPTY_LINE = { depth: 0, who: "them" as Who };
