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

/**
 * Every argument whose tag, block or trigger carries all of the words typed.
 *
 * Not the fuzzy search Evidence does — in a round you know what you are
 * looking for and you have twenty seconds, so this is the plain one.
 */
export function find(index: Entry[], query: string, max = 24): Hit[] {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out: Hit[] = [];
  for (const e of index) {
    const path = [e.c1, e.c2].filter(Boolean).join(" › ");
    const args = e.a && e.a.length ? e.a : [e.t];
    for (const a of args) {
      const hay = `${a} ${e.t} ${e.g} ${path}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      out.push({ title: a || e.t, trigger: e.g, path, text: a || e.t });
      if (out.length >= max) return out;
    }
  }
  return out;
}
