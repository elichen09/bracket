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
 *   4. Claude reads each candidate's whole card, quotes the words that
 *      answer, and coda checks the quote is in the card.
 *   5. Whatever the library can't answer, coda looks for in the caselist
 *      (the wikis chosen in its search), checked the same way.
 *   6. Nothing answers it at all: Claude writes analytics, and coda
 *      rehighlights their cards for indicts when they're in the doc.
 *
 * Nothing leaves the browser except to Claude, on your own key.
 */
import { z } from "zod";
import { askJson, AiError } from "./claude";
import { find } from "./reformat";
import { stem, STOP } from "../caselist/search";

export interface LibCard { tag: string; cite: string; read: string }
export interface LibBlock { id: string; title: string; where: string; cards: LibCard[] }
export interface ClHit { tag: string; cite: string; block: string; team: string }

export interface LibPick { id: string; title: string; where: string; card: number | null; cardTag: string; how: string; why: string; fit: number }
export interface ClPick { tag: string; cite: string; team: string; how: string; why: string; fit: number }
export interface Part { kind: string; says: string; picks: LibPick[]; caselist: ClPick[] }
/** One of the answers to read: from the library (a LibPick) or the caselist (a ClPick), with the part of their argument it answers. */
export type Best = ((LibPick & { from: "library" }) | (ClPick & { from: "caselist" })) & { kind: string; says: string; quote?: string };
export interface Found {
  claim: string; parts: Part[]; best: Best[]; unanswered: string[]; read: number; of: number;
  /** the caselist, when the library fell short: looked through, looked through with nothing found, or not there (not signed in) */
  caselist?: "searched" | "nothing" | "off";
  /** when nothing answers it: arguments to make without a card */
  analytics?: Analytic[];
}
/** An argument to make without a card: the part of theirs it answers, how, and what to say. */
export interface Analytic { kind: string; how: string; text: string }

export interface Sources {
  /** every block in use, with its cards' words: EV.libraryText */
  library: () => Promise<LibBlock[]>;
  /** the caselist's cards for a search (answer: cards that argue against q), or null when the caselist isn't there */
  caselist: ((q: string, answer: boolean) => Promise<ClHit[]>) | null;
}

