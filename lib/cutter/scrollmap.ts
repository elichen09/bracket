import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../evidence/docSchema";

/**
 * The scroll map: a narrow strip down the right of a page with the whole file
 * on it, so a 60-page file has a shape.
 *
 * - a dark tick for each pocket, hat and block (longer the bigger it is), a
 *   faint one for each card;
 * - the read text as a band in its own highlight colour, where it is;
 * - the card the cursor is in, in the accent;
 * - a box for what is on the screen now.
 *
 * Click or drag on it to go there; point at it to see which heading is there.
 * The strip is drawn on a canvas and measured again only when the file
 * changes (a beat after typing stops), so it costs nothing while you type.
 * It shows only when there is something to scroll.
 */

const W = 12;

interface Mark { y: number; h: number; kind: "head" | "card" | "hl"; level: number; text: string; color: string; pos: number; end: number }

export function scrollMapPlugin(): Plugin {
  return new Plugin({ view: (v) => new ScrollMap(v) });
}

/** The first highlight colour in a paragraph, or "" when nothing in it is read. */
function hlOf(n: PMNode): string {
  let c = "";
  n.descendants((t) => {
    if (c || !t.isText) return !c;
    const m = t.marks.find((x) => x.type === schema.marks.highlight);
    if (m) c = (m.attrs.color as string) || "#00ff00";
    return false;
  });
  return c;
}

class ScrollMap {
  private el: HTMLDivElement | null = null;
  private cv: HTMLCanvasElement | null = null;
  private port: HTMLDivElement | null = null;
  private tip: HTMLDivElement | null = null;
  private sc: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private marks: Mark[] = [];
  private ro: ResizeObserver | null = null;
  private t: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private tries = 0;
  private dead = false;
  private cur: [number, number] | null = null;

  constructor(private view: EditorView) {
    requestAnimationFrame(() => this.attach());
  }

  private attach() {
    if (this.dead) return;
    const sc = this.view.dom.closest(".rm-scroll, #docbody") as HTMLElement | null;
    const host = sc?.parentElement;
    if (!sc || !host) { if (this.tries++ < 20) setTimeout(() => this.attach(), 250); return; }
    this.sc = sc; this.host = host;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const el = document.createElement("div");
    el.className = "rm-map";
    el.setAttribute("aria-hidden", "true");
    const cv = document.createElement("canvas");
    const port = document.createElement("div"); port.className = "rm-map-port";
    const tip = document.createElement("div"); tip.className = "rm-map-tip";
    el.append(cv, port, tip);
    host.appendChild(el);
    this.el = el; this.cv = cv; this.port = port; this.tip = tip;
    sc.addEventListener("scroll", this.onScroll, { passive: true });
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("mousemove", this.onHover);
    el.addEventListener("mouseleave", this.onLeave);
    this.ro = new ResizeObserver(() => this.later(60));
    this.ro.observe(sc);
    this.ro.observe(this.view.dom);
    this.later(0);
  }

  update(view: EditorView, prev: { doc: PMNode; selection: unknown }) {
    this.view = view;
    if (prev.doc !== view.state.doc) this.later(300);
    else if (prev.selection !== view.state.selection) this.paint();
  }

  /** Measure again, a beat from now (each call puts it off). */
  private later(ms: number) {
    if (this.t) clearTimeout(this.t);
    this.t = setTimeout(() => { this.t = null; this.measure(); }, ms);
  }

  private measure() {
    const sc = this.sc, el = this.el;
    if (this.dead || !sc || !el || !this.host) return;
    const top = sc.getBoundingClientRect().top - sc.scrollTop;
    const marks: Mark[] = [];
    this.view.state.doc.forEach((n, pos) => {
      const dom = this.view.nodeDOM(pos) as HTMLElement | null;
      if (!dom || !dom.getBoundingClientRect) return;
      const r = dom.getBoundingClientRect();
      if (!r.height) return;                        // folded away
      const y = r.top - top, end = pos + n.nodeSize;
      if (n.type === schema.nodes.heading) {
        const text = n.textContent.trim();
        if (!text) return;
        marks.push({ y, h: r.height, kind: n.attrs.level === 4 ? "card" : "head", level: n.attrs.level, text, color: "", pos, end });
      } else if (n.type === schema.nodes.paragraph) {
        const c = hlOf(n);
        if (c) marks.push({ y, h: r.height, kind: "hl", level: 9, text: "", color: c, pos, end });
      }
    });
    this.marks = marks;
    // where it sits: down the page's right edge, inside its scroll bar
    const hr = this.host.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    const bar = sc.offsetWidth - sc.clientWidth;
    el.style.top = sr.top - hr.top + "px";
    el.style.right = hr.right - sr.right + bar + 2 + "px";
    el.style.height = sc.clientHeight + "px";
    el.hidden = sc.scrollHeight <= sc.clientHeight * 1.15;
    this.paint();
  }

