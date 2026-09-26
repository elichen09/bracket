/**
 * The cut file, read from the flow.
 *
 * Evidence keeps its library in this browser's IndexedDB, so the flow can
 * read it without the two tools knowing anything about each other: open the
 * same database, read the same index, never write. If Evidence has never been
 * used here the database simply has nothing in it, which is not an error —
 * it is a tool you have not used yet.
 *
 * What comes back is what you would want mid-round: the block, the argument
 * under it, and where it is filed, so a tag can go straight into the cell you
 * are flowing.
 */

import { scoped } from "../owner";
// @ts-ignore — a plain JS module shared with the Evidence engine
import { makeSendItem } from "../evidence/sendItem";

export interface Entry {
  id: string;
  /** Block title. */
  t: string;
  /** Its trigger, the thing you type to find it. */
  g: string;
  c1?: string;
  c2?: string;
  /** Argument titles — the tags. */
  a?: string[];
  n?: number;
}

export interface Hit {
  title: string;
  trigger: string;
  path: string;
  /** The line this puts in the flow. */
  text: string;
  /** The block it came from, and which argument in it (-1: the whole block). */
  id?: string;
  ai?: number;
  /** How many cards the block holds. */
  cards?: number;
}

/**
 * Evidence bins — the piles a library is sorted into, each in the round or
 * out of it. Blocks are filed by address (pocket | hat | title), the same key
 * Evidence uses, and a block in no bin is Unsorted (`loose`).
 */
export interface Bin { id: string; name: string; on: boolean }
export interface Bins { list: Bin[]; of: Record<string, string>; loose: boolean }
const tidy = (x?: string) => String(x || "").replace(/[\s​ ﻿]+/g, " ").trim();
const binKey = (e: Entry) => [tidy(e.c1), tidy(e.c2), tidy(e.t)].join("|");
function normalizeBins(b: any): Bins {
  const x = b && typeof b === "object" ? b : {};
  return {
    list: Array.isArray(x.list) ? x.list.filter((y: any) => y && y.id).map((y: any) => ({ id: y.id, name: String(y.name || "Bin"), on: y.on !== false })) : [],
    of: x.of && typeof x.of === "object" ? x.of : {},
    loose: x.loose !== false,
  };
}
/** Whether a block is in a bin that is in this round. */
export function inRound(bins: Bins, e: Entry) {
  const id = bins.of[binKey(e)];
  const b = id ? bins.list.find((x) => x.id === id) : undefined;
  return b ? b.on : bins.loose;
}

/** This account's bins, and how many blocks sit in each (Unsorted under ""). */
export async function readBins(owner?: string | null): Promise<{ bins: Bins; counts: Record<string, number> }> {
  const db = await openEvidence(owner);
  const empty = { bins: normalizeBins(null), counts: {} as Record<string, number> };
  if (!db) return empty;
  try {
    if (!db.objectStoreNames.contains("kv")) return empty;
    const [raw, index] = await new Promise<[any, Entry[]]>((resolve) => {
      const t = db.transaction("kv", "readonly");
      const a = t.objectStore("kv").get("bins");
      const b = t.objectStore("kv").get("index");
      t.oncomplete = () => resolve([a.result, Array.isArray(b.result) ? b.result : []]);
      t.onerror = () => resolve([null, []]);
    });
    const bins = normalizeBins(raw);
    const counts: Record<string, number> = {};
    index.forEach((e) => {
      const id = bins.of[binKey(e)];
      const k = id && bins.list.some((x) => x.id === id) ? id : "";
      counts[k] = (counts[k] || 0) + 1;
    });
    return { bins, counts };
  } catch { return empty; } finally { try { db.close(); } catch { /* closed */ } }
}

/** Put a bin in the round or take it out ("" is Unsorted). */
export async function setBinUse(owner: string | null | undefined, id: string, on: boolean): Promise<boolean> {
  const db = await openEvidence(owner);
  if (!db) return false;
  try {
    return await new Promise<boolean>((resolve) => {
      const t = db.transaction("kv", "readwrite");
      const st = t.objectStore("kv");
      const req = st.get("bins");
      req.onsuccess = () => {
        const bins = normalizeBins(req.result);
        if (id === "") bins.loose = on;
        else bins.list.forEach((b) => { if (b.id === id) b.on = on; });
        st.put(bins, "bins");
      };
      t.oncomplete = () => resolve(true);
      t.onerror = () => resolve(false);
    });
  } catch { return false; } finally { try { db.close(); } catch { /* closed */ } }
}

