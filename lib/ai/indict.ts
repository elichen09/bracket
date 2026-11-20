/**
 * Rehighlight for indicts: a copy of their card, highlighted again to read
 * what it concedes, for the speech doc. Their file is never touched.
 *
 * Claude reads the whole card, unread words included, and finds where the
 * author undercuts the tag: a concession, a hedge ("could", "in the long
 * run"), a condition, a limit on scope, a counter-example, the author
 * arguing the other way. For each one it names the card's own words that,
 * read in order, say it, the way a debater highlights. Every phrase is
 * checked against the card word for word, and one that isn't found is
 * dropped.
 *
 * In the copy, their highlighting is greyed (so you can show what they
 * read) and the indicts are highlighted in cyan and underlined.
 * Optionally the tag is rewritten to say what the indicts prove. A card
 * edited while Claude worked on it is left alone.
 */
import { z } from "zod";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "@/lib/evidence/docSchema";
import { askJson, AiError } from "./claude";
import { readBody, marked, find, cardsToDo, cardAt, type Body } from "./reformat";

const M = schema.marks;
export const INDICT_COLOR = "#00ffff";   // Word's cyan, the same in a .docx
export const THEIRS_COLOR = "#c0c0c0";   // Word's light grey: what they read, still shown

export interface IndictOptions { retag: boolean }
/** One rehighlighted card: the copy (its tag and body), and the block it was filed under. */
export interface Rehighlight { doc: PMNode; block: string; tag: string }
export interface IndictReport { cards: number; done: Rehighlight[]; indicts: number; says: string[]; skipped: string[]; failed: string[] }

const Shape = z.object({
  indicts: z.array(z.object({ phrases: z.array(z.string()), says: z.string() })),
  tag: z.string(),
});

/**
 * The argument the card is part of: the other cards in its block (under the same block heading, or
 * the whole file if there are none). Each has its tag, and the nearest ones also the words they read.
 */
function argumentAround(doc: PMNode, tagPos: number): { block: string; cards: string[] } {
  const top: { node: PMNode; pos: number }[] = [];
  doc.forEach((node, pos) => top.push({ node, pos }));
  const H = schema.nodes.heading;
  const isHead = (n: PMNode, max: number) => n.type === H && n.attrs.level <= max;
  let a = 0, z = top.length;
  const me = top.findIndex((t) => t.pos === tagPos);
  for (let i = me - 1; i >= 0; i--) if (isHead(top[i].node, 3)) { a = i; break; }
  for (let i = me + 1; i < top.length; i++) if (isHead(top[i].node, 3)) { z = i; break; }
  const block = a < me && isHead(top[a].node, 3) ? top[a].node.textContent.trim() : "";
  const cards: { at: number; tag: string; read: string }[] = [];
  let cur: { at: number; tag: string; read: string } | null = null;
  for (let i = a; i < z; i++) {
    const n = top[i].node;
    if (n.type === H && n.attrs.level === 4) {
      cur = i === me ? null : { at: i, tag: n.textContent.trim(), read: "" };
      if (cur) cards.push(cur);
      continue;
    }
    if (!cur || isHead(n, 3)) continue;
    n.descendants((c) => { if (c.isText && c.marks.some((m) => m.type === M.highlight)) cur!.read += c.text + " "; });
  }
  // the nearest first, so a long block keeps the cards around this one
  cards.sort((x, y) => Math.abs(x.at - me) - Math.abs(y.at - me));
  const out = cards.slice(0, 16).sort((x, y) => x.at - y.at).map((c) => {
    const near = Math.abs(c.at - me) <= 3 && c.read.trim();
    const side = c.at < me ? "before" : "after";
    return `- (${side}) ${c.tag.slice(0, 220)}${near ? `\n  read: ${c.read.replace(/\s+/g, " ").trim().slice(0, 400)}` : ""}`;
  });
  return { block, cards: out };
}

