import { Schema, type DOMOutputSpec, type Node as PMNode } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/**
 * A flow written as a document.
 *
 * This is how a lot of debaters actually flow: a Google Doc, boxed titles for
 * each side, a numbered list of what the other team said in red, and the
 * answers indented under each point in black. The colour is who said it, and
 * it alternates with depth — your answer to their point is black, their
 * answer to yours is red again, yours to that is black.
 *
 * So the model is exactly that and no more. A flow line is an `item` with a
 * depth, a speaker and an optional highlight across the whole line. Lines are
 * flat, not nested lists: indenting is one attribute changing, not a subtree
 * being moved, which keeps Tab instant and undo simple, and the numbering
 * (1. a. i. 1. a. i., as Docs does it) is worked out from the order of the
 * lines rather than stored in them.
 *
 *   box    a boxed title — Weighing, NEG, AFF — as Verbatim's pocket style
 *   head   a section heading — OV, 1--water demand
 *   item   a flow line
 *   para   prose: a pre-written block, an overview written out
 */

export type Who = "them" | "us";
export const MAX_DEPTH = 8;

/** What a highlight is called, what it looks like here, and what it is in Docs. */
export const HIGHLIGHTS = {
  yellow: { label: "Yellow", docs: "#ffff00", docx: "yellow" },
  green: { label: "Green", docs: "#00ff00", docx: "green" },
  cyan: { label: "Blue", docs: "#00ffff", docx: "cyan" },
  pink: { label: "Pink", docs: "#ff00ff", docx: "magenta" },
} as const;
export type Hl = keyof typeof HIGHLIGHTS;

/**
 * A round vision stop lives on the line it marks: its name, and its place in
 * the speech. On the line, it moves when the line moves, goes when the line
 * goes, is saved with the flow and reaches a partner in the room.
 */
const STOP = { stop: { default: null }, stopN: { default: null } };

const who = (el: HTMLElement): Who => (el.getAttribute("data-who") === "us" ? "us" : "them");

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },

    box: {
      group: "block",
      content: "inline*",
      defining: true,
      attrs: { who: { default: "us" }, ...STOP },
      parseDOM: [{ tag: "div.df-box", getAttrs: (el) => ({ who: who(el as HTMLElement) }) }],
      toDOM(node): DOMOutputSpec { return ["div", { class: "df-box", "data-who": node.attrs.who }, 0]; },
    },

    head: {
      group: "block",
      content: "inline*",
      defining: true,
      attrs: { who: { default: "them" }, ...STOP },
      parseDOM: [{ tag: "h3.df-head", getAttrs: (el) => ({ who: who(el as HTMLElement) }) }],
      toDOM(node): DOMOutputSpec { return ["h3", { class: "df-head", "data-who": node.attrs.who }, 0]; },
    },

    item: {
      group: "block",
      content: "inline*",
      attrs: { depth: { default: 0 }, who: { default: "them" }, hl: { default: null }, ...STOP },
      parseDOM: [{
        tag: "div.df-item",
        getAttrs: (el) => {
          const e = el as HTMLElement;
          const d = Math.max(0, Math.min(MAX_DEPTH, Number(e.getAttribute("data-depth")) || 0));
          const h = e.getAttribute("data-hl");
          return { depth: d, who: who(e), hl: h && h in HIGHLIGHTS ? h : null };
        },
        contentElement: ".df-t",
      }],
      toDOM(node): DOMOutputSpec {
        const a: Record<string, string> = { class: "df-item", "data-depth": String(node.attrs.depth), "data-who": node.attrs.who };
        if (node.attrs.hl) a["data-hl"] = node.attrs.hl;
        return ["div", a, ["span", { class: "df-t" }, 0]];
      },
    },

    para: {
      group: "block",
      content: "inline*",
      attrs: { ...STOP },
      parseDOM: [{ tag: "p" }],
      toDOM(): DOMOutputSpec { return ["p", { class: "df-p" }, 0]; },
    },
  },

  marks: {
    strong: {
      parseDOM: [{ tag: "strong" }, { tag: "b", getAttrs: (el) => ((el as HTMLElement).style.fontWeight === "normal" ? false : null) }],
      toDOM(): DOMOutputSpec { return ["strong", 0]; },
    },
    em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM(): DOMOutputSpec { return ["em", 0]; } },
    underline: { parseDOM: [{ tag: "u" }], toDOM(): DOMOutputSpec { return ["u", 0]; } },
    strike: { parseDOM: [{ tag: "s" }, { tag: "del" }], toDOM(): DOMOutputSpec { return ["s", 0]; } },
    /** Highlighting some of a line, as distinct from all of it. */
    mark: {
      attrs: { hl: { default: "yellow" } },
      parseDOM: [{ tag: "mark", getAttrs: (el) => ({ hl: (el as HTMLElement).getAttribute("data-hl") || "yellow" }) }],
      toDOM(m): DOMOutputSpec { return ["mark", { "data-hl": m.attrs.hl }, 0]; },
    },
    /** Their words inside something that is otherwise not theirs. */
    red: {
      parseDOM: [{ tag: "span.df-red" }],
      toDOM(): DOMOutputSpec { return ["span", { class: "df-red" }, 0]; },
    },
  },
});

/* ------------------------------------------------------------------
   Numbering.
   ------------------------------------------------------------------ */

const alpha = (n: number) => { let s = ""; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };
const ROMAN: [number, string][] = [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
const roman = (n: number) => { let s = ""; for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; } return s; };
/** 1. a. i. 1. a. i. — the way Docs numbers a list nine levels deep. */
export const labelFor = (n: number, depth: number) => {
  const k = depth % 3;
  return (k === 0 ? String(n) : k === 1 ? alpha(n) : roman(n)) + ".";
};

/**
 * Walk the lines once and number each one. A box, a heading or a paragraph
 * starts the numbering again, as a new list does in Docs.
 */
export function survey(doc: PMNode): Decoration[] {
  const decos: Decoration[] = [];
  const counters: number[] = [];
  doc.forEach((node, pos) => {
    if (node.type !== schema.nodes.item) { counters.length = 0; return; }
    const d = node.attrs.depth as number;
    counters.length = d + 1;
    for (let k = 0; k < d; k++) if (!counters[k]) counters[k] = 1;
    counters[d] = (counters[d] || 0) + 1;
    decos.push(Decoration.node(pos, pos + node.nodeSize, { "data-label": labelFor(counters[d], d) }));
  });
  return decos;
}

/** Keeps the numbering current. */
export const surveyPlugin = new Plugin({
  state: {
    init: (_, state) => DecorationSet.create(state.doc, survey(state.doc)),
    apply: (tr, old, _prev, state) => (tr.docChanged ? DecorationSet.create(state.doc, survey(state.doc)) : old),
  },
  props: { decorations(state) { return this.getState(state); } },
});

/** An empty flow: a box to start from and a first line to type into. */
export function blankDoc() {
  return schema.node("doc", null, [
    schema.node("box", { who: "us" }, schema.text("NEG")),
    schema.node("item", { depth: 0, who: "them", hl: null }),
  ]);
}
