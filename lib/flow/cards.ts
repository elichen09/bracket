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

/** The whole index of this account's library, or nothing at all. */
export async function library(owner?: string | null): Promise<Entry[]> {
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
    const index = await new Promise<Entry[]>((resolve) => {
      const req = db.transaction("kv", "readonly").objectStore("kv").get("index");
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });
    return index;
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** Words too common to tell one argument from another. */
const STOP = new Set(("a an and are as at be but by can for from had has have in into is it its no not " +
  "of on or our so than that the their them then they this to was were what when who why will with " +
  "would you your".split(" ")));

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

/**
 * Put a card in Evidence's send list, from the flow.
 *
 * Written straight into this account's Evidence database, so it is there the
 * next time Evidence opens; if Evidence is open in another tab, the caller
 * tells it over the bus and it redraws. The block is built by the same
 * function Evidence uses, so it lands exactly as if it had been sent there.
 */
export async function sendToEvidence(owner: string | null | undefined, hit: Hit): Promise<boolean> {
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
        const item = makeSendItem(block, hit.ai != null && hit.ai >= 0 ? hit.ai : null, includeHead);
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