/**
 * The index of this account's library — only the blocks in bins that are in
 * this round, unless `all` — or nothing at all.
 */
export async function library(owner?: string | null, all = false): Promise<Entry[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(scoped("evidence", owner), 1); } catch { return resolve(null); }
    // Opening at the same version Evidence uses will not create the stores if
    // the database is not there; an upgrade means it was not.
    req.onupgradeneeded = () => { try { req.transaction?.abort(); } catch { /* nothing to abort */ } };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains("kv")) return [];
    const [index, raw] = await new Promise<[Entry[], any]>((resolve) => {
      const t = db.transaction("kv", "readonly");
      const a = t.objectStore("kv").get("index");
      const b = t.objectStore("kv").get("bins");
      t.oncomplete = () => resolve([Array.isArray(a.result) ? a.result : [], b.result]);
      t.onerror = () => resolve([[], null]);
    });
    if (all || !raw) return index;
    const bins = normalizeBins(raw);
    return index.filter((e) => inRound(bins, e));
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** Words too common to tell one argument from another. */
const STOP = new Set(("a an and are as at be but by can for from had has have in into is it its no not " +
  "of on or our so than that the their them then they this to was were what when who why will with " +
  "would you your").split(" "));

/** The words of a query that are worth matching on. */
export function termsOf(query: string): string[] {
  return String(query || "").toLowerCase()
    .replace(/\b(dropped|ext|turn|perm|nuq|xa|cx)\b/g, " ")
    .split(/[^a-z0-9$%]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * Blocks in the library, best match first — matched on the block's header
 * and its trigger, the way Evidence searches, not on the tags inside it.
 *
 * A block's header is what it is for ("AT: Tipping Points"), which is what
 * you are looking for when an argument needs answering; the tags underneath
 * are the answer, and matching on them turned up blocks that merely mention
 * the words. One result per block, and choosing it sends the whole block.
 *
 * Two kinds of query come in. One is typed — two or three words, and every
 * one of them should match. The other is the text of a cell on the flow —
 * "Tipping points = extinction" — when you ask for what answers it, and there
 * the right header shares some of those words and not all. So short queries
 * must match every word, long ones most of them, and the ranking does the rest.
 */
export function find(index: Entry[], query: string, max = 24): Hit[] {
  const terms = termsOf(query);
  if (!terms.length) return [];
  const need = terms.length <= 2 ? terms.length : Math.ceil(terms.length * 0.4);
  const out: (Hit & { score: number })[] = [];
  for (const e of index) {
    const head = (e.t || "").toLowerCase();
    const trig = (e.g || "").toLowerCase();
    const matched = terms.filter((t) => head.includes(t) || trig.includes(t)).length;
    if (matched < need) continue;
    const inHead = terms.filter((t) => head.includes(t)).length;
    const words = termsOf(e.t || "");
    out.push({
      title: e.t, trigger: e.g, path: [e.c1, e.c2].filter(Boolean).join(" › "), text: e.t,
      id: e.id, ai: -1, cards: e.n ?? (e.a || []).length,
      // Every word matched, then words in the header itself, then the header
      // that is mostly made of what was asked for.
      score: matched * 10 + inHead * 4 + (words.length ? (matched / words.length) * 6 : 0),
    });
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, max);
}

/** One card in a block: its tag, and whose card it is. */
export interface Tag { i: number; title: string; cite: string }

const runsText = (el: any) => (el && Array.isArray(el.runs) ? el.runs.map((r: any) => r.t || "").join("") : "").replace(/\s+/g, " ").trim();

async function openEvidence(owner?: string | null) {
  if (typeof indexedDB === "undefined") return null;
  return new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(scoped("evidence", owner), 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => { try { req.transaction?.abort(); } catch { /* nothing */ } };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/**
 * The cards in a block, to choose from: each argument's tag and the first
 * line under it, which is the cite. A block with no arguments has nothing to
 * choose between, and comes back empty.
 */
export async function blockTags(owner: string | null | undefined, id: string | undefined): Promise<Tag[]> {
  if (!id) return [];
  const db = await openEvidence(owner);
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains("blocks")) return [];
    const block = await new Promise<any>((resolve) => {
      const req = db.transaction("blocks", "readonly").objectStore("blocks").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    return ((block && block.args) || []).map((a: any, i: number) => ({
      i, title: String(a.title || runsText(a.head) || "(untitled)").trim(), cite: runsText((a.body || [])[0]).slice(0, 160),
    }));
  } catch { return []; } finally { try { db.close(); } catch { /* closed */ } }
}

/**
 * Put a card in Evidence's send list, from the flow.
 *
 * Written straight into this account's Evidence database, so it is there the
 * next time Evidence opens; if Evidence is open in another tab, the caller
 * tells it over the bus and it redraws. The block is built by the same
 * function Evidence uses, so it lands exactly as if it had been sent there.
 */
export async function sendToEvidence(owner: string | null | undefined, hit: Hit, picks?: number[]): Promise<boolean> {
  if (typeof indexedDB === "undefined" || !hit.id) return false;
  let includeHead = true;
  try {
    const s = localStorage.getItem(scoped("evidence.settings", owner));
    if (s) { const j = JSON.parse(s); if (typeof j.head === "boolean") includeHead = j.head; }
  } catch { /* defaults */ }

  const db = await new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(scoped("evidence", owner), 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => { try { req.transaction?.abort(); } catch { /* nothing */ } };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  if (!db) return false;
  try {
    return await new Promise<boolean>((resolve) => {
      const t = db.transaction(["kv", "blocks"], "readwrite");
      let ok = false;
      const blockReq = t.objectStore("blocks").get(hit.id as string);
      blockReq.onsuccess = () => {
        const block = blockReq.result;
        if (!block) return;
        const item = makeSendItem(block, picks && picks.length ? picks : hit.ai != null && hit.ai >= 0 ? hit.ai : null, includeHead);
        if (!item) return;
        const sendReq = t.objectStore("kv").get("send");
        sendReq.onsuccess = () => {
          const list = Array.isArray(sendReq.result) ? sendReq.result : [];
          list.push(item);
          t.objectStore("kv").put(list, "send");
          ok = true;
        };
      };
      t.oncomplete = () => resolve(ok);
      t.onerror = () => resolve(false);
      t.onabort = () => resolve(false);
    });
  } catch {
    return false;
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
}

/**
 * A block already in hand — a caselist card read out of its document — into
 * Evidence's send list, the way Evidence would put it there: a block already
 * in the list takes the card in (by block id) rather than a second copy of
 * the block turning up under the first. With `replace`, a card already there
 * under the same tag is swapped for this one (a card rehighlighted again)
 * rather than kept as it was.
 */
export async function sendBlockToEvidence(owner: string | null | undefined, block: any, argIndex: number | null, replace = false): Promise<boolean> {
  if (typeof indexedDB === "undefined" || !block) return false;
  let includeHead = true;
  try {
    const s = localStorage.getItem(scoped("evidence.settings", owner));
    if (s) { const j = JSON.parse(s); if (typeof j.head === "boolean") includeHead = j.head; }
  } catch { /* defaults */ }
  const item = makeSendItem(block, argIndex, includeHead);
  if (!item) return false;
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(scoped("evidence", owner), 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => { try { req.transaction?.abort(); } catch { /* nothing */ } };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  if (!db) return false;
  try {
    return await new Promise<boolean>((resolve) => {
      const t = db.transaction(["kv"], "readwrite");
      let ok = false;
      const sendReq = t.objectStore("kv").get("send");
      sendReq.onsuccess = () => {
        const list = Array.isArray(sendReq.result) ? sendReq.result : [];
        const same = item.blockId ? list.find((c: any) => c.blockId === item.blockId) : null;
        if (same) {
          const parts: any[] = same.parts || (same.parts = []);
          item.parts.forEach((p: any) => {
            const at = parts.findIndex((q: any) => q.title === p.title);
            if (at < 0) parts.push(p);
            else if (replace) parts[at] = { ...p, id: parts[at].id };
          });
        } else list.push(item);
        t.objectStore("kv").put(list, "send");
        ok = true;
      };
      t.oncomplete = () => resolve(ok);
      t.onerror = () => resolve(false);
      t.onabort = () => resolve(false);
    });
  } catch {
    return false;
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
}
