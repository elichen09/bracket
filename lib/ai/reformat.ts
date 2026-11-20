/**
 * Reformat with AI: a card cut anywhere, in coda's house format — after the
 * card formatter in "Gary's Brain" (claude.ai/artifact/GgJ1UwLTSqD3zRUSfp4LLP).
 *
 * Not a word of the card changes and no highlight is lost. Claude only
 * decides formatting, and everything it says is checked against the card:
 *
 *   - the cite: its raw text split into parts (inventing none), written in
 *     the cite format set under Keys (lib/cutter/cites.ts writeCite);
 *   - "underline": the few words around each highlighted part it needs to
 *     read as a thought, and a handful of unhighlighted clauses that carry a
 *     warrant — every phrase found in the card word for word, or dropped;
 *     never more than ~38% of the card;
 *   - "bold": the words that matter most, inside the underlining — coda's
 *     emphasis (bold, underlined, boxed);
 *   - optionally, highlighting tightened for efficiency, sentence by
 *     sentence: kept only when it reads the same sentence's words in order,
 *     adds at most two, and is shorter without being gutted.
 *
 * Then, without Claude: whatever isn't underlined goes to 8pt; a long unread
 * stretch (35+ words) before the first or after the last highlighted
 * sentence is cut; two or more unread paragraphs in the middle are condensed between
 * <<TEXT CONDENSED - NONE OMITTED>> and <<PARAGRAPH BREAKS RESUME>>.
 *
 * A card edited while Claude worked on it is left alone.
 */
import { z } from "zod";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "@/lib/evidence/docSchema";
import { cardAround, condenseOmitted, SMALL } from "@/lib/cutter/commands";
import { writeCite, type CiteParts } from "@/lib/cutter/cites";
import { askJson, AiError } from "./claude";

const M = schema.marks;

export interface ReformatOptions {
  /** tighten highlighting for efficiency, keeping every warrant */
  trim: boolean;
  /** cut a long unread stretch at the top or bottom of the card */
  cutEnds: boolean;
  /** condense unread paragraphs in the middle */
  condense: boolean;
  citeFormat: string;
}

export interface ReformatReport {
  cards: number;
  done: number;
  skipped: string[];
  failed: string[];
  cites: number;
  cutWords: number;
  tightened: number;
  underlined: number;          // average % of the card underlined
}

/* ------------------------------------------------------------------ the card, as text */

/** A card's body as text: s, its highlight colour per character, and each character's place in the document (-1 at a paragraph break). */
export interface Body { s: string; hl: (string | null)[]; at: number[] }

export function readBody(doc: PMNode, from: number, to: number): Body {
  let s = "";
  const hl: (string | null)[] = [], at: number[] = [];
  let firstPara = true;
  doc.nodesBetween(from, to, (n, pos) => {
    if (!n.isTextblock) return true;
    if (!firstPara) { s += "\n"; hl.push(null); at.push(-1); }
    firstPara = false;
    n.forEach((child, off) => {
      const start = pos + 1 + off;
      if (child.isText) {
        const t = child.text || "";
        const h = child.marks.find((m) => m.type === M.highlight);
        for (let k = 0; k < t.length; k++) { s += t[k]; hl.push(h ? String(h.attrs.color) : null); at.push(start + k); }
      } else { s += " "; hl.push(null); at.push(-1); }
    });
    return false;
  });
  return { s, hl, at };
}

const slice = (b: Body, x: number, z: number): Body => ({ s: b.s.slice(x, z), hl: b.hl.slice(x, z), at: b.at.slice(x, z) });

/** Highlighted runs marked [[like this]]; paragraphs apart by a blank line. */
export function marked(b: { s: string; hl: (string | null)[] }): string {
  let out = "", on = false;
  for (let i = 0; i < b.s.length; i++) {
    const ch = b.s[i], h = !!b.hl[i] && ch !== "\n";
    if (h && !on) { out += "[["; on = true; }
    if (!h && on) { out += "]]"; on = false; }
    out += ch === "\n" ? "\n\n" : ch;
  }
  return out + (on ? "]]" : "");
}

/* ------------------------------------------------------------------ highlighting, tidied */

