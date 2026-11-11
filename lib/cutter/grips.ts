import { Plugin, PluginKey, TextSelection, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { schema } from "../evidence/docSchema";
import { sections, moveSection } from "./commands";

/**
 * A handle beside every heading, to drag the card (or block, or hat) and
 * everything under it somewhere else in the document.
 *
 * Point at a tag and a ⋮⋮ shows in the margin beside it. Drag it: the card
 * lifts, a line shows where it will go — between cards for a card, between
 * blocks for a block — and letting go puts it there; Esc puts it back. Near
 * the top or bottom of the page it scrolls. A click on the handle without a
 * drag selects the whole card, ready for Delete or Ctrl+X.
 *
 * The outline in the side moves cards too, and Alt+↑ / Alt+↓ one place at a
 * time; this is the same move (commands.ts, moveSection), done where the
 * card is.
 */

interface Grips { set: DecorationSet; lift: { from: number; to: number } | null }
const gripKey = new PluginKey<Grips>("grips");

function grips(state: EditorState, lift: Grips["lift"]): DecorationSet {
  const decos: Decoration[] = [];
  // the section being dragged, faded where it was (a class put on by hand would be taken off again by the editor)
  if (lift) state.doc.forEach((n, pos) => { if (pos >= lift.from && pos < lift.to) decos.push(Decoration.node(pos, pos + n.nodeSize, { class: "rm-lifted" })); });
  state.doc.forEach((n, pos) => {
    if (n.type !== schema.nodes.heading || !n.textContent.trim()) return;
    decos.push(Decoration.widget(pos + 1, (view, getPos) => handle(view, getPos), {
      side: -1, key: "grip:" + pos + ":" + n.attrs.level, ignoreSelection: true, stopEvent: () => true,
    }));
  });
  return DecorationSet.create(state.doc, decos);
}

function handle(view: EditorView, getPos: () => number | undefined) {
  const el = document.createElement("span");
  el.className = "rm-grip";
  el.contentEditable = "false";
  el.setAttribute("draggable", "false");
  el.title = "Drag to move it, and everything under it · click to select it";
  el.textContent = "⋮⋮";
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !view.editable) return;
    const at = getPos();
    if (typeof at !== "number") return;
    e.preventDefault();
    e.stopPropagation();
    drag(view, at - 1, e);
  });
  return el;
}

/** Drag the section whose heading starts at `start`. */
function drag(view: EditorView, start: number, down: PointerEvent) {
  const doc = view.state.doc;
  const sec = sections(doc).find((s) => s.pos === start);
  if (!sec) return;
  // where it may go: before a heading as big as it or bigger, or at the very end — not inside itself
  const spots: number[] = [];
  doc.forEach((n, p) => { if (n.type === schema.nodes.heading && n.attrs.level <= sec.level && (p < sec.pos || p > sec.end)) spots.push(p); });
  if (sec.end < doc.content.size) spots.push(doc.content.size);
  const lift = (on: boolean) => view.dispatch(view.state.tr.setMeta(gripKey, on ? { from: sec.pos, to: sec.end } : null).setMeta("addToHistory", false));
  const scroller = view.dom.closest(".rm-scroll") as HTMLElement | null;
  const bar = document.createElement("div");
  bar.className = "rm-dropbar";
  // in the tool's own colour (the bar sits on the page's body, outside the tool's tokens)
  const rm = view.dom.closest(".rm");
  const acc = rm ? getComputedStyle(rm).getPropertyValue("--acc").trim() : "";
  if (acc) bar.style.setProperty("--rm-a", acc);
  document.body.appendChild(bar);
  document.body.classList.add("rm-dragging");
  let target: number | null = null, moved = false, lastY = down.clientY, raf = 0, done = false;

  const yOf = (p: number) => {
    if (p >= view.state.doc.content.size) {
      const last = view.dom.lastElementChild as HTMLElement | null;
      return last ? last.getBoundingClientRect().bottom + 4 : view.dom.getBoundingClientRect().bottom;
    }
    const d = view.nodeDOM(p) as HTMLElement | null;
    return d && d.getBoundingClientRect ? d.getBoundingClientRect().top - 6 : 0;
  };
  const place = () => {
    let best: number | null = null, bestD = Infinity;
    for (const p of spots) { const d = Math.abs(yOf(p) - lastY); if (d < bestD) { bestD = d; best = p; } }
    target = best;
    if (target === null) { bar.style.display = "none"; return; }
    const r = view.dom.getBoundingClientRect();
    bar.style.display = "block";
    bar.style.left = r.left + "px";
    bar.style.width = r.width + "px";
    bar.style.top = yOf(target) + "px";
  };
  const tick = () => {
    raf = 0;
    if (done || !scroller) return;
    const r = scroller.getBoundingClientRect();
    const edge = 56;
    const dy = lastY < r.top + edge ? -Math.ceil((r.top + edge - lastY) / 4) : lastY > r.bottom - edge ? Math.ceil((lastY - (r.bottom - edge)) / 4) : 0;
    if (dy) { scroller.scrollTop += dy; place(); raf = requestAnimationFrame(tick); }
  };
  const move = (e: PointerEvent) => {
    lastY = e.clientY;
    if (!moved && Math.abs(e.clientY - down.clientY) + Math.abs(e.clientX - down.clientX) < 5) return;
    if (!moved) lift(true);
    moved = true;
    place();
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const finish = (go: boolean) => {
    if (done) return;
    done = true;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("keydown", key, true);
    if (raf) cancelAnimationFrame(raf);
    bar.remove();
    document.body.classList.remove("rm-dragging");
    if (moved) lift(false);
    if (!moved) {
      // a click: the whole thing selected
      const st = view.state;
      const s = sections(st.doc).find((x) => x.pos === start);
      if (!s) return;
      const last = st.doc.resolve(s.end).nodeBefore;
      const to = last && last.isTextblock ? s.end - 1 : s.end;
      try { view.dispatch(st.tr.setSelection(TextSelection.create(st.doc, s.pos + 1, Math.max(s.pos + 1, to)))); } catch { /* a heading alone */ }
      view.focus();
      return;
    }
    if (!go || target === null) return;
    const tr = moveSection(view.state, start, target);
    if (tr) { view.dispatch(tr); view.focus(); }
  };
  const up = () => finish(true);
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); } };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("keydown", key, true);
}

export function gripPlugin() {
  return new Plugin<Grips>({
    key: gripKey,
    state: {
      init: (_, state) => ({ set: grips(state, null), lift: null }),
      apply(tr, prev, _old, state) {
        const m = tr.getMeta(gripKey);
        if (m === undefined && !tr.docChanged) return prev;
        const lift = m === undefined ? prev.lift : m;
        return { set: grips(state, lift), lift };
      },
    },
    props: { decorations: (state) => gripKey.getState(state)?.set },
  });
}
