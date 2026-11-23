/**
 * The back half, from the cards already read.
 *
 * Two kinds, the way debaters write them:
 *
 * - Extensions ("XT---Escalation---Main---1AR"): for each story the case
 *   tells — the main one and each scenario — a short bold paragraph that
 *   extends it in the next speech: what's true now, the link, the internal
 *   links, the impact, each in the cards' own reasoning, the words a judge
 *   has to hear underlined. Weighing ("1---Magnitude---…") after them.
 *
 * - For reference (2AC/2NC blocks): a new tag that answers what's coming, then
 *   "<<FOR REFERENCE---Smith 24>>", then only the paragraphs of a card
 *   already read that prove it — copied exactly, with their highlighting
 *   turned grey (read before, shown again).
 *
 * Claude picks the stories, writes the words, and points at cards and
 * paragraphs by number; the cards themselves are copied here, never
 * rewritten, and a number that isn't one is dropped.
 */
import { z } from "zod";
import type { EditorState } from "prosemirror-state";
import { Fragment, type Node as PMNode, type Mark } from "prosemirror-model";
import { schema } from "@/lib/evidence/docSchema";
import { askJson, AiError } from "./claude";
import { cardsToDo } from "./reformat";
import { THEIRS_COLOR } from "./indict";

const N = schema.nodes, M = schema.marks;

export type Side = "aff" | "neg";
export type BackKind = "extend" | "reference";

export interface FileCard {
  /** its order among the file's tags */
  k: number;
  tag: string;
  cite: string;
  /** "Smith 24" */
  name: string;
  /** the block (H3) it's under */
  block: string;
  /** its non-empty body paragraphs, as they are */
  paras: PMNode[];
}
export interface FileRead { heads: string[]; side: Side | ""; cards: FileCard[]; selected: boolean }

const BACK = /---\s*(2AC|1AR|2AR|2NC|1NR|2NR|block|ext)/i;