function prompt(tag: string, cite: string, body: Body, arg: { block: string; cards: string[] }): string {
  const rest = arg.cards.length
    ? `The rest of their argument, the other cards they read with this one${arg.block ? ` (block: "${arg.block}")` : ""}:\n${arg.cards.join("\n")}`
    : `(No other cards of theirs are near this one. Assume the argument it is part of is the one its tag implies, link and all.)`;
  return `You're helping a policy debater answer the other team's evidence by rehighlighting it: reading the card's own words, often ones the other team didn't read, to show that it doesn't say what they claim, or that it helps the debater instead.

${rest}

The card to rehighlight:
Their tag: ${tag || "(none)"}
Cite: ${cite || "(none)"}
The card, with what they highlighted marked [[like this]]:
"""
${marked(body).slice(0, 14000)}
"""

First work out the card's job in their argument: which step of their logic it's read to prove, and what that step needs to be true. Then find the indicts: places where the author's own reasoning breaks that step. These include a concession, a probability that's too low to carry their impact ("could", "may", "unlikely"), a condition the claim depends on, a limit on its scope, a timeframe that doesn't fit, a counter-example, an alternate cause, or the author arguing the other way. An indict has to matter to their logic: a hedge on a detail their argument doesn't need isn't one. Only real ones. A card whose reasoning supports its tag all the way through has none.

Ordinary hedging is never an indict. Nearly every card says "may", "could", "can", "potential", "risk of" or "would", and pointing that out takes nothing away from their argument. An indict needs something with substance: the author putting a number or timeline on it that contradicts their claim (their own roadmap putting the first assessments in late 2027, when they claim it's fielded by 2027), saying it's unlikely or far off, naming a condition that isn't met, conceding the mechanism fails, limiting the claim to cases that don't include theirs, or arguing the other way. Before you keep one, ask: if the other team simply conceded this point, would their argument be any weaker? If not, drop it.

Every indict must assume the link. Grant the other team what their other cards' words actually prove (not what their tags claim beyond that), especially that the plan (or whatever they're answering) causes what their links say it causes. An indict counts only if it still holds then. When the author says the impact happens only under some condition, and their link says the plan brings that condition about, then "that condition is unlikely" or "that won't happen" is NOT an indict: their link already answers it. For example, if the card says a leader would attack only if his economy collapsed, and their link says the plan collapses the economy, then "a collapse is unlikely" doesn't assume the link. Look instead for what survives it: even if the economy collapsed, the author says an attack would be unlikely, delayed, limited, deterred, or would depend on something else they haven't proven. When you're unsure whether an indict assumes the link, leave it out. Fewer, airtight indicts are better than many weak ones.

A condition the card's claim depends on IS an indict when their other cards don't actually establish it. If the card says sensors would threaten submarines "if a state were to deploy quantum sensors capable of tracking deployed SSBNs", and their other card only shows navigation trials, the claim rests on a capability their evidence never shows. That counts, and it isn't hedging. Name what's missing in "says".

For each indict, up to 3 and strongest first:
- "phrases": the card's words that say the indict, copied exactly as they appear in the card (spelling, punctuation and order), each 1 to 20 words, in the order they appear. Read in order, they should make a sentence or two a debater could read out loud, the way debaters highlight: skip the filler, keep what makes it make sense.
- "says": one short line on what the indict proves, even granting their link ("even with a collapse, the author says an attack is unlikely").

"tag": a new tag for the card as rehighlighted, said as an answer to theirs, in a debater's voice ("Their own author concedes pledges don't change targeting: deterrence holds regardless"). Use "" if there are no indicts.`;
}