/** A word highlighted only partway gets the whole word; a highlighted space hanging off a highlight is cleared. */
function normHl(b: Body): { body: Body; fixed: number } {
  const s = b.s, hl = b.hl.slice();
  let fixed = 0;
  for (const m of s.matchAll(/[$€£]?[\p{L}\p{N}]+(?:['’\-.,][\p{L}\p{N}]+)*%?/gu)) {
    const a = m.index!, z = a + m[0].length, on = hl.slice(a, z).filter(Boolean);
    if (on.length && on.length < z - a) { for (let k = a; k < z; k++) hl[k] = hl[k] || on[0]; fixed++; }
  }
  const ws = (ch?: string) => /\s/.test(ch || "");
  for (let i = 0; i < s.length; i++) {
    if (!hl[i] || !ws(s[i])) continue;
    let p = i - 1; while (p >= 0 && ws(s[p])) p--;
    let q = i + 1; while (q < s.length && ws(s[q])) q++;
    if (!(p >= 0 && hl[p] && q < s.length && hl[q])) { hl[i] = null; fixed++; }
  }
  return { body: { ...b, hl }, fixed };
}

/* ------------------------------------------------------------------ sentences */

const ABBR = /\b(U\.S|U\.K|U\.N|E\.U|Mr|Mrs|Ms|Dr|Prof|St|No|vs|e\.g|i\.e|etc|Inc|Corp|Jr|Sr|Gen|Sen|Rep|Gov|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|al)\.$/i;

function sentenceRanges(s: string): [number, number][] {
  const out: [number, number][] = [];
  let a = 0;
  const push = (z: number) => { if (z > a) out.push([a, z]); };
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") { push(i); a = i + 1; continue; }
    if (/[.!?]/.test(s[i])) {
      let j = i + 1;
      while (j < s.length && /["”’)\]]/.test(s[j])) j++;
      if (s[j] === " " && /[A-Z“"(\[0-9]/.test(s[j + 1] || "") && !ABBR.test(s.slice(Math.max(a, i - 6), i + 1))) { push(j); a = j + 1; i = j; }
    }
  }
  push(s.length);
  return out.map(([x, z]): [number, number] => { while (x < z && s[x] === " ") x++; return [x, z]; }).filter(([x, z]) => z > x);
}
/** The sentences that have highlighting in them. */
const readSentences = (b: { s: string; hl: (string | null)[] }) =>
  sentenceRanges(b.s).filter(([x, z]) => b.hl.slice(x, z).some((h, k) => h && b.s[x + k] !== " "));

/** Where a long unread stretch at the top and bottom ends: [A, Z) is kept. */
const CUT_MIN = 35;
function cutEnds(b: Body): { a: number; z: number; top: number; bottom: number } {
  const hs = readSentences(b);
  if (!hs.length) return { a: 0, z: b.s.length, top: 0, bottom: 0 };
  const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
  const top = words(b.s.slice(0, hs[0][0])), bottom = words(b.s.slice(hs[hs.length - 1][1]));
  let a = top >= CUT_MIN ? hs[0][0] : 0, z = bottom >= CUT_MIN ? hs[hs.length - 1][1] : b.s.length;
  while (a < z && /\s/.test(b.s[a])) a++;
  while (z > a && /\s/.test(b.s[z - 1])) z--;
  return { a, z, top: a ? top : 0, bottom: z < b.s.length ? bottom : 0 };
}

/* ------------------------------------------------------------------ what Claude says, found in the card */

/** Phrases found in order (case, quotes, dashes and spacing aside) → [start, end) ranges; the rest counted as missed. */
export function find(b: { s: string }, phrases: string[]): { ranges: [number, number][]; miss: number } {
  const norm = (x: string) => x.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").toLowerCase();
  let ns = "";
  const map: number[] = [];
  for (let i = 0; i < b.s.length; i++) {
    const ch = /\s/.test(b.s[i]) ? " " : norm(b.s[i]);
    if (ch === " " && ns.endsWith(" ")) continue;
    ns += ch; map.push(i);
  }
  const out: [number, number][] = [];
  let cur = 0, miss = 0;
  for (const p of phrases || []) {
    const q = norm(String(p || "").replace(/\[\[|\]\]/g, "")).replace(/\s+/g, " ").trim();
    if (!q) continue;
    let at = ns.indexOf(q, cur);
    if (at < 0) at = ns.indexOf(q);
    if (at < 0) { miss++; continue; }
    out.push([map[at], map[at + q.length - 1] + 1]);
    cur = at + q.length;
  }
  return { ranges: out, miss };
}

/** Tightened highlighting, kept only where it passes the checks; the rest of the card's highlighting as it was. */
function rehighlight(b: Body, sents: [number, number][], list: { s: number; read: string }[]) {
  const s = b.s, orig = b.hl, hl = orig.slice();
  let tightened = 0, cut = 0;
  const norm = (w: string) => w.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}'%$-]/gu, "").replace(/^['-]+|['-]+$/g, "");
  for (const item of list) {
    const seg = sents[Number(item?.s) - 1];
    if (!seg || typeof item.read !== "string") continue;
    const [x, z] = seg;
    const toks = [...s.slice(x, z).matchAll(/\S+/g)].map((m) => ({ a: x + m.index!, z: x + m.index! + m[0].length, w: norm(m[0]) })).filter((t) => t.w);
    const want = item.read.replace(/\[\[|\]\]/g, " ").split(/\s+/).map(norm).filter(Boolean);
    if (!want.length) continue;
    const picked: number[] = [];
    let p = 0, ok = true;
    for (const w of want) { while (p < toks.length && toks[p].w !== w) p++; if (p >= toks.length) { ok = false; break; } picked.push(p++); }
    if (!ok) continue;
    const wasHl = (t: { a: number; z: number }) => orig.slice(t.a, t.z).some(Boolean);
    const before = toks.filter(wasHl);
    if (picked.filter((k) => !wasHl(toks[k])).length > 2) continue;                                       // reads new content
    if (picked.length >= before.length || picked.length < Math.ceil(before.length * 0.3)) continue;      // not shorter, or gutted
    const color = orig.slice(x, z).find(Boolean) || null;
    for (let k = x; k < z; k++) hl[k] = null;
    let prevEnd = -1, prevIdx = -2;
    picked.forEach((k) => {
      const t = toks[k];
      let ta = t.a, tz = t.z;
      while (tz > ta && /[.,;:!?)"”’\]]/.test(s[tz - 1])) tz--;
      while (ta < tz && /["“‘(\[]/.test(s[ta])) ta++;
      for (let q = ta; q < tz; q++) hl[q] = color;
      if (prevIdx === k - 1 && prevEnd >= 0) for (let q = prevEnd; q < ta; q++) if (s[q] === " ") hl[q] = color;
      prevEnd = tz; prevIdx = k;
    });
    tightened++; cut += before.length - picked.length;
  }
  return { hl, tightened, cut };
}

/** Underlining and bold, from Claude's phrases and the highlighting, within the cap. */
function decide(b: Body, hl: (string | null)[], underline: string[], bold: string[]) {
  const s = b.s, n = s.length;
  const u = hl.map((h, i) => !!h && s[i] !== "\n"), bo = new Array<boolean>(n).fill(false);
  const isW = (ch?: string) => /[\p{L}\p{N}'’\-%$]/u.test(ch || "");
  const widen = ([a, z]: [number, number]): [number, number] => { while (a > 0 && isW(s[a - 1]) && isW(s[a])) a--; while (z < n && isW(s[z]) && isW(s[z - 1])) z++; return [a, z]; };
  // highlighted words are underlined whole
  for (let i = 0; i < n; i++) if (u[i]) { const [a, z] = widen([i, i + 1]); for (let k = a; k < z; k++) u[k] = true; }
  const U = find(b, underline), B = find(b, bold);
  // context touching a highlight first, then standalone clauses, never past ~38% of the card underlined
  const nonSpace = s.replace(/\s/g, "").length || 1, cap = 0.38;
  const pct = () => u.filter((v, k) => v && !/\s/.test(s[k])).length / nonSpace;
  const touches = ([a, z]: [number, number]) => hl.slice(Math.max(0, a - 2), Math.min(n, z + 2)).some(Boolean);
  const rs = U.ranges.map(widen);
  const ordered = [...rs.filter(touches), ...rs.filter((r) => !touches(r)).sort((x, y) => (x[1] - x[0]) - (y[1] - y[0]))];
  for (const [a, z] of ordered) {
    const add = [...s.slice(a, z)].filter((ch, k) => !u[a + k] && !/\s/.test(ch)).length;
    if (pct() + add / nonSpace > cap && !touches([a, z])) continue;
    if (pct() + add / nonSpace > cap + 0.05) continue;
    for (let k = a; k < z; k++) if (s[k] !== "\n") u[k] = true;
  }
  // bold only inside underlining
  B.ranges.map(widen).forEach(([a, z]) => { for (let k = a; k < z; k++) if (s[k] !== "\n" && u[k]) bo[k] = true; });
  // a short gap between highlighted words in one sentence reads as one phrase: underlined
  let lastEnd = -1;
  for (let i = 0; i < n; i++) {
    if (!(hl[i] && s[i] !== " " && s[i] !== "\n")) continue;
    if (lastEnd >= 0 && i > lastEnd) {
      const gap = s.slice(lastEnd, i);
      if (!/[\n.!?;:]/.test(gap) && gap.trim().split(/\s+/).filter(Boolean).length <= 4) for (let k = lastEnd; k < i; k++) u[k] = true;
    }
    lastEnd = i + 1;
  }
  // words highlighted before stay underlined as context
  b.hl.forEach((h, k) => { if (h && s[k] !== "\n") u[k] = true; });
  for (let i = 1; i < n - 1; i++) if (s[i] === " ") { if (u[i - 1] && u[i + 1]) u[i] = true; if (bo[i - 1] && bo[i + 1]) bo[i] = true; }
  const pctU = Math.round((u.filter((v, k) => v && !/\s/.test(s[k])).length / nonSpace) * 100);
  return { u, b: bo, pctU, missed: U.miss + B.miss };
}

/* ------------------------------------------------------------------ asking */

const FormatShape = z.object({
  cite: z.object({
    author: z.string(), last: z.string(), yy: z.string(), quals: z.string(), title: z.string(),
    date: z.string(), outlet: z.string(), extra: z.string(), url: z.string(), cutter: z.string(),
  }),
  underline: z.array(z.string()),
  bold: z.array(z.string()),
});
const RehiShape = z.object({ sentences: z.array(z.object({ s: z.number(), read: z.string() })) });

function formatPrompt(cite: string, body: Body): string {
  return `You format debate evidence ("cards") in a house style. You never change, add or remove a single word of the card. You only decide formatting.

1) THE CITE. Split this raw cite into fields. Use only what's in the cite; leave a field "" if it isn't there; never invent credentials, dates or titles.
RAW CITE: ${cite || "(none)"}
Fields: "author" (full name as given, e.g. "Athanasios G. Platias"; an organization if there's no person), "last" (the part that will be bold: the last name, or the organization's short name; it must be the END of "author"), "yy" (2-digit year), "quals" (credentials as given, one sentence, no trailing period), "title", "date" (M-D-YYYY when the day is known, e.g. "5-2-2025"; "4-2026" or "2026" if that's all there is), "outlet" (publication or site), "extra" (volume/issue/pages if given), "url". Also "cutter": the handle or name of whoever cut the card, if one is written after the citation (e.g. "scarman", "dmrkva", "leo"); not an access date like "//doa 2-23-2026".

2) THE CARD. Highlighted text is marked [[like this]]; paragraphs are separated by blank lines. Decide:
- "underline": phrases to underline. Underlined text is shown at 11pt; everything else shrinks to 8pt, so underlining is what makes the card readable in context. Every highlighted part is underlined automatically. Add:
  · the few words right around a highlighted part that it needs to read as a complete thought: usually a short phrase before or after it, NOT the whole sentence;
  · at most 2–4 short unhighlighted clauses in the whole card, only where they carry a key warrant, mechanism or number that the highlighting depends on.
  Be sparing. Most of the card should stay small: background, filler, hedges, transitions, examples that aren't read, tangents, boilerplate. Aim for roughly 20–35% of the card underlined, never more than 40%. Don't underline whole paragraphs. Never drop a warrant.
- "bold": the few words that matter most: key claims, causal verbs, actors, numbers, the impact. About 1–3 words or short phrases per underlined sentence, never whole sentences, at most ~15% of the underlined words. Bold words must be inside underlined text.
Copy every phrase EXACTLY from the card text (without the [[ ]] marks), list each list in the order the phrases appear, and make each phrase long enough to be unique (at least 3 words for underline phrases).

THE CARD:
${marked(body)}`;
}

function rehiPrompt(body: Body, sents: [number, number][]): string {
  return `You re-highlight debate evidence for EFFICIENCY. In each sentence below, the words marked [[like this]] are what the debater reads out loud.

Make each highlighted reading shorter and tighter without losing anything that matters:
- Cut filler: articles, hedges ("potentially", "may", "relatively", "seemingly"), redundant modifiers, throat-clearing, repeated ideas, and words the listener can infer.
- NEVER cut a warrant, a number or statistic, an actor (who does what to whom), a causal or comparative word ("because", "causes", "leads to", "more than", "without"), a negation, or the impact. Never drop a whole reason. Keeping every warrant is the most important rule.
- The highlighted words, read in order, must still be a clear claim a judge can follow (telegraphic is fine, e.g. "prioritization of defense supersedes principles").
- You may add at most 2 short connecting words per sentence from that same sentence (like "is", "to", "of") when the trimmed reading needs them to make sense. Never highlight new clauses or new content.
- Use only words from that sentence, in their original order, spelled exactly as written.
- Leave out sentences that are already efficient. Cards usually have several sentences that can be tightened.

Give "s" as the sentence's number and "read" as its new highlighted words, in order, separated by spaces.

SENTENCES:
${sents.map(([x, z], i) => `S${i + 1}: ${marked(slice(body, x, z))}`).join("\n")}`;
}

/** The cite's parts from Claude's fields, in the shape writeCite takes; null when there's no name to bold. */
function citeParts(c: z.infer<typeof FormatShape>["cite"]): CiteParts | null {
  const clean = (x: string) => String(x || "").trim().replace(/[.\s]+$/, "");
  const author = clean(c.author), last = clean(c.last) || author.split(/\s+/).pop() || "", yy = String(c.yy || "").replace(/\D/g, "").slice(-2);
  if (!last) return null;
  const first = author && author !== last && author.endsWith(last) ? author.slice(0, author.length - last.length).trim() : "";
  return {
    first, short: last + (yy ? " " + yy : ""), quals: clean(c.quals), title: clean(c.title).replace(/^["“”]+|["“”]+$/g, ""),
    date: clean(c.date), pub: [clean(c.outlet), clean(c.extra)].filter(Boolean).join(", "), url: clean(c.url), doa: "", credit: clean(c.cutter),
  };
}

/* ------------------------------------------------------------------ the run */

/** The tags in the selection — or the card the cursor is in — as their order among the document's tags. */
export function cardsToDo(state: EditorState): number[] {
  const tags: number[] = [];
  state.doc.forEach((n, pos) => { if (n.type === schema.nodes.heading && n.attrs.level === 4) tags.push(pos); });
  const { from, to, empty } = state.selection;
  if (!empty) {
    const inSel = tags.map((p, i) => ({ p, i })).filter(({ p }) => p >= from - 1 && p < to).map(({ i }) => i);
    if (inSel.length) return inSel;
  }
  const c = cardAround(state);
  if (!c || !c.tag) return [];
  return [tags.indexOf(c.tag.pos)].filter((i) => i >= 0);
}

/** The card that is the k-th tag's, as it is now. */
export function cardAt(state: EditorState, k: number) {
  let n = -1, at = -1;
  state.doc.forEach((node, pos) => { if (at < 0 && node.type === schema.nodes.heading && node.attrs.level === 4 && ++n === k) at = pos; });
  return at < 0 ? null : cardAround(state, at + 1);
}

interface Asked {
  body: Body;                      // the kept stretch, with its places in the document
  full: Body;
  keep: { a: number; z: number; top: number; bottom: number };
  cite: string;
  fmt: z.infer<typeof FormatShape>;
  rehi: { s: number; read: string }[] | null;
  sents: [number, number][];
  fixed: number;
}

/** Ask Claude about one card, as it is when asked. */
async function ask(key: string, state: EditorState, k: number, o: ReformatOptions, signal?: AbortSignal): Promise<Asked | null> {
  const card = cardAt(state, k);
  if (!card || card.bodyFrom >= card.bodyTo) return null;
  const raw = readBody(state.doc, card.bodyFrom, card.bodyTo);
  if (!raw.s.trim()) return null;
  const { body: full, fixed } = normHl(raw);
  const keep = o.cutEnds ? cutEnds(full) : { a: 0, z: full.s.length, top: 0, bottom: 0 };
  // no cite line (or an empty one): the cite may be the body's first line, so the top is never cut
  const citeText = card.cite?.node.textContent.trim() || "";
  if (!citeText && keep.a) { keep.a = 0; keep.top = 0; }
  const body = slice(full, keep.a, keep.z);
  const cite = card.cite?.node.textContent || "";
  const sents = o.trim ? readSentences(body) : [];
  const [fmt, rehi] = await Promise.all([
    askJson(key, formatPrompt(cite, body), FormatShape, signal),
    sents.length ? askJson(key, rehiPrompt(body, sents), RehiShape, signal).then((r) => r.sentences).catch((e) => { if (e instanceof AiError && e.message === "Stopped.") throw e; return null; }) : Promise.resolve(null),
  ]);
  return { body, full, keep, cite, fmt, rehi, sents, fixed };
}

/** Put Claude's answer on the card, if the card is still as it was asked about. Returns what happened, or why not. */
function apply(view: EditorView, k: number, a: Asked, o: ReformatOptions): { ok: true; pctU: number; cut: number; tightened: number; cite: boolean } | { ok: false; why: string } {
  const card = cardAt(view.state, k);
  if (!card) return { ok: false, why: "it's gone" };
  const now = readBody(view.state.doc, card.bodyFrom, card.bodyTo);
  if (now.s !== a.full.s) return { ok: false, why: "it was edited while Claude worked" };
  // the kept stretch's places, as they are now (nothing has moved if the text is the same)
  const at = now.at.slice(a.keep.a, a.keep.z);
  const body: Body = { ...a.body, at };

  const re = o.trim && a.rehi ? rehighlight(body, a.sents, a.rehi) : { hl: body.hl, tightened: 0, cut: 0 };
  const d = decide(body, re.hl, a.fmt.underline, a.fmt.bold);

  const tr = view.state.tr;
  // every character's formatting decided afresh, in runs of the same
  const first = at.find((p) => p >= 0), last = [...at].reverse().find((p) => p >= 0);
  if (first !== undefined && last !== undefined) {
    for (const t of [M.underline, M.strong, M.box, M.fontSize, M.highlight]) tr.removeMark(first, last + 1, t);
    let i = 0;
    while (i < body.s.length) {
      if (at[i] < 0) { i++; continue; }
      let j = i + 1;
      while (j < body.s.length && at[j] === at[j - 1] + 1 && d.u[j] === d.u[i] && d.b[j] === d.b[i] && re.hl[j] === re.hl[i]) j++;
      const from = at[i], to = at[j - 1] + 1;
      if (d.u[i]) tr.addMark(from, to, M.underline.create());
      else tr.addMark(from, to, M.fontSize.create({ size: SMALL }));
      if (d.b[i]) { tr.addMark(from, to, M.strong.create()); tr.addMark(from, to, M.box.create()); }
      if (re.hl[i]) tr.addMark(from, to, M.highlight.create({ color: re.hl[i] }));
      i = j;
    }
  }
  // the unread ends: the bottom first, so the top's places still hold
  const end = now.at.filter((p) => p >= 0);
  const lastPos = end.length ? end[end.length - 1] + 1 : -1;
  const firstPos = end.length ? end[0] : -1;
  if (a.keep.bottom && last !== undefined && lastPos > last + 1) tr.delete(last + 1, lastPos);
  if (a.keep.top && first !== undefined && first > firstPos) tr.delete(firstPos, first);
  // the cite, in your cite format
  let citeDone = false;
  const parts = card.cite && card.cite.node.textContent.trim() ? citeParts(a.fmt.cite) : null;
  if (parts && card.cite) {
    tr.replaceWith(card.cite.pos, card.cite.pos + card.cite.node.nodeSize, writeCite(parts, o.citeFormat));
    citeDone = true;
  }
  view.dispatch(tr.scrollIntoView());

  if (o.condense) condenseUnread(view, k);
  return { ok: true, pctU: d.pctU, cut: a.keep.top + a.keep.bottom, tightened: re.tightened, cite: citeDone };
}

/** Unread paragraphs in the middle of the card — two or more, or one long one — condensed, none omitted. */
function condenseUnread(view: EditorView, k: number) {
  const card = cardAt(view.state, k);
  if (!card) return;
  const paras: { from: number; to: number; read: boolean; text: string }[] = [];
  view.state.doc.nodesBetween(card.bodyFrom, card.bodyTo, (n, pos) => {
    if (!n.isTextblock) return true;
    let read = false;
    n.descendants((c) => { if (c.isText && c.text?.trim() && c.marks.some((m) => m.type === M.underline || m.type === M.highlight)) read = true; });
    // a condensed stretch already there — its markers, and the tiny paragraph between them — is never part of a run
    const text = n.textContent.trim();
    const marker = /^<<.*>>$/.test(text);
    const afterOpen = paras.length > 0 && /^<<\s*TEXT\s+CONDENSED/i.test(paras[paras.length - 1].text);
    paras.push({ from: pos, to: pos + n.nodeSize, read: read || marker || afterOpen, text });
    return false;
  });
  const runs: { from: number; to: number }[] = [];
  for (let i = 1; i < paras.length - 1; i++) {
    if (paras[i].read) continue;
    let j = i;
    while (j < paras.length && !paras[j].read) j++;
    // coda's condense joins two paragraphs or more
    if (j < paras.length && j - i >= 2) runs.push({ from: paras[i].from, to: paras[j - 1].to });
    i = j;
  }
  // from the bottom up, so the runs above keep their places
  for (const r of runs.reverse()) {
    const st = view.state;
    const sel = TextSelection.create(st.doc, r.from + 1, r.to - 1);
    const res = condenseOmitted(st.apply(st.tr.setSelection(sel)));
    if (typeof res !== "string") {
      // the condensed transaction was made on a state that only moved the selection: its steps map onto this one
      const tr = st.tr;
      res.steps.forEach((s) => tr.step(s));
      view.dispatch(tr);
    }
  }
}

/**
 * Reformat the card the cursor is in, or every card in the selection. Two
 * cards are asked about at once; each is put on the card as its answer
 * comes, so the first is done in seconds.
 */
export async function aiReformat(view: EditorView, key: string, o: ReformatOptions, signal?: AbortSignal, onProgress?: (done: number, of: number) => void): Promise<ReformatReport> {
  const todo = cardsToDo(view.state);
  if (!todo.length) throw new AiError("Put the cursor in a card — or select several — to reformat.");
  const rep: ReformatReport = { cards: todo.length, done: 0, skipped: [], failed: [], cites: 0, cutWords: 0, tightened: 0, underlined: 0 };
  const name = (k: number) => cardAt(view.state, k)?.tag?.node.textContent.slice(0, 50) || "a card";
  let next = 0, sum = 0, finished = 0;
  onProgress?.(0, todo.length);
  const worker = async () => {
    while (next < todo.length) {
      const k = todo[next++];
      try {
        const a = await ask(key, view.state, k, o, signal);
        if (!a) { rep.skipped.push(name(k) + " (no card text)"); }
        else {
          const r = apply(view, k, a, o);
          if (r.ok) { rep.done++; sum += r.pctU; rep.cutWords += r.cut; rep.tightened += r.tightened; if (r.cite) rep.cites++; }
          else rep.skipped.push(name(k) + " (" + r.why + ")");
        }
      } catch (e) {
        if (e instanceof AiError && e.message === "Stopped.") throw e;
        rep.failed.push(name(k) + ": " + (e instanceof Error ? e.message : String(e)));
        // a bad key or no credit fails every card the same way: stop asking
        if (e instanceof AiError && /API key|credit|reach Claude/.test(e.message)) throw e;
      }
      onProgress?.(++finished, todo.length);
    }
  };
  await Promise.all([worker(), worker()]);
  rep.underlined = rep.done ? Math.round(sum / rep.done) : 0;
  return rep;
}
