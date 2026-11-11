import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../evidence/docSchema";

/**
 * Tags only: a document folded down to its headings, so it can be read — and
 * reordered — as an outline. Each card's cite and text go out of sight; its
 * tag stays
 * — a small ▸ after it opens just that card (its title says which: the short
 * cite, how long it is), and the ▾ of an opened one hides it again.
 * Nothing is taken out of the document: it is hidden, and moves with its tag
 * (drag the ⋮⋮, Alt+↑/↓, the outline), and comes back with the same key.
 *
 * The cursor never goes into what is hidden. Arrow keys step over it to the
 * next tag; a new line typed after a tag stays in view while it is written.
 */

interface Card { pos: number; node: PMNode; bodyFrom: number; bodyTo: number; cite: string; words: number }
interface Fold { all: boolean; flip: number[]; deco: DecorationSet; bodies: [number, number][] }
export const foldKey = new PluginKey<Fold>("fold");

const H = schema.nodes.heading;

/** Every card: its tag, and where its cite and text run. */
function cards(doc: PMNode): Card[] {
  const out: Card[] = [];
  let cur: Card | null = null;
  doc.forEach((n, pos) => {
    if (n.type === H) {
      if (cur) out.push(cur);
      cur = n.attrs.level === 4 ? { pos, node: n, bodyFrom: pos + n.nodeSize, bodyTo: pos + n.nodeSize, cite: "", words: 0 } : null;
      return;
    }
    if (!cur) return;
    cur.bodyTo = pos + n.nodeSize;
    const t = n.textContent.trim();
    if (!t) return;
    if (!cur.cite) {
      // the short cite: its bold words ("Drennan & Tabatabai 26"), or its start
      let bold = "";
      n.forEach((c) => { if (!bold && c.isText && c.marks.some((m) => m.type === schema.marks.strong) && c.text!.trim()) bold = c.text!.trim(); });
      cur.cite = (bold || t).slice(0, 60);
      return;
    }
    cur.words += (t.match(/\S+/g) || []).length;
  });
  if (cur) out.push(cur);
  return out;
}

function chip(view: EditorView, getPos: () => number | undefined, label: string, open: boolean) {
  const el = document.createElement("span");
  el.className = "rm-foldchip" + (open ? " open" : "");
  el.contentEditable = "false";
  // a chevron, drawn: the ▸ character is a speck in most fonts
  el.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${open ? "M2 3.5l3 3 3-3" : "M3.5 2l3 3-3 3"}"/></svg>`;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", open ? "Hide this card" : "Show this card");
  el.title = open ? "Hide this card again" : label ? "Show this card — " + label : "Show this card";
  el.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
  el.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const at = getPos();
    if (typeof at !== "number") return;
    const $p = view.state.doc.resolve(at);
    if ($p.depth < 1) return;
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: $p.before(1) }).setMeta("addToHistory", false));
  });
  return el;
}

function build(state: EditorState, all: boolean, flip: number[]): { deco: DecorationSet; bodies: [number, number][] } {
  if (!all && !flip.length) return { deco: DecorationSet.empty, bodies: [] };
  const flipped = new Set(flip);
  const decos: Decoration[] = [];
  const bodies: [number, number][] = [];
  const $h = state.selection.$head;
  const here = $h.depth ? $h.before(1) : -1;
  for (const c of cards(state.doc)) {
    const folded = all !== flipped.has(c.pos);
    const end = c.pos + c.node.nodeSize - 1;
    const hasBody = c.bodyTo > c.bodyFrom && (c.cite || c.words);
    if (folded) {
      if (hasBody) {
        const label = [c.cite, c.words ? c.words.toLocaleString() + " words" : ""].filter(Boolean).join(" · ") + " ▸";
        decos.push(Decoration.widget(end, (v, g) => chip(v, g, label.replace(/ ▸$/, ""), false), { side: 1, key: "fold:" + c.pos + ":" + label, ignoreSelection: true, stopEvent: () => true }));
      }
      bodies.push([c.bodyFrom, c.bodyTo]);
      state.doc.nodesBetween(c.bodyFrom, c.bodyTo, (n, pos) => {
        // the line being written stays in view
        if (pos !== here) decos.push(Decoration.node(pos, pos + n.nodeSize, { class: "rm-folded" }));
        return false;
      });
    } else if (all && hasBody) {
      decos.push(Decoration.widget(end, (v, g) => chip(v, g, "", true), { side: 1, key: "unfold:" + c.pos, ignoreSelection: true, stopEvent: () => true }));
    }
  }
  return { deco: DecorationSet.create(state.doc, decos), bodies };
}

