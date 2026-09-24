import type { Node as PMNode, Mark } from "prosemirror-model";
import { schema, HIGHLIGHTS, labelFor, type Hl, type Who } from "./schema";

/**
 * Getting a flow in and out of Google Docs.
 *
 * In: what Docs puts on the clipboard is a complete description of a flow if
 * it is read the right way. List nesting (or Docs' aria-level) is the depth;
 * red text is theirs; a highlight across nearly all of a line is a line
 * highlight; a Heading 1 is a box. So pasting an existing flow rebuilds it as
 * one — numbered, coloured, answerable — rather than as formatted text.
 *
 * Out: the same thing written back — nested numbered lists at Docs' own list
 * types, red for theirs, and Docs' own highlight colours, so a flow copied
 * out of here pastes into a Doc looking like one written there.
 */

type Run = { t: string; b?: boolean; i?: boolean; u?: boolean; s?: boolean; color?: string | null; bg?: string | null };

const esc = (s: string) => s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m] as string);

function rgb(c: string | null | undefined): [number, number, number] | null {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  if (s === "transparent" || s === "inherit" || s === "initial" || s === "none") return null;
  let m = s.match(/^#([0-9a-f]{6})$/);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = s.match(/^#([0-9a-f]{3})$/);
  if (m) return [0, 1, 2].map((k) => parseInt(m![1][k] + m![1][k], 16)) as [number, number, number];
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(",").map((x) => parseFloat(x));
    if (p.length > 3 && p[3] === 0) return null;
    return [p[0], p[1], p[2]];
  }
  if (s === "red") return [255, 0, 0];
  if (s === "yellow") return [255, 255, 0];
  return null;
}
const isRed = (c: string | null | undefined) => { const v = rgb(c); return !!v && v[0] > 170 && v[1] < 110 && v[2] < 110; };
/** Which of the four highlights a background colour is nearest, if any. */
function hlOf(c: string | null | undefined): Hl | null {
  const v = rgb(c);
  if (!v) return null;
  const [r, g, b] = v;
  if (r > 235 && g > 235 && b > 235) return null;                 // white, or near it
  if (r > 190 && g > 190 && b < 170) return "yellow";
  if (g > 170 && r < 170 && b < 170) return "green";
  if (g > 170 && b > 170 && r < 170) return "cyan";
  if (r > 190 && b > 150 && g < 170) return "pink";
  return null;
}

/** The runs of text under an element, with the styles each one inherits. */
function runsOf(el: Node, inh: Run, out: Run[]) {
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3) {
      const t = (n.textContent || "").replace(/ /g, " ");
      if (t) out.push({ ...inh, t });
      return;
    }
    if (n.nodeType !== 1) return;
    const e = n as HTMLElement;
    const tag = e.tagName;
    if (tag === "OL" || tag === "UL") return;                    // a nested list is its own lines
    if (tag === "BR") { out.push({ ...inh, t: " " }); return; }
    const st = e.style;
    const next: Run = { ...inh };
    if (tag === "B" || tag === "STRONG") next.b = st.fontWeight !== "normal";
    if (tag === "I" || tag === "EM") next.i = true;
    if (tag === "U") next.u = true;
    if (tag === "S" || tag === "DEL" || tag === "STRIKE") next.s = true;
    if (st.fontWeight) next.b = st.fontWeight === "bold" || Number(st.fontWeight) >= 600;
    if (st.fontStyle) next.i = st.fontStyle === "italic";
    const deco = `${st.textDecoration || ""} ${st.textDecorationLine || ""}`;
    if (deco.includes("underline")) next.u = true;
    if (deco.includes("line-through")) next.s = true;
    if (st.color) next.color = st.color;
    if (st.backgroundColor) next.bg = st.backgroundColor;
    if (tag === "MARK") next.bg = next.bg || "#ffff00";
    runsOf(e, next, out);
  });
}

