import { scoped } from "../owner";

/**
 * Your rhetoric: the things you say every round and would rather not type
 * again mid-speech — a weighing mechanism, the framing, a frontline to a
 * turn you always hear. Each piece is a title and its lines, as text: one
 * line per flow line, and a tab or two spaces in front of a line puts it
 * under the one above. Pieces can sit in a group, the way blocks sit under
 * a hat in a cut file.
 *
 * Kept in this browser, apart per account, and shared by every flow the
 * account keeps.
 */

export interface Piece { id: string; title: string; text: string; updated: number; group?: string }
export interface Draft { title: string; text: string; group?: string }

const key = (owner?: string | null) => scoped("docflow.rhetoric", owner);

export function loadPieces(owner?: string | null): Piece[] {
  try {
    const list = JSON.parse(localStorage.getItem(key(owner)) || "[]");
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function savePieces(owner: string | null | undefined, list: Piece[]) {
  try { localStorage.setItem(key(owner), JSON.stringify(list)); } catch { /* private browsing */ }
}

export const newPieceId = () => "r" + Math.random().toString(36).slice(2, 10);

/** A title for lines that arrived without one: the first line, cut short. */
export const titleFrom = (text: string) => {
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) || "Untitled";
  return first.length > 48 ? first.slice(0, 46).trimEnd() + "…" : first;
};

/* ------------------------------------------------------------------
   A rhetoric file, pasted out of Google Docs.

   Read the way Evidence reads a cut file: the headings are the structure.
   In Verbatim's terms — pocket h1, hat h2, block h3, tag h4 — a block is a
   piece and the heading above it is its group; a tag under a block is a line
   of that piece, and what is written under the tag goes under that line.
   A file with fewer levels works the same way from its deepest heading: each
   heading with writing under it is a piece.

   Lists keep their nesting, and a paragraph indented in Docs is a level in
   per half inch. A file with no headings at all is split on bold lines, and
   plain text on blank lines.
   ------------------------------------------------------------------ */

type Entry = { h: number; text: string } | { d: number; text: string };

const clean = (s: string) => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();

function indentOf(el: HTMLElement) {
  const m = String(el.style?.marginLeft || "").match(/([\d.]+)\s*(pt|px)/);
  if (!m) return 0;
  const pt = m[2] === "px" ? parseFloat(m[1]) * 0.75 : parseFloat(m[1]);
  return Math.max(0, Math.round(pt / 36));
}

/** Every piece of text in it is bold — a title set by hand rather than with a heading style. */
function allBold(el: HTMLElement) {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let any = false;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.nodeValue || !t.nodeValue.trim()) continue;
    any = true;
    let bold = false;
    for (let p = t.parentElement; p && p !== el.parentElement; p = p.parentElement) {
      const w = p.style?.fontWeight;
      if (w) { bold = w === "bold" || parseInt(w, 10) >= 600; break; }
      if (p.tagName === "B" || p.tagName === "STRONG") { bold = true; break; }
    }
    if (!bold) return false;
  }
  return any;
}

function entriesOf(html: string): { entries: Entry[]; bold: Set<number> } {
  const dom = new DOMParser().parseFromString(html, "text/html");
  const entries: Entry[] = [];
  const bold = new Set<number>();
  const listText = (li: HTMLElement) => {
    const c = li.cloneNode(true) as HTMLElement;
    c.querySelectorAll("ul,ol").forEach((x) => x.remove());
    return clean(c.textContent || "");
  };
  const walk = (node: Element, listDepth: number | null) => {
    for (const child of Array.from(node.children) as HTMLElement[]) {
      const tag = child.tagName;
      if (/^H[1-6]$/.test(tag)) { const t = clean(child.textContent || ""); if (t) entries.push({ h: Number(tag[1]), text: t }); continue; }
      if (tag === "UL" || tag === "OL") { walk(child, listDepth === null ? 0 : listDepth + 1); continue; }
      if (tag === "LI") {
        const aria = Number(child.getAttribute("aria-level"));
        const t = listText(child);
        if (t) entries.push({ d: aria ? aria - 1 : listDepth ?? 0, text: t });
        Array.from(child.children).forEach((c) => { if (c.tagName === "UL" || c.tagName === "OL") walk(c, listDepth === null ? 1 : listDepth + 1); });
        continue;
      }
      if (tag === "P") {
        const t = clean(child.textContent || "");
        if (!t) continue;
        if (t.length < 90 && allBold(child)) bold.add(entries.length);
        entries.push({ d: indentOf(child), text: t });
        continue;
      }
      if (tag === "STYLE" || tag === "SCRIPT" || tag === "META") continue;
      if (child.querySelector("p,h1,h2,h3,h4,h5,h6,li,div,table,tr")) walk(child, listDepth);
      else { const t = clean(child.textContent || ""); if (t) entries.push({ d: 0, text: t }); }
    }
  };
  walk(dom.body, null);
  return { entries, bold };
}