const inBody = (bodies: [number, number][], pos: number) => bodies.some(([a, b]) => pos >= a && pos < b);

export function foldPlugin(start = false) {
  return new Plugin<Fold>({
    key: foldKey,
    state: {
      init: (_, state) => ({ all: start, flip: [], ...build(state, start, []) }),
      apply(tr, prev, _old, state) {
        const m = tr.getMeta(foldKey) as { all?: boolean; toggle?: number } | undefined;
        let { all, flip } = prev;
        if (m && typeof m.all === "boolean") { all = m.all; flip = []; }
        if (m && typeof m.toggle === "number") flip = flip.includes(m.toggle) ? flip.filter((p) => p !== m.toggle) : [...flip, m.toggle];
        if (tr.docChanged && flip.length) flip = flip.map((p) => tr.mapping.mapResult(p)).filter((r) => !r.deleted).map((r) => r.pos);
        if (!all && !flip.length) return prev.deco === DecorationSet.empty ? { ...prev, all, flip } : { all, flip, deco: DecorationSet.empty, bodies: [] };
        if (!m && !tr.docChanged && !tr.selectionSet) return prev;
        return { all, flip, ...build(state, all, flip) };
      },
    },
    props: {
      decorations: (state) => foldKey.getState(state)?.deco,
      // ↑ and ↓ off the edge of a line go to the next line that shows — the next tag — not into what is hidden
      handleKeyDown(view, e) {
        if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
        const f = foldKey.getState(view.state);
        if (!f || !f.bodies.length) return false;
        const down = e.key === "ArrowDown";
        if (!view.endOfTextblock(down ? "down" : "up")) return false;
        const $h = view.state.selection.$head;
        if ($h.depth < 1) return false;
        const here = $h.before(1), doc = view.state.doc;
        let target: number | null = null;
        doc.forEach((n, p) => {
          if (!n.isTextblock || inBody(f.bodies, p)) return;
          if (down && target === null && p > here) target = p + 1;
          if (!down && p < here) target = p + n.nodeSize - 1;
        });
        if (target === null) return false;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, target)).scrollIntoView());
        return true;
      },
    },
    // the cursor stepping into what is hidden steps over it, the way it was going
    appendTransaction(trs, old, state) {
      const f = foldKey.getState(state);
      if (!f || !f.bodies.length || trs.some((t) => t.docChanged) || !trs.some((t) => t.selectionSet)) return null;
      const sel = state.selection;
      if (!sel.empty) return null;
      const $h = sel.$head;
      if ($h.depth < 1 || !inBody(f.bodies, $h.before(1))) return null;
      const fwd = sel.head >= old.selection.head;
      const doc = state.doc;
      let target: number | null = null;
      if (fwd) {
        doc.forEach((n, p) => { if (target === null && p > $h.before(1) && n.isTextblock && !inBody(f.bodies, p)) target = p + 1; });
        if (target === null) return null;
      } else {
        doc.forEach((n, p) => { if (p < $h.before(1) && n.isTextblock && !inBody(f.bodies, p)) target = p + n.nodeSize - 1; });
        if (target === null) return null;
      }
      return state.tr.setSelection(TextSelection.create(doc, target));
    },
  });
}

export const isFolded = (state: EditorState) => !!foldKey.getState(state)?.all;

/** Tags only, on or off — and a cursor inside a card that is folding goes up to its tag. */
export function setFolded(view: EditorView, on: boolean) {
  const st = view.state;
  const tr: Transaction = st.tr.setMeta(foldKey, { all: on }).setMeta("addToHistory", false);
  if (on) {
    const $h = st.selection.$head;
    const here = $h.depth ? $h.before(1) : -1;
    const c = cards(st.doc).find((x) => here >= x.bodyFrom && here < x.bodyTo);
    if (c) tr.setSelection(TextSelection.create(st.doc, c.pos + c.node.nodeSize - 1));
  }
  view.dispatch(tr.scrollIntoView());
}