/** A range grown to whole words. */
function words(s: string, [a, z]: [number, number]): [number, number] {
  const w = (ch?: string) => !!ch && /[\p{L}\p{N}'’%-]/u.test(ch);
  while (a > 0 && w(s[a - 1]) && w(s[a])) a--;
  while (z < s.length && w(s[z]) && w(s[z - 1])) z++;
  return [a, z];
}

/** Characters [a, z) of a body, as runs of document places that follow on (a range can cross a paragraph break). */
function runs(b: Body, a: number, z: number): [number, number][] {
  const out: [number, number][] = [];
  let i = a;
  while (i < z) {
    if (b.at[i] < 0) { i++; continue; }
    let j = i + 1;
    while (j < z && b.at[j] === b.at[j - 1] + 1) j++;
    out.push([b.at[i], b.at[j - 1] + 1]);
    i = j;
  }
  return out;
}

export async function aiIndict(view: EditorView, key: string, o: IndictOptions, signal?: AbortSignal, onProgress?: (done: number, of: number) => void, only?: number[]): Promise<IndictReport> {
  // the cards asked for (their order among the tags), else the ones selected or the cursor is in
  const todo = only && only.length ? only : cardsToDo(view.state);
  if (!todo.length) throw new AiError("Put the cursor in their card, or select several, to rehighlight.");
  const rep: IndictReport = { cards: todo.length, done: [], indicts: 0, says: [], skipped: [], failed: [] };
  const made = new Map<number, Rehighlight>();
  const name = (k: number) => cardAt(view.state, k)?.tag?.node.textContent.slice(0, 50) || "a card";
  let next = 0, finished = 0;
  onProgress?.(0, todo.length);

  const one = async (k: number) => {
    const card = cardAt(view.state, k);
    if (!card || !card.tag || card.bodyFrom >= card.bodyTo) { rep.skipped.push(name(k) + " (no card text)"); return; }
    const body = readBody(view.state.doc, card.bodyFrom, card.bodyTo);
    if (!body.s.trim()) { rep.skipped.push(name(k) + " (no card text)"); return; }
    const arg = argumentAround(view.state.doc, card.tag.pos);
    const r = await askJson(key, prompt(card.tag.node.textContent, card.cite?.node.textContent || "", body, arg), Shape, signal);

    // the card as it is now: still the same words, or left alone
    const st = view.state;
    const now = cardAt(st, k);
    if (!now || !now.tag) { rep.skipped.push(name(k) + " (it's gone)"); return; }
    const cur = readBody(st.doc, now.bodyFrom, now.bodyTo);
    if (cur.s !== body.s) { rep.skipped.push(name(k) + " (edited while Claude worked)"); return; }

    const ranges: [number, number][] = [];
    const says: string[] = [];
    for (const ind of r.indicts.slice(0, 3)) {
      const f = find(cur, ind.phrases);
      if (!f.ranges.length) continue;
      ranges.push(...f.ranges.map((x) => words(cur.s, x)));
      says.push(ind.says);
    }
    if (!ranges.length) { rep.skipped.push(name(k) + " (no indicts in it)"); return; }

    // the copy: made on a transaction that is never dispatched, so the file stays as it is
    const tr = st.tr;
    // what they highlighted, greyed
    let i = 0;
    while (i < cur.s.length) {
      if (!cur.hl[i]) { i++; continue; }
      let j = i + 1;
      while (j < cur.s.length && cur.hl[j]) j++;
      for (const [a, z] of runs(cur, i, j)) tr.addMark(a, z, M.highlight.create({ color: THEIRS_COLOR }));
      i = j;
    }
    // the indicts, in cyan and read
    for (const [a, z] of ranges) {
      for (const [x, y] of runs(cur, a, z)) {
        tr.addMark(x, y, M.highlight.create({ color: INDICT_COLOR }));
        tr.addMark(x, y, M.underline.create());
        tr.removeMark(x, y, M.fontSize);
      }
    }
    const newTag = o.retag ? r.tag.trim() : "";
    if (newTag) tr.replaceWith(now.tag.pos + 1, now.tag.pos + now.tag.node.nodeSize - 1, schema.text(newTag));
    const from = tr.mapping.map(now.tag.pos), to = tr.mapping.map(now.end);
    let block = "";
    st.doc.forEach((n, p) => { if (p < now.tag!.pos && n.type === schema.nodes.heading && n.attrs.level === 3) block = n.textContent.trim(); });
    made.set(k, { doc: tr.doc.cut(from, to), block, tag: newTag || now.tag.node.textContent });
    rep.indicts += says.length; rep.says.push(...says);
  };

  const worker = async () => {
    while (next < todo.length) {
      const k = todo[next++];
      try { await one(k); }
      catch (e) {
        if (e instanceof AiError && e.message === "Stopped.") throw e;
        rep.failed.push(name(k) + ": " + (e instanceof Error ? e.message : String(e)));
        if (e instanceof AiError && /API key|credit|reach Claude/.test(e.message)) throw e;
      }
      onProgress?.(++finished, todo.length);
    }
  };
  await Promise.all([worker(), worker()]);
  // in the order the cards are in the file
  rep.done = todo.filter((k) => made.has(k)).map((k) => made.get(k)!);
  return rep;
}
