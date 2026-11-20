/**
 * Find blocks: answers to their argument, read out of your library.
 *
 *   1. Claude breaks their argument into its parts: the uniqueness, the
 *      link(s), the internal link, the impact. Each part gets the claim
 *      it makes and what an answer to it would say.
 *   2. coda chooses which blocks to hand over. If the whole library fits,
 *      Claude gets all of it. Otherwise it gets the blocks whose cards use
 *      the argument's words, taking the best few for each part in turn.
 *      This is a shortlist. Nothing is decided by titles.
 *   3. Claude reads the cards themselves (tag, cite, and the words that are
 *      read) and says which ones answer which part, and how: no link, link
 *      turn, non-unique, no impact, and so on. A card on the same topic
 *      doesn't count, and neither does one that agrees with them.
 *   4. For a part your library can't answer, coda looks in the caselist
 *      (only wikis already switched on and downloaded), the same way.
 *
 * Nothing leaves the browser except to Claude, on your own key.
 */
import { z } from "zod";
import { askJson, AiError } from "./claude";
import { stem, STOP } from "../caselist/search";

export interface LibCard { tag: string; cite: string; read: string }
export interface LibBlock { id: string; title: string; where: string; cards: LibCard[] }
export interface ClHit { tag: string; cite: string; block: string; team: string }

export interface LibPick { id: string; title: string; where: string; card: number | null; cardTag: string; how: string; why: string; fit: number }
export interface ClPick { tag: string; cite: string; team: string; how: string; why: string; fit: number }
export interface Part { kind: string; says: string; picks: LibPick[]; caselist: ClPick[] }
/** One of the answers to read: from the library (a LibPick) or the caselist (a ClPick), with the part of their argument it answers. */
export type Best = ((LibPick & { from: "library" }) | (ClPick & { from: "caselist" })) & { kind: string; says: string };
export interface Found { claim: string; parts: Part[]; best: Best[]; unanswered: string[]; read: number; of: number }

export interface Sources {
  /** every block in use, with its cards' words: EV.libraryText */
  library: () => Promise<LibBlock[]>;
  /** the caselist's cards for a search, or null when the caselist isn't there */
  caselist: ((q: string) => Promise<ClHit[]>) | null;
}

const KINDS = ["uniqueness", "link", "internal link", "impact", "solvency", "framework", "other"] as const;
const Breakdown = z.object({
  claim: z.string(),
  parts: z.array(z.object({
    kind: z.enum(KINDS),
    says: z.string(),
    answers: z.array(z.string()),
    words: z.array(z.string()),
  })),
});
type Broken = z.infer<typeof Breakdown>;
const Answers = z.object({
  answers: z.array(z.object({ part: z.number(), block: z.number(), card: z.number(), how: z.string(), why: z.string(), fit: z.number() })),
});

const GOOD = 6;              // an answer at least this good means the library has it
const PER_PART = 4;          // answers shown for each part
const BATCH_CHARS = 200_000; // one read of the library: about 60K tokens, under Haiku's cheaper 100K-token price tier
const BATCHES = 3;           // at most this many reads, side by side
const CARDS_SHOWN = 14;      // a block's cards Claude sees
const READ_SHOWN = 450;      // a card's read words Claude sees

function breakPrompt(arg: string): string {
  return `You're helping a policy debater answer the other team's argument. Here it is (their card or cards, a claim, or a note in the debater's own words):

"""
${arg.slice(0, 8000)}
"""

Break it into its parts, the way a debater flows it: the uniqueness, each link, any internal link, and the impact (or solvency or framework, if that's what it is). List only the parts it actually makes. A single link card is one part. Don't invent the rest. If the debater asked for something specific ("a link turn to their econ impact"), the part is what they want answered.

For each part:
- "kind": what the part is.
- "says": the claim it makes, in one short line.
- "answers": 2 to 4 lines, each one an answer a card could make, labeled the way debaters label them ("No link: the plan doesn't touch X", "Link turn: the plan increases Y", "Non-unique: Z is already happening", "No impact: ...", "Impact turn: ...", "Alt cause: ...").
- "words": 6 to 12 words or short phrases a card answering it would use: the argument's nouns, with their synonyms and opposites.

"claim": the whole argument in one line.`;
}