const KINDS = ["uniqueness", "link", "internal link", "impact", "solvency", "framework", "other"] as const;
const Breakdown = z.object({
  claim: z.string(),
  about: z.string(),
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

const PER_PART = 6;          // candidates kept for each part, for the careful check
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

"claim": the whole argument in one line.
"about": exactly what it's about, so a card about something else that shares its words isn't taken for an answer: who does what, which policy or program, where ("France extending its nuclear umbrella to Greece, 2026", not "nuclear deterrence").`;
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
What it is about, exactly: ${br.about}

Its parts:
${partsText(br)}

Below are blocks from the debater's own library: each block's title, then its cards, numbered from 1, each with its tag, its cite, and the words of it that get read.

${blocks}

This is a first pass: every candidate gets checked again closely, so list the cards that plausibly answer a part. Read the cards' words, not only the tags. A card answers a part only if what it says, read out in the round, answers that claim: it denies it, turns it, shows it's non-unique, mitigates or outweighs the impact, gives an alternate cause, and so on. It must be about the same thing their argument is about; a card that only shares its words (a different country, program or law) doesn't count. A card that is only on the same topic doesn't count. A card that makes the same claim as the other team never counts.

"answers": the cards here that may answer a part, best first. Give at most ${PER_PART} for each part, and none for a part when nothing here answers it. For each one:
- "part": the part's P number.
- "block": the block's B number.
- "card": the card's number in that block. Use 0 only when the block as a whole is the answer (a block of answers to exactly this).
- "how": the kind of answer, in 1 to 3 words ("No link", "Link turn", "Non-unique", "No impact", "Impact turn", "Alt cause", "Defense").
- "why": one short line on what the card says that answers it.
- "fit": 0 to 10, how well it answers.`;
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
  const br = await askJson(key, breakPrompt(arg), Breakdown, signal, "medium");
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

  // the library's candidates, each checked against its card
  const fromLib: Best[] = out.parts.flatMap((p) => p.picks.map((x) => ({ ...x, kind: p.kind, says: p.says, from: "library" as const })))
    .sort((a, b) => b.fit - a.fit).slice(0, VERIFY_MAX);
  const lib = fromLib.length ? await check(fromLib) : { ok: [] as Best[], picks: [] as Best[] };
  out.best = lib.picks;

  // what the library couldn't answer — all of it, or some parts — looked for in the caselist, and checked the same way
  const answered = new Set(lib.ok.map((x) => x.kind));
  const open = br.parts.map((p, i) => i).filter((i) => !answered.has(br.parts[i].kind));
  if (open.length && out.best.length < 3) {
    if (!src.caselist) out.caselist = "off";
    else {
      onStage?.("Looking in the caselist…");
      const seen = new Set<string>(), cards: ClHit[] = [];
      const add = (list: ClHit[]) => { for (const c of list) { const k = c.tag + "|" + c.cite; if (!seen.has(k)) { seen.add(k); cards.push(c); } } };
      for (const i of open) {
        const p = br.parts[i];
        // the caselist's own Answer search (cards that argue against the claim), then the words an answer would use
        add(await src.caselist(p.says, true));
        for (const q of [p.words.slice(0, 3).join(" "), p.answers[0]?.replace(/^[^:]{1,20}:\s*/, "").split(/\s+/).slice(0, 5).join(" ")]) if (q?.trim()) add(await src.caselist(q, false));
      }
      out.caselist = cards.length ? "searched" : "nothing";
      if (cards.length) {
        const fromCl: Best[] = cards.slice(0, VERIFY_MAX).map((c) => ({ ...c, how: "", why: "", fit: 5, kind: br.parts[open[0]].kind, says: br.parts[open[0]].says, from: "caselist" as const }));
        const cl = await check(fromCl);
        lib.ok.push(...cl.ok);
        for (const x of cl.picks) if (out.best.length < 3) out.best.push(x);
      }
    }
  }
  const got = new Set(lib.ok.map((x) => x.kind));
  out.unanswered = out.parts.map((p) => p.kind).filter((k, i, a) => !got.has(k) && a.indexOf(k) === i);
  // no card answers it: analytics instead
  if (!out.best.length) {
    onStage?.("Writing analytics…");
    try { out.analytics = await writeAnalytics(key, br, arg, signal); }
    catch (e) { if (signal?.aborted) throw e; out.analytics = []; }
  }
  return out;

  /** Candidates checked closely against their cards: the ones whose quoted words are really there, and the best few to read. */
  async function check(cands: Best[]): Promise<{ ok: Best[]; picks: Best[] }> {
    onStage?.(`Checking ${cands.length} answer${cands.length === 1 ? "" : "s"} against the cards…`);
    const texts = cands.map((c) => candidateText(c, all));
    const r = await askJson(key, verifyPrompt(br, cands, texts), Verified, signal, "medium");
    const ok = new Map<number, Best>();
    for (const v of r.checks) {
      const i = Math.round(v.n) - 1, c = cands[i];
      if (!c || !v.answers || !v.quote.trim()) continue;
      // the quote has to be in the card, word for word: an answer Claude can't point to isn't one
      if (!find({ s: texts[i] }, [v.quote]).ranges.length) continue;
      const part = br.parts[Math.round(v.part) - 1];
      ok.set(i, { ...c, kind: part ? part.kind : c.kind, says: part ? part.says : c.says, how: v.how || c.how, why: v.why || c.why, quote: v.quote.trim(), fit: clamp(v.fit) });
    }
    const seen = new Set<number>();
    let picks = r.picks.map((n) => Math.round(n) - 1).filter((i) => ok.has(i) && !seen.has(i) && (seen.add(i), true)).slice(0, 4).map((i) => ok.get(i)!);
    if (!picks.length) picks = [...ok.values()].sort((a, b) => b.fit - a.fit).slice(0, 3);
    return { ok: [...ok.values()], picks };
  }
}

const VERIFY_MAX = 20;         // candidates checked closely
const VERIFY_READ = 1400;      // a candidate card's read words, in full or nearly

const Verified = z.object({
  checks: z.array(z.object({ n: z.number(), answers: z.boolean(), part: z.number(), how: z.string(), quote: z.string(), why: z.string(), fit: z.number() })),
  picks: z.array(z.number()),
});

/** A candidate's text as Claude checks it: the block, the card's tag and cite, and its read words (or, for a whole block, its cards' tags). */
function candidateText(c: Best, all: LibBlock[]): string {
  if (c.from === "caselist") return `${c.tag}\n[${c.cite}] (caselist, ${c.team})`;
  const b = all.find((x) => x.id === c.id);
  if (!b) return c.cardTag || c.title;
  if (c.card === null) return `Block "${b.title}":\n` + b.cards.slice(0, 12).map((x) => "- " + x.tag).join("\n");
  const card = b.cards[c.card];
  const read = card.read.length > VERIFY_READ ? card.read.slice(0, VERIFY_READ) + "…" : card.read;
  return `${card.tag}\n[${card.cite.slice(0, 160)}]\n${read}`;
}

function verifyPrompt(br: Broken, cands: Best[], texts: string[]): string {
  return `A policy debater has to answer the other team's argument. Their argument: ${br.claim}
What it is about, exactly: ${br.about}

Its parts:
${partsText(br)}

A first, quick pass through the debater's evidence found these candidate answers. Many will be wrong. Each has a number, the block it's filed in, the card's tag, its cite, and the words of the card that get read:

${cands.map((c, i) => `C${i + 1}.${c.from === "library" ? ` (block: "${c.title.slice(0, 100)}"${c.where ? `, ${c.where}` : ""})` : ""}\n${texts[i]}`).join("\n\n")}

Check each candidate strictly, the way a good debater or judge would:
- It must be about the same thing as their argument: the same actors, policy, place and mechanism. Shared words are not enough. A US bill called the "Forward Deterrence Act" is not France's forward deterrence; NATO in general is not French extended deterrence.
- What the card says must answer a part of their argument when read in the round: deny it, turn it, prove it non-unique, mitigate or outweigh the impact, or give an alternate cause. A card that agrees with them, makes their argument, or only describes the topic does not answer it.
- Judge by what the card's words actually say, not by its tag alone.

"checks": one for every candidate:
- "n": its C number.
- "answers": true only if it really answers a part.
- "part": the part's P number it answers (0 if none).
- "how": the kind of answer, in 1 to 3 words ("No link", "Link turn", "Non-unique", "No impact", "Impact turn", "Alt cause").
- "quote": the words in the card that do the answering, copied exactly from the text above as one unbroken stretch of 5 to 40 words. Use "" if it doesn't answer.
- "why": one short line: how those words answer their claim.
- "fit": 0 to 10.

"picks": of the candidates that answer, the C numbers of the 3 the debater should actually read, as a set, best first. Prefer a set that does more together (offense with defense, or different parts) over two that make the same point. Add a 4th only if the set would be clearly weaker without it. Pick fewer if fewer answer.`;
}

const Analytics = z.object({ analytics: z.array(z.object({ part: z.number(), how: z.string(), text: z.string() })) });

/** Nothing in the library or the caselist answers it: the arguments a debater can make without a card. */
async function writeAnalytics(key: string, br: Broken, arg: string, signal?: AbortSignal): Promise<Analytic[]> {
  const r = await askJson(key, `A policy debater has to answer the other team's argument, and neither their own evidence nor the caselist has a card that answers it. Write analytics: arguments they can make out loud without a card.

Their argument: ${br.claim}
What it is about, exactly: ${br.about}

Its parts:
${partsText(br)}

What they read (their tags and cards):
"""
${arg.slice(0, 6000)}
"""

Write 3 to 5 analytics, strongest first. Each must be specific to this argument: name the warrant it attacks and say what's wrong with it. Point to what their own evidence says or fails to say where you can. Assume the link where it matters: an analytic that only works if their link is false is weaker than one that holds either way. Don't state facts, numbers or events you aren't sure of; analytics rest on logic, on their own evidence's words, and on well-known facts.

"analytics": for each:
- "part": the P number of the part it answers.
- "how": the kind of answer, in 1 to 3 words ("No link", "Link turn", "Non-unique", "No impact", "Impact turn", "Alt cause", "Indict", "Defense").
- "text": the analytic as the debater would say it in the round: one or two sentences, under 35 words. No filler and no "they say".`, Analytics, signal, "medium");
  return r.analytics.filter((a) => a.text.trim()).slice(0, 5).map((a) => {
    const p = br.parts[Math.round(a.part) - 1];
    return { kind: p ? p.kind : "", how: a.how.trim(), text: a.text.trim() };
  });
}
