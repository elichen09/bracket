import { Plugin, PluginKey, type Command } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";

/**
 * Round vision, as Flow has it: the places you will go in your next speech,
 * named and put in order, so the speech is a walk from one to the next.
 *
 * Here a stop is a line of the flow — a point, an answer, a box — marked with
 * a name and a place in the order. The mark is on the line itself, so it
 * follows the line wherever the flow is edited, and a partner in the room
 * sees the same stops.
 */

export interface Stop {
  pos: number;
  name: string;
  n: number;
  /** the line's own words */
  text: string;
  kind: string;
  who: string;
  /** the box or heading it sits under */
  under: string;
}

export function stopsOf(doc: PMNode): Stop[] {
  const out: Stop[] = [];
  let box = "", head = "";
  doc.forEach((n, pos) => {
    if (n.type === schema.nodes.box) { box = n.textContent.trim(); head = ""; }
    else if (n.type === schema.nodes.head) head = n.textContent.trim();
    if (n.attrs.stop == null) return;
    const where = n.type === schema.nodes.box ? "" : n.type === schema.nodes.head ? box : [box, head].filter(Boolean).join(" · ");
    out.push({ pos, name: String(n.attrs.stop), n: Number(n.attrs.stopN) || 0, text: n.textContent.trim(), kind: n.type.name, who: n.attrs.who || "us", under: where });
  });
  return out.sort((a, b) => a.n - b.n || a.pos - b.pos);
}

/** What a stop is called until it is named: the start of its line. */
export function guessName(n: PMNode) {
  const t = n.textContent.trim().replace(/\s+/g, " ");
  if (t) return t.length > 34 ? t.slice(0, 33).trim() + "…" : t;
  return n.type === schema.nodes.box ? "Box" : n.type === schema.nodes.head ? "Heading" : "Line";
}

/** Mark the line the cursor is in as the next stop, or take its mark off. */
export const toggleStop: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.depth < 1) return false;
  const pos = $from.before(1);
  const node = state.doc.nodeAt(pos);
  if (!node) return false;
  if (dispatch) {
    if (node.attrs.stop != null) dispatch(state.tr.setNodeMarkup(pos, null, { ...node.attrs, stop: null, stopN: null }));
    else {
      const last = Math.max(0, ...stopsOf(state.doc).map((s) => s.n));
      dispatch(state.tr.setNodeMarkup(pos, null, { ...node.attrs, stop: guessName(node), stopN: last + 1 }));
    }
  }
  return true;
};

/** Rename a stop, or (with null) take it off its line. */
export function setStop(pos: number, name: string | null): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (!node || node.attrs.stop == null) return false;
    if (dispatch) dispatch(state.tr.setNodeMarkup(pos, null, { ...node.attrs, stop: name === null ? null : name.trim() || guessName(node), stopN: name === null ? null : node.attrs.stopN }));
    return true;
  };
}

/** Put the stops in this order: positions, first stop first. */
export function reorder(order: number[]): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const tr = state.tr;
    order.forEach((pos, i) => {
      const node = tr.doc.nodeAt(pos);
      if (node && node.attrs.stop != null) tr.setNodeMarkup(pos, null, { ...node.attrs, stopN: i + 1 });
    });
    dispatch(tr);
    return true;
  };
}

/** Take every stop off. */
export const clearStops: Command = (state, dispatch) => {
  if (dispatch) {
    const tr = state.tr;
    stopsOf(state.doc).forEach((s) => { const n = tr.doc.nodeAt(s.pos); if (n) tr.setNodeMarkup(s.pos, null, { ...n.attrs, stop: null, stopN: null }); });
    dispatch(tr);
  }
  return true;
};

/**
 * The numbers in the margin, and the stop being spoken from. Which stop that
 * is lives in this plugin's state, set with a meta and carried through edits.
 */
export const visionKey = new PluginKey<{ now: number | null }>("vision");

export const visionPlugin = new Plugin<{ now: number | null }>({
  key: visionKey,
  state: {
    init: () => ({ now: null }),
    apply(tr, s) {
      const m = tr.getMeta(visionKey);
      if (m !== undefined) return { now: m };
      if (s.now != null && tr.docChanged) return { now: tr.mapping.map(s.now) };
      return s;
    },
  },
  props: {
    decorations(state) {
      const now = visionKey.getState(state)?.now ?? null;
      const decos = stopsOf(state.doc).map((s, i) => {
        const node = state.doc.nodeAt(s.pos)!;
        return Decoration.node(s.pos, s.pos + node.nodeSize, {
          class: "df-stop" + (s.pos === now ? " df-stopnow" : ""),
          "data-stop": String(i + 1),
          title: `Stop ${i + 1} — ${s.name}`,
        });
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
});