function blockText(b: LibBlock, n: number): string {
  const cards = b.cards.slice(0, CARDS_SHOWN).map((c, k) => {
    const read = c.read.length > READ_SHOWN ? c.read.slice(0, READ_SHOWN) + "…" : c.read;
    return `  ${k + 1}) ${c.tag.slice(0, 200)}${c.cite ? ` [${c.cite.slice(0, 70)}]` : ""}${read ? `\n     ${read}` : ""}`;
  });
  return `B${n}. "${b.title.slice(0, 120)}"${b.where ? ` (${b.where})` : ""}\n${cards.join("\n")}`;
}

function partsText(br: Broken): string {
  return br.parts.map((p, i) => `P${i + 1} (${p.kind}): ${p.says}\n   An answer would say: ${p.answers.join(" / ")}`).join("\n");
}

function judgePrompt(br: Broken, blocks: string): string {
  return `A policy debater has to answer this argument: ${br.claim}

Its parts:
${partsText(br)}

Below are blocks from the debater's own library: each block's title, then its cards, numbered from 1, each with its tag, its cite, and the words of it that get read.

${blocks}

Read the cards' words, not only the tags. A card answers a part only if what it says, read out in the round, answers that claim: it denies it, turns it, shows it's non-unique, mitigates or outweighs the impact, gives an alternate cause, and so on. A card that is only on the same topic doesn't count. A card that makes the same claim as the other team never counts.

"answers": every card here that answers a part, best first. Give at most ${PER_PART} for each part, and none for a part when nothing here answers it. For each one:
- "part": the part's P number.
- "block": the block's B number.
- "card": the card's number in that block. Use 0 only when the block as a whole is the answer (a block of answers to exactly this).
- "how": the kind of answer, in 1 to 3 words ("No link", "Link turn", "Non-unique", "No impact", "Impact turn", "Alt cause", "Defense").
- "why": one short line on what the card says that answers it.
- "fit": 0 to 10, how well it answers.`;
}

function clPrompt(br: Broken, parts: number[], hits: ClHit[]): string {
  return `A policy debater has to answer this argument: ${br.claim}

The parts their own library has no answer to:
${parts.map((i) => `P${i + 1} (${br.parts[i].kind}): ${br.parts[i].says}\n   An answer would say: ${br.parts[i].answers.join(" / ")}`).join("\n")}

Here are cards from the open caselist (other teams' disclosed evidence), each with a number, its tag, its cite, its block, and its team:
${hits.map((h, i) => `B${i + 1}. ${h.tag.slice(0, 180)} [${h.cite.slice(0, 80)}]${h.block ? ` (block: ${h.block.slice(0, 60)})` : ""} (${h.team})`).join("\n")}

"answers": the cards whose tags show they answer a part. Give at most 3 for each part, best first, and only cards that really answer it. For each one: "part" its P number, "block" the card's B number, "card" 0, "how" the kind of answer in 1 to 3 words, "why" one short line, "fit" 0 to 10.`;
}

/* ------------------------------------------------------------ the shortlist, when the library is more than Claude reads at once */

const wordsOf = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) || []).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);

/** Each block scored against each part, by the argument's words in its cards. Words in titles and tags count double, and rare words count for more. */
function rank(blocks: LibBlock[], br: Broken): number[][] {
  const parts = br.parts.map((p) => {
    const w = new Map<string, number>();
    for (const x of wordsOf(p.says + " " + p.answers.join(" "))) w.set(x, Math.max(w.get(x) || 0, 1));
    for (const x of wordsOf(p.words.join(" "))) w.set(x, 1.5);
    return w;
  });
  const asked = new Set(parts.flatMap((m) => [...m.keys()]));
  const seen = blocks.map((b) => {
    const head = new Set<string>(), body = new Set<string>();
    for (const x of wordsOf(b.title + " " + b.cards.map((c) => c.tag).join(" "))) if (asked.has(x)) head.add(x);
    for (const x of wordsOf(b.cards.map((c) => c.read).join(" "))) if (asked.has(x)) body.add(x);
    return { head, body };
  });
  const df = new Map<string, number>();
  for (const s of seen) for (const x of new Set([...s.head, ...s.body])) df.set(x, (df.get(x) || 0) + 1);
  const idf = (x: string) => Math.log(1 + blocks.length / (df.get(x) || 1));
  return parts.map((w) => seen.map((s) => {
    let score = 0;
    for (const [x, wt] of w) score += s.head.has(x) ? 2 * wt * idf(x) : s.body.has(x) ? wt * idf(x) : 0;
    return score;
  }));
}

