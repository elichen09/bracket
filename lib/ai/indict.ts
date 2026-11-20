/**
 * Rehighlight for indicts: their card, highlighted again to read what it
 * concedes.
 *
 * Claude reads the whole card, unread words included, and finds where the
 * author undercuts the tag: a concession, a hedge ("could", "in the long
 * run"), a condition, a limit on scope, a counter-example, the author
 * arguing the other way. For each one it names the card's own words that,
 * read in order, say it, the way a debater highlights. Every phrase is
 * checked against the card word for word, and one that isn't found is
 * dropped. Then their highlighting comes off and the indicts go on, in
 * cyan and underlined. Optionally the tag is rewritten to say what the
 * indicts prove.
 *
 * No word of the card changes. A card edited while Claude worked on it is
 * left alone. One Ctrl+Z puts their highlighting back.
 */
import { z } from "zod";
import type { EditorView } from "prosemirror-view";
import { schema } from "@/lib/evidence/docSchema";
import { askJson, AiError } from "./claude";
import { readBody, marked, find, cardsToDo, cardAt, type Body } from "./reformat";

const M = schema.marks;
export const INDICT_COLOR = "#00ffff";   // Word's cyan, the same in a .docx

export interface IndictOptions { retag: boolean }
export interface IndictReport { cards: number; done: number; indicts: number; says: string[]; skipped: string[]; failed: string[] }

const Shape = z.object({
  indicts: z.array(z.object({ phrases: z.array(z.string()), says: z.string() })),
  tag: z.string(),
});

function prompt(tag: string, cite: string, body: Body): string {
  return `You're helping a policy debater answer the other team's evidence by rehighlighting it: reading the card's own words, often ones the other team didn't read, to show that it doesn't say what they claim, or that it helps the debater instead.

Their tag: ${tag || "(none)"}
Cite: ${cite || "(none)"}
The card, with what they highlighted marked [[like this]]:
"""
${marked(body).slice(0, 14000)}
"""

Find the indicts: places where the author undercuts the tag. These include a concession, a hedge or a probability ("could", "may", "in the long term", "unlikely"), a condition the claim depends on, a limit on its scope, a counter-example, an alternate cause, or the author arguing the other way. Only real ones. A card that says what its tag says has none.

For each indict, up to 3 and strongest first:
- "phrases": the card's words that say the indict, copied exactly as they appear in the card (spelling, punctuation and order), each 1 to 20 words, in the order they appear. Read in order, they should make a sentence or two a debater could read out loud, the way debaters highlight: skip the filler, keep what makes it make sense.
- "says": one short line on what the indict proves ("the author concedes NFU doesn't change targeting").

"tag": a new tag for the card as rehighlighted, said as an answer to theirs, in a debater's voice ("Their own author concedes pledges don't change targeting: deterrence holds regardless"). Use "" if there are no indicts.`;
}

/** A range grown to whole words. */
function words(s: string, [a, z]: [number, number]): [number, number] {
  const w = (ch?: string) => !!ch && /[\p{L}\p{N}'’%-]/u.test(ch);
  while (a > 0 && w(s[a - 1]) && w(s[a])) a--;
  while (z < s.length && w(s[z]) && w(s[z - 1])) z++;
  return [a, z];
}

export async function aiIndict(view: EditorView, key: string, o: IndictOptions, signal?: AbortSignal, onProgress?: (done: number, of: number) => void): Promise<IndictReport> {
  const todo = cardsToDo(view.state);
  if (!todo.length) throw new AiError("Put the cursor in their card, or select several, to rehighlight.");
  const rep: IndictReport = { cards: todo.length, done: 0, indicts: 0, says: [], skipped: [], failed: [] };
  const name = (k: number) => cardAt(view.state, k)?.tag?.node.textContent.slice(0, 50) || "a card";
  let next = 0, finished = 0;
  onProgress?.(0, todo.length);

  const one = async (k: number) => {
    const card = cardAt(view.state, k);
    if (!card || card.bodyFrom >= card.bodyTo) { rep.skipped.push(name(k) + " (no card text)"); return; }
    const body = readBody(view.state.doc, card.bodyFrom, card.bodyTo);
    if (!body.s.trim()) { rep.skipped.push(name(k) + " (no card text)"); return; }
    const r = await askJson(key, prompt(card.tag?.node.textContent || "", card.cite?.node.textContent || "", body), Shape, signal);

    // the card as it is now: still the same words, or left alone
    const now = cardAt(view.state, k);
    if (!now) { rep.skipped.push(name(k) + " (it's gone)"); return; }
    const cur = readBody(view.state.doc, now.bodyFrom, now.bodyTo);
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

    const tr = view.state.tr;
    tr.removeMark(now.bodyFrom, now.bodyTo, M.highlight);
    for (const [a, z] of ranges) {
      // a range can cross a paragraph break: mark it in runs of places that follow on
      let i = a;
      while (i < z) {
        if (cur.at[i] < 0) { i++; continue; }
        let j = i + 1;
        while (j < z && cur.at[j] === cur.at[j - 1] + 1) j++;
        const from = cur.at[i], to = cur.at[j - 1] + 1;
        tr.addMark(from, to, M.highlight.create({ color: INDICT_COLOR }));
        tr.addMark(from, to, M.underline.create());
        tr.removeMark(from, to, M.fontSize);
        i = j;
      }
    }
    // the tag last: it's above the body, so the body's places above held until now
    const newTag = r.tag.trim();
    if (o.retag && newTag && now.tag) tr.replaceWith(now.tag.pos + 1, now.tag.pos + now.tag.node.nodeSize - 1, schema.text(newTag));
    view.dispatch(tr);
    rep.done++; rep.indicts += says.length; rep.says.push(...says);
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
  return rep;
}
