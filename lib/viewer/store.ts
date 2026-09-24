import { scoped } from "@/lib/owner";

/**
 * The docs this account has opened in the Doc viewer, most recent first —
 * kept so the other team's speech doc from round 3 is still one click away
 * in round 5. IndexedDB, per account; a .docx or PDF is kept as the file
 * itself, anything else as its HTML. Only the last few are kept.
 */

export type DocKind = "html" | "docx" | "pdf" | "text";
export type Source = "room" | "speechdrop" | "file" | "paste";

export interface ViewDoc {
  id: string;
  name: string;
  kind: DocKind;
  source: Source;
  /** who sent it and when, for a partner's send doc or a SpeechDrop file */
  by?: string;
  at: number;
  html?: string;
  blob?: Blob;
}
export type ViewMeta = Omit<ViewDoc, "html" | "blob">;

const KEEP = 15;
const dbs = new Map<string, Promise<IDBDatabase>>();

function db(owner?: string | null) {
  const name = scoped("docviewer", owner);
  let p = dbs.get(name);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("docs", { keyPath: "id" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    dbs.set(name, p);
  }
  return p;
}

function tx<T>(owner: string | null | undefined, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db(owner).then((d) => new Promise((resolve, reject) => {
    const t = d.transaction("docs", mode);
    const r = fn(t.objectStore("docs"));
    t.oncomplete = () => resolve(r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

export async function listDocs(owner?: string | null): Promise<ViewMeta[]> {
  try {
    const all = (await tx<ViewDoc[]>(owner, "readonly", (s) => s.getAll())) || [];
    return all.sort((a, b) => b.at - a.at).map(({ html, blob, ...m }) => { void html; void blob; return m; });
  } catch { return []; }
}

export async function getDoc(owner: string | null | undefined, id: string) {
  try { return (await tx<ViewDoc>(owner, "readonly", (s) => s.get(id))) || null; } catch { return null; }
}

/** Keep a doc, and let go of the oldest past the limit. */
export async function keepDoc(owner: string | null | undefined, d: ViewDoc) {
  try {
    await tx(owner, "readwrite", (s) => { s.put(d); });
    const all = await listDocs(owner);
    const extra = all.slice(KEEP);
    if (extra.length) await tx(owner, "readwrite", (s) => { extra.forEach((x) => s.delete(x.id)); });
  } catch { /* storage refused: it is still open */ }
}

export async function dropDoc(owner: string | null | undefined, id: string) {
  try { await tx(owner, "readwrite", (s) => { s.delete(id); }); } catch { /* gone anyway */ }
}

export const newDocId = () => "v" + Math.random().toString(36).slice(2, 10);
