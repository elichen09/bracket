/**
 * What the caselist keeps in this browser: IndexedDB, one database per
 * account. `docs` are card bodies once fetched, `indexes` a wiki's index as
 * it was downloaded; a second database beside it holds each index's search,
 * built — so opening the tool again reads it back instead of building it.
 * Used by the page and by the worker that does the searching.
 */

const dbs = new Map();
function db(name, stores) {
  if (!dbs.has(name)) {
    dbs.set(name, new Promise((res, rej) => {
      const r = indexedDB.open(name, stores.v);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const [store, keyPath] of stores.list) if (!d.objectStoreNames.contains(store)) d.createObjectStore(store, { keyPath });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('blocked'));
    }));
  }
  return dbs.get(name);
}
const MAIN = { v: 2, list: [['docs', 'path'], ['indexes', 'wiki']] };
const BUILT = { v: 1, list: [['search', 'wiki']] };
const shape = (store) => (store === 'search' ? BUILT : MAIN);
const nameFor = (name, store) => (store === 'search' ? name + '.built' : name);

export async function kept(name, store, key) {
  try {
    const d = await db(nameFor(name, store), shape(store));
    return await new Promise((res) => {
      const q = d.transaction(store).objectStore(store).get(key);
      q.onsuccess = () => res(q.result || null); q.onerror = () => res(null);
    });
  } catch { return null; }
}

/** Keep a record; with `cap`, the oldest beyond that many go. */
export async function keep(name, store, rec, cap) {
  try {
    const d = await db(nameFor(name, store), shape(store));
    const s = d.transaction(store, 'readwrite').objectStore(store);
    s.put(rec);
    if (cap) {
      const all = s.getAllKeys();
      all.onsuccess = () => {
        const list = all.result || [];
        // card bodies are small and many: past the cap, the first ones in key order go
        if (list.length > cap) list.slice(0, list.length - cap).forEach((k) => s.delete(k));
      };
    }
  } catch { /* not kept; fetched again next time */ }
}
