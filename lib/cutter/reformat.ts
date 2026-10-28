import { type EditorState, type Transaction } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../evidence/docSchema";
import { cleanUp } from "./commands";
import { isGrey } from "./reference";

/**
 * Reformat: cards cut anywhere, made to look like cards cut here.
 *
 *  - one highlight colour — the highlighter's — for every highlight that is
 *    not grey (grey is a card kept for reference, and stays grey);
 *  - emphasis boxed: words bold and underlined get the box that emphasis
 *    has in this tool;
 *  - card text in the file's own face and colour: fonts and text colours a
 *    paste brought with it come off;
 *  - then Clean up: no mark on a stray space, no double spaces.
 *
 * Underlining, shrunk text and the cite are left as they were, and headings
 * are not touched. The whole file, or what is selected; one undo step.
 */

const M = schema.marks;

const sameColour = (a: string, b: string) => {
  const norm = (c: string) => {
    const s = String(c).trim().toLowerCase();
    const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s);
    return rgb ? "#" + [rgb[1], rgb[2], rgb[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("") : s;
  };
  return norm(a) === norm(b);
};

export interface Reformatted { tr: Transaction; recoloured: number; boxed: number; plain: number; spaces: number; doubles: number }

export function reformat(state: EditorState, color: string): Reformatted {
  const { from, to, empty } = state.selection;
  const a = empty ? 0 : from, b = empty ? state.doc.content.size : to;
  const tr = state.tr;
  let recoloured = 0, boxed = 0, plain = 0;
  state.doc.nodesBetween(a, b, (node: PMNode, pos: number, parent: PMNode | null) => {
    if (!node.isText) return true;
    if (parent && parent.type === schema.nodes.heading) return false;     // headings keep their own look
    const f = Math.max(pos, a), t = Math.min(pos + node.nodeSize, b);
    if (t <= f) return false;
    const has = (type: (typeof M)[keyof typeof M]) => node.marks.find((m) => m.type === type);
    const hl = has(M.highlight);
    if (hl && !isGrey(hl.attrs.color) && !sameColour(hl.attrs.color, color)) {
      tr.removeMark(f, t, M.highlight);
      tr.addMark(f, t, M.highlight.create({ color }));
      recoloured += t - f;
    }
    if (has(M.strong) && has(M.underline) && !has(M.box) && (node.text || "").trim()) {
      tr.addMark(f, t, M.box.create());
      boxed += t - f;
    }
    if (has(M.fontFamily) || has(M.textColor)) {
      tr.removeMark(f, t, M.fontFamily);
      tr.removeMark(f, t, M.textColor);
      plain += t - f;
    }
    return false;
  });
  // and Clean up, over the same stretch of the result
  const next = state.apply(tr);
  const { tr: tidy, spaces, doubles } = cleanUp(next);
  for (const step of tidy.steps) tr.step(step);
  closeHistory(tr);
  return { tr, recoloured, boxed, plain, spaces, doubles };
}

/** As a command, for the key and the strip. */
export const reformatCmd = (color: string) => (state: EditorState, dispatch?: (tr: Transaction) => void) => {
  const r = reformat(state, color);
  if (!r.tr.docChanged) return false;
  if (dispatch) dispatch(r.tr);
  return true;
};
