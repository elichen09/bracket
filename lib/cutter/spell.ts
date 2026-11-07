import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../evidence/docSchema";

/**
 * Spelling, by the browser's own checker: the red underline, right-click for
 * what it should be, "Add to dictionary" — Chrome's, with the words you have
 * taught it already.
 *
 * What it looks at is yours to say. "writing" — the default — checks what you
 * wrote: tags, analytics, block headings, notes; a card's cite and text are
 * someone else's words, quoted, and a red line under every name and term of
 * art in them helps nobody. "all" checks everything; "off", nothing. It works
 * through the `spellcheck` attribute, which the browser honours element by
 * element inside an editable page.
 */

export type SpellMode = "writing" | "all" | "off";
export const SPELL_MODES: { id: SpellMode; name: string; sub: string }[] = [
  { id: "writing", name: "What you write", sub: "Tags, analytics, headings, notes — not the cards you cut" },
  { id: "all", name: "Everything", sub: "Card text and cites too" },
  { id: "off", name: "Off", sub: "No red underlines" },
];

export const spellKey = new PluginKey<{ mode: SpellMode; deco: DecorationSet }>("spelling");

/** Every paragraph that belongs to a card — its cite and its text — told not to be checked. */
function cardText(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  let inCard = false;
  doc.forEach((node, pos) => {
    if (node.type === schema.nodes.heading) { inCard = node.attrs.level === 4; return; }
    if (inCard && node.type === schema.nodes.paragraph) decos.push(Decoration.node(pos, pos + node.nodeSize, { spellcheck: "false" }));
  });
  return DecorationSet.create(doc, decos);
}

export function spellPlugin(start: SpellMode) {
  return new Plugin<{ mode: SpellMode; deco: DecorationSet }>({
    key: spellKey,
    state: {
      init: (_, state) => ({ mode: start, deco: start === "writing" ? cardText(state.doc) : DecorationSet.empty }),
      apply(tr, prev, _old, state) {
        const m = tr.getMeta(spellKey) as SpellMode | undefined;
        const mode = m || prev.mode;
        if (mode !== "writing") return mode === prev.mode && prev.deco === DecorationSet.empty ? prev : { mode, deco: DecorationSet.empty };
        if (mode !== prev.mode || tr.docChanged) return { mode, deco: cardText(state.doc) };
        return prev;
      },
    },
    props: {
      decorations: (s) => spellKey.getState(s)?.deco,
      attributes: (s): Record<string, string> => ({ spellcheck: spellKey.getState(s)?.mode === "off" ? "false" : "true" }),
    },
  });
}