function build(entries: Entry[]): Draft[] {
  const levels = Array.from(new Set(entries.filter((e): e is { h: number; text: string } => "h" in e).map((e) => e.h))).sort();
  const block = levels.includes(3) && levels.includes(4) ? 3 : levels[levels.length - 1];
  const out: Draft[] = [];
  const groups = new Map<number, string>();
  let cur: { title: string; group?: string; lines: { d: number; text: string }[] } | null = null;
  let base = 0;
  const groupNow = () => { const ks = Array.from(groups.keys()).filter((k) => k < block).sort(); return ks.length ? groups.get(ks[ks.length - 1]) : undefined; };
  const flush = () => {
    if (cur && cur.lines.length) {
      const min = Math.min(...cur.lines.map((l) => l.d));
      let prev = -1;
      const text = cur.lines.map((l) => { const d = Math.min(l.d - min, prev + 1); prev = d; return "  ".repeat(d) + l.text; }).join("\n");
      out.push({ title: cur.title, text, ...(cur.group ? { group: cur.group } : {}) });
    }
    cur = null;
  };
  let lastHeading: string | null = null;
  for (const e of entries) {
    if ("h" in e) {
      if (e.h < block) {
        flush();
        Array.from(groups.keys()).forEach((k) => { if (k >= e.h) groups.delete(k); });
        groups.set(e.h, e.text);
        lastHeading = e.text;
      } else if (e.h === block) {
        flush();
        cur = { title: e.text, group: groupNow(), lines: [] };
        base = 0;
      } else {
        if (!cur) cur = { title: e.text, group: groupNow(), lines: [] };
        else cur.lines.push({ d: 0, text: e.text });
        base = cur.lines.length ? 1 : 0;
      }
      continue;
    }
    // writing with no block above it belongs to the heading it follows, or starts its own piece
    if (!cur) { cur = { title: lastHeading && !out.some((d) => d.title === lastHeading) ? lastHeading : titleFrom(e.text), lines: [] }; base = 0; }
    cur.lines.push({ d: base + e.d, text: e.text });
  }
  flush();
  return out;
}

/** Pieces out of whatever was pasted: a Google Doc, or plain text. */
export function fromDoc(html: string, plain: string): Draft[] {
  if (html && /<(h[1-6]|p|li|div|b|span)\b/i.test(html)) {
    const { entries, bold } = entriesOf(html);
    if (entries.some((e) => "h" in e)) return build(entries);
    // no heading styles: bold lines are the titles
    if (bold.size) return build(entries.map((e, i) => (bold.has(i) ? { h: 3, text: e.text } : e)));
    if (entries.length) plain = entries.map((e) => "  ".repeat("d" in e ? e.d : 0) + e.text).join("\n") + "\n";
  }
  // plain text: a blank line between pieces, the first line of each its title
  return plain.replace(/\r/g, "").split(/\n\s*\n/).map((chunk) => chunk.replace(/^\n+|\s+$/g, "")).filter((c) => c.trim()).map((chunk) => {
    const lines = chunk.split("\n");
    if (lines.length === 1) return { title: titleFrom(chunk), text: chunk.trim() };
    return { title: clean(lines[0]).slice(0, 60), text: lines.slice(1).join("\n") };
  });
}

/** Add pasted pieces to what is kept: one with the same title in the same group is replaced. */
export function merge(list: Piece[], drafts: Draft[]): { list: Piece[]; added: number; updated: number } {
  const now = Date.now();
  const k = (g: string | undefined, t: string) => (g || "").toLowerCase() + "\u0000" + t.toLowerCase();
  const at = new Map(list.map((p, i) => [k(p.group, p.title), i]));
  const next = list.slice();
  let added = 0, updated = 0;
  for (const d of drafts) {
    const i = at.get(k(d.group, d.title));
    if (i !== undefined) { next[i] = { ...next[i], text: d.text, updated: now }; updated++; }
    else { at.set(k(d.group, d.title), next.length); next.push({ id: newPieceId(), title: d.title, text: d.text, updated: now, ...(d.group ? { group: d.group } : {}) }); added++; }
  }
  return { list: next, added, updated };
}
