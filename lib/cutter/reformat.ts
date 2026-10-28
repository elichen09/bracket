import { type EditorState, type Transaction } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../evidence/docSchema";
import { cleanUp } from "./commands";
import { isGrey } from "./reference";
import { rewriteCite } from "./cites";

/**
 * Reformat: cards cut anywhere, made to look like cards cut here.
 *
 *  - one highlight colour — the highlighter's — for every highlight that is
 *    not grey (grey is a card kept for reference, and stays grey);
 *  - emphasis boxed: words bold and underlined get the box that emphasis
 *    has in this tool;
 *  - card text in the file's own face and colour: fonts and text colours a
 *    paste brought with it come off;
 *  - card text at the two sizes a card has: what is read (underlined or
 *    highlighted) at 11pt, what was shrunk at 8pt — plain text at 11pt is a
 *    card left unshrunk on purpose, and stays;
 *  - then Clean up: no mark on a stray space, no double spaces;
 *  - and cites of the bracketed kind rewritten into one shape — first name,
 *    short cite, qualifications, "title", date, publication, link, your
 *    signature (lib/cutter/cites.ts).
 *
 * Underlining and shrunk text are left as they were, a cite already in that
 * shape is not touched, and nor are headings. The whole file, or what is selected; one undo step.
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

export interface Reformatted { tr: Transaction; recoloured: number; boxed: number; plain: number; sized: number; spaces: number; doubles: number; cites: number }

const READ_PT = 11, SHRUNK_PT = 8;

/** A size mark's points, whatever it was written in. */
function points(size: string): number {
  const m = /^([\d.]+)\s*(pt|px)?$/i.exec(String(size).trim());
  if (!m) return READ_PT;
  return (m[2] || "pt").toLowerCase() === "px" ? parseFloat(m[1]) * 0.75 : parseFloat(m[1]);
}

export function reformat(state: EditorState, color: string, signature = ""): Reformatted {
  const { from, to, empty } = state.selection;
  const a = empty ? 0 : from, b = empty ? state.doc.content.size : to;
  const tr = state.tr;
  let recoloured = 0, boxed = 0, plain = 0, sized = 0;
  // under each tag: its cite (the first line — its bold, underlined short cite is not emphasis)
  // and then the card's text, which is what gets the card's two sizes
  const citeAt = new Set<number>(), bodyAt = new Set<number>();
  let inCard = false, citeDone = false;
  state.doc.forEach((n, pos) => {
    if (n.type === schema.nodes.heading) { inCard = n.attrs.level === 4; citeDone = false; return; }
    if (!inCard || n.type !== schema.nodes.paragraph) return;
    if (/^<<.*>>$/.test(n.textContent.trim())) return;                     // a reference's marker
    if (!citeDone) { if (n.textContent.trim()) { citeAt.add(pos); citeDone = true; } return; }
    bodyAt.add(pos);
  });
  let inCite = false, inBody = false;
  state.doc.nodesBetween(a, b, (node: PMNode, pos: number, parent: PMNode | null) => {
    if (!node.isText) { if (node.isTextblock) { inCite = citeAt.has(pos); inBody = bodyAt.has(pos); } return true; }
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
    if (!inCite && has(M.strong) && has(M.underline) && !has(M.box) && (node.text || "").trim()) {
      tr.addMark(f, t, M.box.create());
      boxed += t - f;
    }
    if (has(M.fontFamily) || has(M.textColor)) {
      tr.removeMark(f, t, M.fontFamily);
      tr.removeMark(f, t, M.textColor);
      plain += t - f;
    }
    if (inBody) {
      const size = has(M.fontSize);
      const pt = size ? points(size.attrs.size) : READ_PT;
      const read = !!has(M.underline) || !!hl;
      // read: 11pt (the body's own size, so no size mark at all)
      if (read && pt !== READ_PT) { tr.removeMark(f, t, M.fontSize); sized += t - f; }
      // not read and shrunk at all: 8pt exactly; bigger than the body: back to it
      else if (!read && pt < READ_PT && pt !== SHRUNK_PT) { tr.removeMark(f, t, M.fontSize); tr.addMark(f, t, M.fontSize.create({ size: SHRUNK_PT + "pt" })); sized += t - f; }
      else if (!read && pt > READ_PT) { tr.removeMark(f, t, M.fontSize); sized += t - f; }
    }
    return false;
  });
  // and Clean up, over the same stretch of the result
  const next = state.apply(tr);
  const { tr: tidy, spaces, doubles } = cleanUp(next);
  for (const step of tidy.steps) tr.step(step);

  // the cites: the first line under each tag in the stretch, last first so nothing moves under the rest
  const doc = tr.doc;
  const lo = tr.mapping.map(a), hi = tr.mapping.map(b, 1);
  const cites: { pos: number; node: PMNode }[] = [];
  let underTag = false;
  doc.forEach((n, pos) => {
    if (n.type === schema.nodes.heading) { underTag = n.attrs.level === 4; return; }
    if (!underTag || n.type !== schema.nodes.paragraph || !n.textContent.trim()) return;
    underTag = false;
    if (/^<<.*>>$/.test(n.textContent.trim())) { underTag = true; return; }   // a reference's marker; its cite is under it
    if (pos + n.nodeSize > lo && pos < hi) cites.push({ pos, node: n });
  });
  let rewritten = 0;
  for (const c of cites.reverse()) {
    const fresh = rewriteCite(c.node, signature);
    if (!fresh || fresh.eq(c.node)) continue;
    tr.replaceWith(c.pos, c.pos + c.node.nodeSize, fresh);
    rewritten++;
  }
  closeHistory(tr);
  return { tr, recoloured, boxed, plain, sized, spaces, doubles, cites: rewritten };
}

/** As a command, for the key and the strip. */
export const reformatCmd = (color: string, signature = "") => (state: EditorState, dispatch?: (tr: Transaction) => void) => {
  const r = reformat(state, color, signature);
  if (!r.tr.docChanged) return false;
  if (dispatch) dispatch(r.tr);
  return true;
};