/** The blocks Claude reads: all of them if they fit, else the best for each part in turn, as many as fit. */
function shortlist(blocks: LibBlock[], br: Broken): LibBlock[] {
  const size = blocks.map((b, i) => blockText(b, i + 1).length + 2);
  const room = BATCH_CHARS * BATCHES;
  if (size.reduce((a, b) => a + b, 0) <= room) return blocks;
  const scores = rank(blocks, br);
  const orders = scores.map((s) => s.map((v, i) => [v, i] as const).filter(([v]) => v > 0).sort((a, b) => b[0] - a[0]).map(([, i]) => i));
  const take = new Set<number>();
  let used = 0;
  for (let k = 0, more = true; more; k++) {
    more = false;
    for (const o of orders) {
      if (k >= o.length) continue;
      more = true;
      const i = o[k];
      if (take.has(i) || used + size[i] > room) continue;
      take.add(i); used += size[i];
    }
  }
  return [...take].map((i) => blocks[i]);
}

/** The shortlist cut into reads that each fit. */
function batches(blocks: LibBlock[]): LibBlock[][] {
  const out: LibBlock[][] = [];
  let cur: LibBlock[] = [], used = 0;
  for (const b of blocks) {
    const n = blockText(b, cur.length + 1).length + 2;
    if (cur.length && used + n > BATCH_CHARS) { out.push(cur); cur = []; used = 0; }
    cur.push(b); used += n;
  }
  if (cur.length) out.push(cur);
  return out.slice(0, BATCHES);
}

const clamp = (x: number) => Math.max(0, Math.min(10, Math.round(x)));