  private scale() { return this.sc ? this.sc.clientHeight / Math.max(1, this.sc.scrollHeight) : 1; }

  /** Draw it from what was measured: cheap, so the cursor moving draws it again. */
  private paint() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const cv = this.cv, sc = this.sc, el = this.el;
      if (!cv || !sc || !el || el.hidden) return;
      const H = sc.clientHeight, dpr = window.devicePixelRatio || 1;
      if (cv.width !== W * dpr || cv.height !== Math.round(H * dpr)) { cv.width = W * dpr; cv.height = Math.round(H * dpr); cv.style.height = H + "px"; }
      const g = cv.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const k = this.scale();
      const css = getComputedStyle(el);
      const ink = css.getPropertyValue("--map-ink").trim() || "#1a1a1a";
      const faint = css.getPropertyValue("--map-faint").trim() || "#b4b4b4";
      const acc = css.getPropertyValue("--map-acc").trim() || "#1F5E8C";
      // the card the cursor is in: from its tag to the next heading
      const at = this.view.state.selection.from;
      this.cur = null;
      for (let i = 0; i < this.marks.length; i++) {
        const m = this.marks[i];
        if (m.kind !== "card" || m.pos > at) continue;
        let j = i + 1;
        while (j < this.marks.length && this.marks[j].kind === "hl") j++;
        const nextPos = j < this.marks.length ? this.marks[j].pos : this.view.state.doc.content.size;
        if (at < nextPos) this.cur = [m.y, (j < this.marks.length ? this.marks[j].y : sc.scrollHeight) - m.y];
      }
      if (this.cur) { g.globalAlpha = .18; g.fillStyle = acc; g.fillRect(0, this.cur[0] * k, W, Math.max(2, this.cur[1] * k)); g.globalAlpha = 1; }
      g.globalAlpha = .75;
      for (const m of this.marks) if (m.kind === "hl") { g.fillStyle = m.color; g.fillRect(4, m.y * k, W - 6, Math.max(1, m.h * k)); }
      g.globalAlpha = 1;
      for (const m of this.marks) {
        if (m.kind === "card") { g.fillStyle = faint; g.fillRect(2, Math.round(m.y * k), W - 4, 1); }
        else if (m.kind === "head") { g.fillStyle = ink; const t = m.level <= 2 ? 3 : 2; g.fillRect(m.level <= 2 ? 0 : 1, Math.round(m.y * k), m.level <= 2 ? W : W - 2, t); }
      }
      if (this.cur) { g.fillStyle = acc; g.fillRect(0, Math.round(this.cur[0] * k), 3, Math.max(3, this.cur[1] * k)); }
      this.onScroll();
    });
  }

  private onScroll = () => {
    const sc = this.sc, port = this.port;
    if (!sc || !port) return;
    const k = this.scale();
    port.style.top = sc.scrollTop * k + "px";
    port.style.height = Math.max(8, sc.clientHeight * k) + "px";
  };

  /** Click or drag: that place in the middle of the page. */
  private onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !this.el || !this.sc) return;
    e.preventDefault();
    const el = this.el, sc = this.sc;
    el.setPointerCapture(e.pointerId);
    el.classList.add("held");
    const go = (ev: PointerEvent) => {
      const y = ev.clientY - el.getBoundingClientRect().top;
      sc.scrollTop = y / this.scale() - sc.clientHeight / 2;
    };
    go(e);
    const up = () => { el.classList.remove("held"); el.removeEventListener("pointermove", go); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", go);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  /** Pointing: the heading there, by name. */
  private onHover = (e: MouseEvent) => {
    const el = this.el, tip = this.tip;
    if (!el || !tip) return;
    const y = e.clientY - el.getBoundingClientRect().top, k = this.scale();
    let best: Mark | null = null;
    for (const m of this.marks) {
      if (m.kind === "hl") continue;
      if (m.y * k <= y + 3) best = m; else break;
    }
    if (!best) { tip.classList.remove("on"); return; }
    tip.textContent = best.text;
    tip.dataset.level = String(best.level);
    tip.style.top = Math.min(el.clientHeight - 24, Math.max(0, y - 11)) + "px";
    tip.classList.add("on");
  };
  private onLeave = () => { this.tip?.classList.remove("on"); };

  destroy() {
    this.dead = true;
    if (this.t) clearTimeout(this.t);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.sc?.removeEventListener("scroll", this.onScroll);
    this.el?.remove();
  }
}
