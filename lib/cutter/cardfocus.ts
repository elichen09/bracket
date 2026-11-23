import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { schema } from "../evidence/docSchema";

/**
 * Focus on the card: the card the cursor is in — its tag down to the next
 * heading — is marked "rm-here", and the editor says it has one
 * ("rm-cardon"). magic.css fades everything else back while the page has the
 * keyboard and the focus is on (.rm.cardfocus); nothing is faded when the
 * cursor is on a block or above the first card. Only a class: the file is
 * never touched.
 */

interface Here { from: number; to: number; set: DecorationSet }
const key = new PluginKey<Here | null>("cardfocus");

function here(state: EditorState): { from: number; to: number } | null {
  const doc = state.doc;
  const $at = state.selection.$from;
  if ($at.depth < 1) return null;
  const idx = $at.index(0);
  // back to the heading over the cursor: a tag makes it a card
  let start = -1, i = idx, pos = $at.before(1);
  for (; i >= 0; i--) {
    const n = doc.child(i);
    if (n.type === schema.nodes.heading) { if (n.attrs.level === 4) start = pos; break; }
    if (i > 0) pos -= doc.child(i - 1).nodeSize;
  }
  if (start < 0) return null;
  // and on to the next heading
  let end = $at.after(1);
  for (let j = idx + 1; j < doc.childCount; j++) {
    const n = doc.child(j);
    if (n.type === schema.nodes.heading) break;
    end += n.nodeSize;
  }
  return { from: start, to: end };
}

function build(state: EditorState): Here | null {
  const h = here(state);
  if (!h) return null;
  const decos: Decoration[] = [];
  state.doc.nodesBetween(h.from, h.to, (n, pos) => {
    decos.push(Decoration.node(pos, pos + n.nodeSize, { class: "rm-here" }));
    return false;
  });
  return { ...h, set: DecorationSet.create(state.doc, decos) };
}

export function cardFocusPlugin(): Plugin {
  return new Plugin<Here | null>({
    key,
    state: {
      init: (_, s) => build(s),
      apply: (tr, old, _o, s) => {
        if (!tr.docChanged && !tr.selectionSet) return old;
        const h = here(s);
        if (!h) return null;
        if (old && !tr.docChanged && old.from === h.from && old.to === h.to) return old;
        return build(s);
      },
    },
    props: {
      decorations: (s) => key.getState(s)?.set || null,
      attributes: (s): Record<string, string> => (key.getState(s) ? { class: "rm-cardon" } : {}),
    },
  });
}