export async function findBlocks(
  key: string, arg: string, src: Sources, signal?: AbortSignal,
  onStage?: (s: string) => void,
): Promise<Found> {
  if (!arg.trim()) throw new AiError("Select their argument, or paste it in, first.");
  onStage?.("Breaking down their argument…");
  const libP = src.library();
  const br = await askJson(key, breakPrompt(arg), Breakdown, signal);
  if (!br.parts.length) throw new AiError("Claude couldn't find an argument in that. Select their cards, or say what you need answered.");
  const all = await libP;
  const out: Found = { claim: br.claim, parts: br.parts.map((p) => ({ kind: p.kind, says: p.says, picks: [], caselist: [] })), best: [], unanswered: [], read: 0, of: all.length };

  // the library, read
  if (all.length) {
    const list = batches(shortlist(all, br));
    out.read = list.reduce((n, b) => n + b.length, 0);
    onStage?.(`Reading ${out.read === all.length ? "all " : ""}${out.read} block${out.read === 1 ? "" : "s"}${out.read < all.length ? " of " + all.length : ""}…`);
    const runs = await Promise.allSettled(list.map((bs) =>
      askJson(key, judgePrompt(br, bs.map((b, i) => blockText(b, i + 1)).join("\n\n")), Answers, signal).then((r) => ({ bs, r }))));
    if (signal?.aborted) throw new AiError("Stopped.");
    const ok = runs.filter((x): x is PromiseFulfilledResult<{ bs: LibBlock[]; r: z.infer<typeof Answers> }> => x.status === "fulfilled");
    if (!ok.length) throw (runs[0] as PromiseRejectedResult).reason;
    for (const { value: { bs, r } } of ok) {
      for (const a of r.answers) {
        const part = out.parts[Math.round(a.part) - 1], b = bs[Math.round(a.block) - 1];
        if (!part || !b) continue;
        const c = Math.round(a.card) - 1;
        const card = c >= 0 && c < Math.min(b.cards.length, CARDS_SHOWN) ? c : null;
        if (part.picks.some((p) => p.id === b.id && p.card === card)) continue;
        part.picks.push({ id: b.id, title: b.title, where: b.where, card, cardTag: card === null ? "" : b.cards[card].tag, how: a.how, why: a.why, fit: clamp(a.fit) });
      }
    }
    for (const p of out.parts) p.picks = p.picks.sort((a, b) => b.fit - a.fit).slice(0, PER_PART);
  }

  // the parts the library has no good answer to: the caselist, if it's there
  const open = out.parts.map((p, i) => (p.picks.some((x) => x.fit >= GOOD) ? -1 : i)).filter((i) => i >= 0);
  if (src.caselist && open.length) {
    onStage?.("Looking in the caselist…");
    const seen = new Set<string>(), cards: ClHit[] = [];
    for (const i of open) {
      const p = br.parts[i];
      for (const q of [p.words.slice(0, 3).join(" "), p.answers[0]?.replace(/^[^:]{1,20}:\s*/, "").split(/\s+/).slice(0, 5).join(" ")]) {
        if (!q?.trim()) continue;
        for (const c of await src.caselist(q)) {
          const k = c.tag + "|" + c.cite;
          if (seen.has(k)) continue;
          seen.add(k); cards.push(c);
        }
      }
    }
    if (cards.length) {
      const hits = cards.slice(0, 40);
      const r = await askJson(key, clPrompt(br, open, hits), Answers, signal);
      for (const a of r.answers) {
        const i = Math.round(a.part) - 1, c = hits[Math.round(a.block) - 1];
        if (!open.includes(i) || !c) continue;
        const part = out.parts[i];
        if (part.caselist.length < 3) part.caselist.push({ tag: c.tag, cite: c.cite, team: c.team, how: a.how, why: a.why, fit: clamp(a.fit) });
      }
    }
  }

  // of everything found, the few to read: the best 3, a 4th only when it's key
  const found: Best[] = out.parts.flatMap((p) => [
    ...p.picks.map((x) => ({ ...x, kind: p.kind, says: p.says, from: "library" as const })),
    ...p.caselist.map((x) => ({ ...x, kind: p.kind, says: p.says, from: "caselist" as const })),
  ]);
  out.unanswered = out.parts.filter((p) => !p.picks.length && !p.caselist.length).map((p) => p.kind);
  if (found.length <= 3) { out.best = found.sort((a, b) => b.fit - a.fit); return out; }
  onStage?.("Choosing the best answers…");
  try {
    const r = await askJson(key, choosePrompt(br, found), Choice, signal);
    const seen = new Set<number>();
    out.best = r.picks.map((n) => Math.round(n) - 1).filter((i) => found[i] && !seen.has(i) && (seen.add(i), true)).slice(0, 4).map((i) => found[i]);
  } catch (e) {
    if (signal?.aborted) throw e;
    out.best = [];
  }
  // Claude chose none, or couldn't be asked: the strongest, one per part first
  if (!out.best.length) {
    const byFit = [...found].sort((a, b) => b.fit - a.fit), kinds = new Set<string>();
    for (const x of byFit) if (!kinds.has(x.kind) && out.best.length < 3) { kinds.add(x.kind); out.best.push(x); }
    for (const x of byFit) if (out.best.length < 3 && !out.best.includes(x)) out.best.push(x);
  }
  return out;
}

const Choice = z.object({ picks: z.array(z.number()) });

function choosePrompt(br: Broken, found: Best[]): string {
  return `A policy debater has to answer this argument: ${br.claim}

Its parts:
${partsText(br)}

These answers were found in their evidence, numbered:
${found.map((a, i) => `${i + 1}. [${a.kind}] ${a.how}: "${(a.from === "library" ? a.cardTag || a.title : a.tag).slice(0, 180)}" (${a.why}; fit ${a.fit}/10${a.from === "caselist" ? "; from the caselist" : ""})`).join("\n")}

Choose what they should actually read: the best 3, as a set. Pick the strongest answers. Prefer a set that does more together: offense (a turn) alongside defense, or answers to different parts, over two answers that make the same point. Choose a 4th only if it's a key answer the set would be clearly weaker without. Otherwise choose exactly 3.

"picks": their numbers, best first.`;
}
