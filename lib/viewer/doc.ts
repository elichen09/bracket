/**
 * A document, made readable: safe to show, with an outline, its highlighting
 * found, and searchable.
 *
 * Docs arrive from people who are not you — a partner's send doc, the other
 * team's speech doc off SpeechDrop, a paste — so HTML is cleaned before it
 * is shown: no scripts, no frames, no event handlers, no javascript: links.
 * Once it is on the page, the same walk works for all of it: headings are
 * h1–h6 in HTML, or paragraphs styled Heading 1–6 (Pocket, Hat, Block, Tag in
 * Verbatim) in a .docx; highlighting is any run with a background.
 */

/* ------------------------------------------------------------------ cleaning */

const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "FRAME", "OBJECT", "EMBED", "LINK", "META", "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "BASE", "SVG", "MATH", "TEMPLATE", "NOSCRIPT"]);

export function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (DROP.has(child.tagName)) { child.remove(); continue; }
      for (const a of Array.from(child.attributes)) {
        const n = a.name.toLowerCase(), v = a.value;
        if (n.startsWith("on")) child.removeAttribute(a.name);
        else if ((n === "href" || n === "src" || n === "xlink:href") && !/^(https?:|mailto:|#|data:image\/)/i.test(v.trim())) child.removeAttribute(a.name);
        else if (n === "style" && /url\s*\(|expression\s*\(|behavior\s*:/i.test(v)) child.removeAttribute(a.name);
        else if (n === "id" || n === "class") child.removeAttribute(a.name);
      }
      if (child.tagName === "A") { child.setAttribute("target", "_blank"); child.setAttribute("rel", "noopener noreferrer"); }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/* ------------------------------------------------------------------ reading it */

export interface Head { id: string; level: number; text: string; words: number; hlWords: number }

const VERBATIM: Record<string, number> = { pocket: 1, hat: 2, block: 3, tag: 4 };

/** How deep a heading is, or 0 if the element is not one. */
export function levelOf(el: Element): number {
  const m = /^H([1-6])$/.exec(el.tagName);
  if (m) return Number(m[1]);
  if (el.tagName !== "P") return 0;
  const cls = el.className || "";
  const h = /heading[\s_-]?([1-6])\b/i.exec(cls);
  if (h) return Number(h[1]);
  const v = /\b(?:docx_)?(pocket|hat|block|tag)\b/i.exec(cls);
  if (v) return VERBATIM[v[1].toLowerCase()];
  if (/\btitle\b/i.test(cls)) return 1;
  return 0;
}

const isHighlight = (bg: string) => {
  const c = bg.trim().toLowerCase();
  return !!c && c !== "transparent" && c !== "white" && c !== "#fff" && c !== "#ffffff" && c !== "inherit" && c !== "initial" &&
    !/^rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(,\s*1\s*)?\)$/.test(c) && !/rgba\([^)]*,\s*0\s*\)$/.test(c);
};
const words = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

/**
 * Walk the rendered document once: name every heading, mark highlighting
 * (and the paragraphs that carry it, which are the cards), and count what is
 * under each heading — all of it, and what is highlighted, which is what gets
 * read.
 */
export function readDoc(root: HTMLElement): Head[] {
  const heads: Head[] = [];
  let n = 0;
  root.querySelectorAll("h1, h2, h3, h4, h5, h6, p").forEach((el) => {
    const level = levelOf(el);
    if (!level) return;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    el.id = "dv-h-" + n++;
    el.classList.add("dv-head", "dv-l" + Math.min(level, 4));
    heads.push({ id: el.id, level, text, words: 0, hlWords: 0 });
  });

  root.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    const bg = el.style.backgroundColor || el.style.background;
    if (bg && isHighlight(bg) && el.tagName !== "P" && el.tagName !== "DIV" && el.tagName !== "TABLE" && el.tagName !== "TD") {
      el.classList.add("dv-hl");
      const block = el.closest("p, li, td, div");
      if (block) block.classList.add("dv-card");
    }
  });
  root.querySelectorAll("mark").forEach((m) => { m.classList.add("dv-hl"); m.closest("p, li")?.classList.add("dv-card"); });

  // count, in document order, under whichever heading comes last before the words
  const byId = new Map(heads.map((h) => [h.id, h]));
  let cur: Head | null = null;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = tw.nextNode(); node; node = tw.nextNode()) {
    if (node.nodeType === 1) {
      const el = node as HTMLElement;
      if (el.id && byId.has(el.id)) cur = byId.get(el.id)!;
      continue;
    }
    if (!cur) continue;
    const t = node.nodeValue || "";
    if (!t.trim()) continue;
    const parent = node.parentElement;
    if (parent && parent.closest(".dv-head")) continue;
    const w = words(t);
    cur.words += w;
    if (parent && parent.closest(".dv-hl")) cur.hlWords += w;
  }
  // a heading's count takes in everything under it: find each one's parent,
  // then add every heading's total into its parent's, from the last one back
  const parent: number[] = [];
  const stack: number[] = [];
  heads.forEach((h, i) => {
    while (stack.length && heads[stack[stack.length - 1]].level >= h.level) stack.pop();
    parent[i] = stack.length ? stack[stack.length - 1] : -1;
    stack.push(i);
  });
  for (let i = heads.length - 1; i >= 0; i--) {
    const p = parent[i];
    if (p >= 0) { heads[p].words += heads[i].words; heads[p].hlWords += heads[i].hlWords; }
  }
  return heads;
}

