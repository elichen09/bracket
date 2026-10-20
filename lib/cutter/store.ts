import { scoped } from "../owner";

/**
 * The card cutter's files, kept in this browser — IndexedDB, one database per
 * account (lib/owner.ts), like every other tool.
 *
 * A file is kept three ways at once, each for whoever reads it: the document
 * itself (ProseMirror's JSON, which is what the cutter opens), its HTML (what
 * Evidence reads to put the file in its library, and what a .docx is made
 * from), and its cards in brief — tag, cite, block, the words that are read —
 * so searching every file never has to open any of them.
 */

export interface CardBrief {
  /** Which tag in the file this is, counting from 0, so a search hit can scroll to it. */
  i: number;
  tag: string;
  cite: string;
  block: string;
  /** The underlined and highlighted words — what the card is actually about. */
  read: string;
}

export interface CutFile {
  id: string;
  name: string;
  doc: unknown;          // ProseMirror JSON
  html: string;
  cards: CardBrief[];
  words: number;
  created: number;
  updated: number;
}

export type CutMeta = Omit<CutFile, "doc" | "html">;

const STORE = "files";
export const cutterDbName = (owner?: string | null) => scoped("cutter", owner);

const dbs = new Map<string, Promise<IDBDatabase>>();
function open(owner?: string | null): Promise<IDBDatabase> {
  const name = cutterDbName(owner);
  let p = dbs.get(name);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbs.delete(name); reject(req.error); };
    });
    dbs.set(name, p);
  }
  return p;
}

function run<T>(owner: string | null | undefined, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return open(owner).then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve((req ? req.result : undefined) as T);
    t.onerror = () => reject(t.error);
  }));
}

/** Every file, whole. */
export const allFiles = (owner?: string | null) => run<CutFile[]>(owner, "readonly", (s) => s.getAll()).then((l) => l || []);

/** Every file without its document, newest first — the list and the search need no more. */
export async function listFiles(owner?: string | null): Promise<CutMeta[]> {
  const all = await allFiles(owner);
  return all.map(({ doc: _d, html: _h, ...m }) => m).sort((a, b) => b.updated - a.updated);
}

export const getFile = (owner: string | null | undefined, id: string) => run<CutFile | undefined>(owner, "readonly", (s) => s.get(id));
export const putFile = (owner: string | null | undefined, f: CutFile) => run<void>(owner, "readwrite", (s) => s.put(f));
export const dropFile = (owner: string | null | undefined, id: string) => run<void>(owner, "readwrite", (s) => s.delete(id));

export const newFileId = () => "cut_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