/** The larger part of a line's text, by some test — who said it, what it is highlighted. */
function share(runs: Run[], test: (r: Run) => boolean) {
  const all = runs.reduce((n, r) => n + r.t.trim().length, 0) || 1;
  return runs.filter(test).reduce((n, r) => n + r.t.trim().length, 0) / all;
}

function inlineHtml(runs: Run[], lineWho: Who | null, lineHl: Hl | null) {
  return runs.map((r) => {
    let h = esc(r.t);
    const hl = hlOf(r.bg);
    if (hl && hl !== lineHl) h = `<mark data-hl="${hl}">${h}</mark>`;
    // red that is not already the line's colour stays red as a mark
    if (isRed(r.color) && lineWho !== "them") h = `<span class="df-red">${h}</span>`;
    if (r.s) h = `<s>${h}</s>`;
    if (r.u) h = `<u>${h}</u>`;
    if (r.i) h = `<em>${h}</em>`;
    if (r.b) h = `<strong>${h}</strong>`;
    return h;
  }).join("");
}

/**
 * Docs clipboard HTML → this editor's HTML, which its parser reads directly.
 * Anything that is not recognisably a document is handed back untouched.
 */
export function fromDocsHtml(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const dom = new DOMParser().parseFromString(html, "text/html");
  const body = dom.body;
  if (!body || !body.querySelector("li,p,h1,h2,h3,h4,h5,h6")) return html;
  const out: string[] = [];

  const item = (li: HTMLElement, depth: number) => {
    const runs: Run[] = [];
    runsOf(li, { t: "", color: li.style.color || null, bg: li.style.backgroundColor || null }, runs);
    if (!runs.some((r) => r.t.trim())) return;
    const who: Who = share(runs, (r) => isRed(r.color)) > 0.5 ? "them" : "us";
    let hl: Hl | null = null;
    for (const k of Object.keys(HIGHLIGHTS) as Hl[]) if (share(runs, (r) => hlOf(r.bg) === k) >= 0.7) hl = k;
    out.push(`<div class="df-item" data-depth="${Math.min(8, depth)}" data-who="${who}"${hl ? ` data-hl="${hl}"` : ""}><span class="df-t">${inlineHtml(runs, who, hl)}</span></div>`);
  };
  const heading = (el: HTMLElement, level: number) => {
    const runs: Run[] = [];
    runsOf(el, { t: "", color: el.style.color || null }, runs);
    if (!runs.some((r) => r.t.trim())) return;
    const who: Who = share(runs, (r) => isRed(r.color)) > 0.5 ? "them" : "us";
    const boxed = level === 1 || /border/.test(el.getAttribute("style") || "");
    out.push(boxed
      ? `<div class="df-box" data-who="${who}">${inlineHtml(runs, who, null)}</div>`
      : `<h3 class="df-head" data-who="${who}">${inlineHtml(runs, who, null)}</h3>`);
  };
  const para = (el: HTMLElement) => {
    const runs: Run[] = [];
    runsOf(el, { t: "" }, runs);
    if (!runs.some((r) => r.t.trim())) return;
    if (/border/.test(el.getAttribute("style") || "")) { heading(el, 1); return; }
    out.push(`<p>${inlineHtml(runs, null, null)}</p>`);
  };

  const walk = (el: Element, listDepth: number) => {
    Array.from(el.children).forEach((c) => {
      const e = c as HTMLElement;
      const tag = e.tagName;
      if (tag === "OL" || tag === "UL") { walk(e, listDepth + 1); return; }
      if (tag === "LI") {
        const aria = Number(e.getAttribute("aria-level"));
        item(e, aria ? aria - 1 : Math.max(0, listDepth - 1));
        Array.from(e.children).forEach((k) => { if (k.tagName === "OL" || k.tagName === "UL") walk(k, listDepth + 1); });
        return;
      }
      const h = tag.match(/^H([1-6])$/);
      if (h) { heading(e, Number(h[1])); return; }
      if (tag === "P") { para(e); return; }
      if (tag === "BR" || tag === "META" || tag === "STYLE") return;
      if (e.querySelector("li,p,h1,h2,h3,h4,h5,h6,div")) walk(e, listDepth); else para(e);
    });
  };
  walk(body, 0);
  return out.length ? out.join("") : html;
}

