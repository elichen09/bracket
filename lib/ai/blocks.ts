/**
 * Find blocks: the best one to three blocks in your library — and the best
 * card in each — for what you need, chosen by Claude; the caselist looked
 * through only when the library has nothing that does the job.
 *
 *   1. Claude reads what's needed (their card, a claim, "a link turn to
 *      their econ impact") and writes the searches a debater would type.
 *   2. coda's own library search runs them (EV.quickFind): the bins in use,
 *      what each block's cards say — nothing is sent anywhere but Claude.
 *   3. Claude picks from what came back, with a line on why each, or says
 *      nothing fits. Only blocks that were found can be picked.
 *   4. Nothing fits, and the caselist is there: the same, over the caselist's
 *      cards (only wikis already switched on and downloaded).
 */
import { z } from "zod";
import { askJson, AiError } from "./claude";

export interface LibHit { id: string; title: string; where: string; args: string[] }
export interface ClHit { tag: string; cite: string; block: string; team: string }

export interface LibPick { id: string; title: string; where: string; card: number | null; cardTag: string; why: string; fit: number }
export interface ClPick { tag: string; cite: string; team: string; why: string; fit: number }
export interface Found { need: string; picks: LibPick[]; caselist: ClPick[]; note: string; searched: string[] }

export interface Sources {
  /** the library search: EV.quickFind */
  library: (q: string, max: number) => LibHit[];
  /** the caselist's cards for a search, or null when the caselist isn't there */
  caselist: ((q: string) => Promise<ClHit[]>) | null;
}

const Searches = z.object({ need: z.string(), searches: z.array(z.string()) });
const Picks = z.object({
  picks: z.array(z.object({ n: z.number(), card: z.number(), why: z.string(), fit: z.number() })),
  note: z.string(),
});

const GOOD = 6;          // a pick at least this good means the library has it

function searchPrompt(want: string): string {
  return `A debater needs evidence from their own library of blocks. Here is what they're working with — usually the other team's argument, which they want to answer, or a request in their own words:

"""
${want.slice(0, 6000)}
"""

Write:
- "need": one line saying what evidence would do the job (e.g. "answers to: econ decline causes war", or "a link turn: growth makes war less likely").
- "searches": 4–6 short searches they'd type into their library to find it, 1–4 words each: the block titles debaters write ("AT: econ decline", "econ resilient", "no war"), the key nouns, the impact, the opposite claim. Most likely first.`;
}

function libPrompt(need: string, hits: LibHit[]): string {
  return `A debater needs: ${need}

Here are blocks from their library. Each has a number, a title, where it is filed, and its cards (taglines, numbered from 1):
${hits.map((h, i) => `${i + 1}. "${h.title}"${h.where ? ` (${h.where})` : ""}\n${h.args.slice(0, 12).map((a, k) => `   ${k + 1}) ${a.slice(0, 140)}`).join("\n")}`).join("\n")}

Pick the blocks that best do the job — at most 3, best first, and only ones that really do it (return none if none does). For each: "n" its number; "card" the number of its single best card for this, or 0 if the whole block is what's needed; "why" one short line a debater would want ("answers the link: growth reduces conflict risk"); "fit" 0–10 for how well it does the job. "note": one line on what's still missing, or "" if nothing is.`;
}

function clPrompt(need: string, hits: ClHit[]): string {
  return `A debater needs: ${need}

Their own library has nothing that does it. Here are cards from the open caselist — other teams' disclosed evidence — each with a number, its tag, cite, block and team:
${hits.map((h, i) => `${i + 1}. ${h.tag.slice(0, 160)} — ${h.cite.slice(0, 80)}${h.block ? ` [block: ${h.block.slice(0, 60)}]` : ""} (${h.team})`).join("\n")}

Pick the cards that best do the job — at most 3, best first, only ones that really do it. For each: "n" its number, "card" 0, "why" one short line, "fit" 0–10. "note": one line on what's still missing, or "".`;
}

export async function findBlocks(key: string, want: string, src: Sources, signal?: AbortSignal): Promise<Found> {
  if (!want.trim()) throw new AiError("Select their card or a claim — or type what you need — first.");
  const s = await askJson(key, searchPrompt(want), Searches, signal);
  const searched = s.searches.map((q) => q.trim()).filter(Boolean).slice(0, 6);

  // the library, by every search: each block once, ranked by how early and how often it came up
  const score = new Map<string, { hit: LibHit; score: number }>();
  for (const [qi, q] of [s.need, ...searched].entries()) {
    src.library(q, 8).forEach((h, rank) => {
      const add = (8 - rank) * (qi === 0 ? 1 : 1.5 - qi * 0.1);
      const was = score.get(h.id);
      if (was) was.score += add; else score.set(h.id, { hit: h, score: add });
    });
  }
  const hits = [...score.values()].sort((a, b) => b.score - a.score).slice(0, 24).map((x) => x.hit);

  const out: Found = { need: s.need, picks: [], caselist: [], note: "", searched };
  if (hits.length) {
    const p = await askJson(key, libPrompt(s.need, hits), Picks, signal);
    for (const x of p.picks.slice(0, 3)) {
      const h = hits[Math.round(x.n) - 1];
      if (!h || out.picks.some((y) => y.id === h.id)) continue;
      const c = Math.round(x.card) - 1;
      const card = c >= 0 && c < h.args.length ? c : null;
      out.picks.push({ id: h.id, title: h.title, where: h.where, card, cardTag: card === null ? "" : h.args[card], why: x.why, fit: Math.max(0, Math.min(10, Math.round(x.fit))) });
    }
    out.note = p.note;
  }

  // nothing good enough in the library: the caselist, if it's there
  if (src.caselist && !out.picks.some((x) => x.fit >= GOOD)) {
    const seen = new Set<string>(), cards: ClHit[] = [];
    for (const q of searched.slice(0, 3)) {
      for (const c of await src.caselist(q)) {
        const k = c.tag + "|" + c.cite;
        if (seen.has(k)) continue;
        seen.add(k); cards.push(c);
      }
    }
    if (cards.length) {
      const p = await askJson(key, clPrompt(s.need, cards.slice(0, 24)), Picks, signal);
      for (const x of p.picks.slice(0, 3)) {
        const c = cards[Math.round(x.n) - 1];
        if (c) out.caselist.push({ tag: c.tag, cite: c.cite, team: c.team, why: x.why, fit: Math.max(0, Math.min(10, Math.round(x.fit))) });
      }
      if (!out.picks.length) out.note = p.note || out.note;
    }
  }
  return out;
}