/** "Smith 24" out of a cite: its bold words, else the "Name YY" in it. */
function nameOf(cite: PMNode | null, citeText: string, tag: string): string {
  let bold = "";
  cite?.descendants((n) => { if (n.isText && n.marks.some((m) => m.type === M.strong)) bold += n.text + " "; });
  const clean = (s: string) => s.replace(/\s+/g, " ").replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, "").replace(/[’'](\d{2})\b/, "$1").trim();
  const b = clean(bold);
  if (b && /\b\d{2}\b/.test(b) && b.length <= 60) return b;
  const m = citeText.match(/([A-Z][\p{L}'’-]+(?:\s*(?:&|and)\s*[A-Z][\p{L}'’-]+)?(?:\s+et al\.?)?)\s*[’']?(\d{2})\b/u);
  if (m) return m[1] + " " + m[2];
  return b || tag.split(/\s+/).slice(0, 3).join(" ");
}

/**
 * The file as cards: every card under its block, or the ones selected. A
 * card that is itself "for reference" isn't a source, and neither are the
 * back half's own cards when there are front-half ones to use.
 */
export function readFile(state: EditorState): FileRead {
  const heads: string[] = [];
  const all: (FileCard & { back: boolean; ref: boolean })[] = [];
  let h2 = "", h3 = "", k = -1;
  let cur: (FileCard & { back: boolean; ref: boolean; citeSeen: boolean }) | null = null;
  state.doc.forEach((n) => {
    if (n.type === N.heading) {
      const t = n.textContent.trim();
      if (n.attrs.level <= 3 && t) heads.push(t);
      if (n.attrs.level <= 2) { h2 = t; h3 = ""; }
      if (n.attrs.level === 3) h3 = t;
      if (n.attrs.level === 4) {
        k++;
        cur = { k, tag: t, cite: "", name: "", block: h3, paras: [], back: BACK.test(h3) || BACK.test(h2), ref: false, citeSeen: false };
        all.push(cur);
      } else cur = null;
      return;
    }
    if (!cur || n.type !== N.paragraph) return;
    const text = n.textContent.trim();
    if (!text) return;
    if (!cur.citeSeen) {
      cur.citeSeen = true;
      if (/^<<\s*for reference/i.test(text)) { cur.ref = true; cur.cite = text; return; }
      cur.cite = text;
      cur.name = nameOf(n, text, cur.tag);
      return;
    }
    cur.paras.push(n);
  });
  const real = all.filter((c) => !c.ref && c.paras.length);
  const picked = cardsToDo(state);
  const sel = !state.selection.empty && picked.length > 1;
  let cards: FileCard[] = sel ? real.filter((c) => picked.includes(c.k)) : real.filter((c) => !c.back);
  if (!cards.length) cards = real;
  const joined = heads.join(" ");
  const side: Side | "" = /\b(1AC|2AC|1AR|2AR|aff)\b/i.test(joined) ? "aff" : /\b(1NC|2NC|1NR|2NR|neg)\b/i.test(joined) ? "neg" : "";
  return { heads: heads.slice(0, 40), side, cards: cards.map(({ k: kk, tag, cite, name, block, paras }) => ({ k: kk, tag, cite, name, block, paras })), selected: sel };
}

/** A paragraph's words, with what's read marked [[like this]]. */
function markedText(p: PMNode): string {
  let out = "", on = false;
  p.descendants((n) => {
    if (!n.isText) return;
    const hl = n.marks.some((m) => m.type === M.highlight);
    if (hl && !on) { out += "[["; on = true; }
    if (!hl && on) { out += "]]"; on = false; }
    out += n.text;
  });
  if (on) out += "]]";
  return out.replace(/\s+/g, " ").trim();
}
const readOf = (c: FileCard) => c.paras.map((p) => { let r = ""; p.descendants((n) => { if (n.isText && n.marks.some((m) => m.type === M.highlight)) r += n.text + " "; }); return r; }).join(" ").replace(/\s+/g, " ").trim();

/* ------------------------------------------------------------------ extensions */

const XtShape = z.object({
  name: z.string(),
  extensions: z.array(z.object({ scenario: z.string(), text: z.string(), underline: z.array(z.string()) })),
  weighing: z.array(z.object({ label: z.string(), text: z.string(), underline: z.array(z.string()) })),
});

function xtPrompt(f: FileRead, side: Side, speech: string, want: string, weighing: boolean): string {
  const cards = f.cards.map((c, i) => `C${i + 1} ${c.name}${c.block ? ` [${c.block}]` : ""}\n  Tag: ${c.tag.slice(0, 300)}\n  Read: ${readOf(c).slice(0, 1600) || "(nothing highlighted)"}`).join("\n");
  return `You're writing the back half of a policy debate ${side === "aff" ? "affirmative" : "negative"} file: extensions for the ${speech}.

The file's headings: ${f.heads.join(" · ").slice(0, 1500)}

Its cards, in order (name, block, tag, and the words read):
${cards.slice(0, 60000)}

${want.trim() ? `What the debater wants extended: ${want.trim()}\n\n` : ""}Find the distinct stories the file tells: the main chain (what's true now → the link → the internal links → the impact), and each separate scenario or internal link that reaches the impact a different way. For each, write one extension, the way it's read in the ${speech}:
- "scenario": a short name for the story, as debaters label it ("Main", "France", "Space", "Trump v NATO"). The first is "Main".
- "text": 3 to 6 short, dense sentences that extend that story step by step, in the cards' own reasoning (each step's warrant, not just its claim), in a confident debater's voice. Use the names debaters use ("the AFF", "the NEG", "squo") and the card's mechanism words. No card names, no quotes, no hedging, no "their evidence says". End on the impact.
- "underline": the 4 to 10 words or short phrases (1 to 3 words each, copied exactly from your text) a judge has to hear: the mechanism words and the impact ("structurally", "miscalculation", "nuclear").

${weighing ? `"weighing": 2 or 3 numbered weighing points for the ${speech}, the strongest for this file: each "label" one word or two ("Magnitude", "Try or Die", "Timeframe", "Turns Case", "Probability") and "text" 2 to 4 sentences comparing this file's impact to what the other side will say, with its "underline" words likewise.` : `"weighing": [].`}

"name": the position's short name, as its headings name it ("Escalation", "Collapse").

An example of the voice, on a different topic:
scenario "Main", text "Warming is locked in now. Absent the plan, methane feedbacks trigger runaway heating. That collapses agriculture, causing famine and resource wars that go nuclear.", underline ["locked in", "runaway", "nuclear"].`;
}

/* ------------------------------------------------------------------ for reference */

const RefShape = z.object({
  name: z.string(),
  blocks: z.array(z.object({
    heading: z.string(),
    items: z.array(z.object({ tag: z.string(), card: z.number(), paragraphs: z.array(z.number()) })),
  })),
});

function refPrompt(f: FileRead, side: Side, speech: string, want: string): string {
  let budget = 90000;
  const cards: string[] = [];
  f.cards.forEach((c, i) => {
    const paras = c.paras.map((p, j) => `  ¶${j + 1} ${markedText(p).slice(0, 1400)}`).join("\n");
    const s = `C${i + 1} ${c.name}${c.block ? ` [${c.block}]` : ""}\n  Tag: ${c.tag.slice(0, 300)}\n${paras}`;
    if (budget - s.length < 0) return;
    budget -= s.length;
    cards.push(s);
  });
  return `You're writing ${speech} blocks for a policy debate ${side === "aff" ? "affirmative" : "negative"} file, made only of the file's own cards "for reference": a new tag, then the paragraphs of a card already read that prove it, read again.

The file's headings: ${f.heads.join(" · ").slice(0, 1500)}

Its cards, numbered, each paragraph numbered, with what was read marked [[like this]]:
${cards.join("\n\n")}

${want.trim()
    ? `Write the blocks the debater asks for: ${want.trim()}`
    : `Write the 3 to 6 blocks this file most needs in the ${speech}: the answers the other side will make to it (that the impact won't happen, that there's no link or no escalation, alternate causes, their likely turn, why their authors are wrong) and the reasons this file's claims are true ("Yes [impact]").`}

For each block:
- "heading": what it answers or proves, as debaters title blocks ("Yes Russia War", "AT: Nuclear Deterrence", "AT: Ukraine Thumps").
- "items": one or more, each a tag and the card paragraphs that prove it:
  - "tag": a new claim in a debater's voice, said as an answer ("Reject their authors---experts neglect the risk"). When a block lists several reasons for one claim, start each tag with a letter: "A---Russia's cornered", "B---Geographical funding".
  - "card": the card's number (C3 → 3).
  - "paragraphs": the numbers of that card's paragraphs that prove the tag, in order: only those (usually 1 to 3), never the whole card unless it all does. A paragraph proves the tag only if its own words, especially what's read, actually say it.

Use only these cards. A tag no paragraph proves is left out. The same card can be used for several tags, each with the paragraphs that prove that tag.

"name": the position's short name, as its headings name it ("Escalation", "Collapse").`;
}

/* ------------------------------------------------------------------ building it */

const T = (s: string, marks: readonly Mark[] = []) => schema.text(s, marks);
const heading = (level: number, s: string) => N.heading.create({ level }, T(s));

/** Bold words, with these phrases also underlined (each where it first appears). */
function boldPara(text: string, under: string[]): PMNode {
  const ranges: [number, number][] = [];
  const low = text.toLowerCase();
  for (const u of under) {
    const w = u.trim();
    if (!w) continue;
    let at = text.indexOf(w);
    if (at < 0) at = low.indexOf(w.toLowerCase());
    if (at >= 0) ranges.push([at, at + w.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) { const l = merged[merged.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else merged.push([...r]); }
  const B = [M.strong.create()], BU = [M.strong.create(), M.underline.create()];
  const kids: PMNode[] = [];
  let i = 0;
  for (const [a, z2] of merged) {
    if (a > i) kids.push(T(text.slice(i, a), B));
    kids.push(T(text.slice(a, z2), BU));
    i = z2;
  }
  if (i < text.length) kids.push(T(text.slice(i), B));
  return N.paragraph.create(null, kids.length ? kids : null);
}

/** A card's paragraph as it is, its highlighting turned grey. */
function greyed(p: PMNode): PMNode {
  const kids: PMNode[] = [];
  p.forEach((ch) => {
    if (!ch.isText) { kids.push(ch); return; }
    kids.push(ch.mark(ch.marks.map((m) => (m.type === M.highlight ? M.highlight.create({ color: THEIRS_COLOR }) : m))));
  });
  return p.type.create(p.attrs, Fragment.fromArray(kids), p.marks);
}

export interface BackHalf { nodes: PMNode[]; made: number; what: string }

/** Ask Claude, and build what goes in the file. */
export async function writeBackHalf(key: string, f: FileRead, o: { kind: BackKind; side: Side; speech: string; want: string; weighing: boolean }, signal?: AbortSignal): Promise<BackHalf> {
  if (!f.cards.length) throw new AiError("No cards here to work from: open the file with the case or the position in it");
  if (o.kind === "extend") {
    const r = await askJson(key, xtPrompt(f, o.side, o.speech, o.want, o.weighing), XtShape, signal, "medium");
    const name = r.name.trim() || "Case";
    const nodes: PMNode[] = [heading(2, `${name}---${o.speech}`)];
    let made = 0;
    for (const x of r.extensions) {
      if (!x.text.trim()) continue;
      nodes.push(heading(3, `XT---${name}---${x.scenario.trim() || "Main"}---${o.speech}`), boldPara(x.text.trim(), x.underline));
      made++;
    }
    if (o.weighing && r.weighing.length) {
      nodes.push(heading(3, `Weighing---${o.speech}`));
      r.weighing.forEach((w, i) => {
        const label = w.label.trim();
        const text = `${i + 1}---${label}---${w.text.trim()}`;
        nodes.push(boldPara(text, [label, ...w.underline]));
      });
    }
    if (!made) throw new AiError("Claude didn't find a story to extend in these cards");
    return { nodes, made, what: `${made} ${made === 1 ? "extension" : "extensions"}${o.weighing && r.weighing.length ? " and weighing" : ""}` };
  }
  const r = await askJson(key, refPrompt(f, o.side, o.speech, o.want), RefShape, signal, "medium");
  const name = r.name.trim() || "Case";
  const nodes: PMNode[] = [heading(2, `${name}---${o.speech}`)];
  let made = 0, blocks = 0;
  for (const b of r.blocks) {
    const kept: { tag: string; c: FileCard; idx: number[] }[] = [];
    for (const it of b.items) {
      const c = f.cards[Math.round(it.card) - 1];
      if (!c) continue;
      const idx = [...new Set(it.paragraphs.map((n) => Math.round(n) - 1))].filter((j) => j >= 0 && j < c.paras.length).sort((a, b2) => a - b2);
      // the letter is ours to give: A---, B--- when a block has several reasons, none when it has one
      const tag = it.tag.trim().replace(/^[A-Z]\s*(---|—|[.):-])\s*/, "");
      if (!idx.length || !tag) continue;
      kept.push({ tag, c, idx });
    }
    if (!kept.length) continue;
    const items: PMNode[] = kept.flatMap(({ tag, c, idx }, i) => [
      heading(4, kept.length > 1 ? `${String.fromCharCode(65 + (i % 26))}---${tag}` : tag),
      N.paragraph.create(null, T(`<<FOR REFERENCE---${c.name}>>`)),
      ...idx.map((j) => greyed(c.paras[j])),
    ]);
    made += kept.length;
    nodes.push(heading(3, `${b.heading.trim() || "Block"}---${o.speech}`), ...items);
    blocks++;
  }
  if (!made) throw new AiError("Claude didn't find paragraphs in these cards that prove anything asked for");
  return { nodes, made, what: `${blocks} ${blocks === 1 ? "block" : "blocks"}, ${made} for reference` };
}