/* ------------------------------------------------------------------ out */

const LIST_TYPES = ["decimal", "lower-alpha", "lower-roman"];
const RED = "#ff0000";

function inlineOut(node: PMNode, lineWho: Who | null): string {
  let h = "";
  node.forEach((t) => {
    let s = esc(t.text || "");
    const style: string[] = [];
    t.marks.forEach((m: Mark) => {
      if (m.type === schema.marks.strong) style.push("font-weight:700");
      if (m.type === schema.marks.em) style.push("font-style:italic");
      if (m.type === schema.marks.underline) style.push("text-decoration:underline");
      if (m.type === schema.marks.strike) style.push("text-decoration:line-through");
      if (m.type === schema.marks.mark) style.push(`background-color:${HIGHLIGHTS[m.attrs.hl as Hl]?.docs || "#ffff00"}`);
      if (m.type === schema.marks.red && lineWho !== "them") style.push(`color:${RED}`);
    });
    if (style.length) s = `<span style="${style.join(";")}">${s}</span>`;
    h += s;
  });
  return h;
}

/** The flow as HTML Docs will paste as a flow. */
export function toDocsHtml(doc: PMNode): string {
  let html = "";
  let level = -1;
  const close = () => {
    if (level < 0) return;
    html += "</li>";
    while (level > 0) { html += "</ol></li>"; level--; }
    html += "</ol>";
    level = -1;
  };
  doc.forEach((n) => {
    if (n.type !== schema.nodes.item) {
      close();
      const color = n.attrs && n.attrs.who === "them" ? `color:${RED};` : "";
      if (n.type === schema.nodes.box) {
        html += `<h1 style="text-align:center;border:4px solid #000000;padding:4pt 8pt;font-size:24pt;font-weight:700;${color}">${inlineOut(n, n.attrs.who)}</h1>`;
      } else if (n.type === schema.nodes.head) {
        html += `<h3 style="text-align:center;font-size:14pt;font-weight:700;text-decoration:underline;${color}">${inlineOut(n, n.attrs.who)}</h3>`;
      } else {
        html += `<p>${inlineOut(n, null)}</p>`;
      }
      return;
    }
    const d = n.attrs.depth as number;
    if (level < 0 || d > level) {
      // Deeper: open a list inside the item that is still open, and a blank
      // unnumbered item for any level skipped on the way down.
      while (level < d) {
        level++;
        html += `<ol style="list-style-type:${LIST_TYPES[level % 3]};margin:0">`;
        if (level < d) html += `<li style="list-style-type:none">`;
      }
    } else {
      html += "</li>";
      while (level > d) { html += "</ol></li>"; level--; }
    }
    const color = n.attrs.who === "them" ? `color:${RED};` : "";
    const bg = n.attrs.hl ? `background-color:${HIGHLIGHTS[n.attrs.hl as Hl].docs};` : "";
    html += `<li style="${color}"><span style="${color}${bg}">${inlineOut(n, n.attrs.who)}</span>`;
  });
  close();
  return `<meta charset="utf-8">${html}`;
}

/** The flow as plain text, numbered and indented, for anywhere that takes no formatting. */
export function toPlainText(doc: PMNode): string {
  const lines: string[] = [];
  const counters: number[] = [];
  doc.forEach((n) => {
    if (n.type !== schema.nodes.item) {
      counters.length = 0;
      const t = n.textContent.trim();
      if (n.type === schema.nodes.box) lines.push("", `[ ${t} ]`, "");
      else if (n.type === schema.nodes.head) lines.push("", `— ${t} —`);
      else if (t) lines.push(t);
      return;
    }
    const d = n.attrs.depth as number;
    counters.length = d + 1;
    counters[d] = (counters[d] || 0) + 1;
    lines.push(`${"    ".repeat(d)}${labelFor(counters[d], d)} ${n.textContent}`);
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