/** How long highlighted words take to read, at a round's pace. */
export const readTime = (w: number, wpm = 200) => {
  if (!w) return "";
  const s = Math.round((w / wpm) * 60);
  return s < 60 ? `0:${String(s).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/* ------------------------------------------------------------------ finding */

/** Take every search mark out, leaving the text as it was. */
export function clearHits(root: HTMLElement) {
  const parents = new Set<Node>();
  root.querySelectorAll("mark.dv-hit").forEach((m) => {
    const p = m.parentNode;
    if (!p) return;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
    parents.add(p);
  });
  parents.forEach((p) => (p as Element).normalize?.());
}

/**
 * Mark every place the words appear. A match can run across the pieces a
 * document breaks its text into (a .docx splits words between runs), so the
 * text is searched joined up and the marks are laid over whichever pieces
 * each match covers.
 */
export function markHits(root: HTMLElement, query: string, max = 2000): HTMLElement[] {
  clearHits(root);
  const q = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (q.length < 2) return [];
  const nodes: { node: Text; start: number }[] = [];
  let all = "";
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest("style, script") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = tw.nextNode() as Text | null; n; n = tw.nextNode() as Text | null) {
    nodes.push({ node: n, start: all.length });
    all += (n.nodeValue || "").replace(/\s/g, " ");
  }
  const hay = all.toLowerCase();
  const found: [number, number][] = [];
  const needle = q;
  for (let at = hay.indexOf(needle); at !== -1 && found.length < max; at = hay.indexOf(needle, at + needle.length)) found.push([at, at + needle.length]);
  // lay marks from the last match back, so earlier offsets stay true
  const marks: HTMLElement[] = [];
  for (let k = found.length - 1; k >= 0; k--) {
    const [s, e] = found[k];
    const pieces: HTMLElement[] = [];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const { node, start } = nodes[i];
      const len = (node.nodeValue || "").length;
      const a = Math.max(s, start), b = Math.min(e, start + len);
      if (a >= b) continue;
      let target = node;
      if (b - start < len) target.splitText(b - start);
      if (a - start > 0) target = target.splitText(a - start);
      const mark = document.createElement("mark");
      mark.className = "dv-hit";
      target.parentNode!.insertBefore(mark, target);
      mark.appendChild(target);
      pieces.unshift(mark);
    }
    if (pieces.length) { pieces.forEach((p) => p.setAttribute("data-k", String(k))); marks.unshift(pieces[0]); }
  }
  return marks;
}
