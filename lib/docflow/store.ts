import { scoped } from "../owner";

/**
 * The flows an account keeps — one per round, as the Docs they replace were.
 *
 * Kept in this browser, apart per account like the other tools: a list of
 * names and when each was last touched, and each flow's document on its own
 * key so that opening one never reads the rest.
 */

export interface DocMeta { id: string; name: string; updated: number }

const listKey = (owner?: string | null) => scoped("docflow.list", owner);
const docKey = (owner: string | null | undefined, id: string) => scoped("docflow.doc", owner) + ":" + id;

export const newId = () => "d" + Math.random().toString(36).slice(2, 10);

export function listDocs(owner?: string | null): DocMeta[] {
  try {
    const raw = localStorage.getItem(listKey(owner));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.sort((a, b) => b.updated - a.updated) : [];
  } catch { return []; }
}
function writeList(owner: string | null | undefined, list: DocMeta[]) {
  try { localStorage.setItem(listKey(owner), JSON.stringify(list)); } catch { /* private browsing */ }
}

export function loadDoc(owner: string | null | undefined, id: string): unknown | null {
  try { const raw = localStorage.getItem(docKey(owner, id)); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export function saveDoc(owner: string | null | undefined, id: string, json: unknown, name?: string) {
  try { localStorage.setItem(docKey(owner, id), JSON.stringify(json)); } catch { /* private browsing */ }
  const list = listDocs(owner);
  const at = list.findIndex((d) => d.id === id);
  if (at >= 0) { list[at].updated = Date.now(); if (name) list[at].name = name; }
  else list.push({ id, name: name || "Untitled flow", updated: Date.now() });
  writeList(owner, list);
}

export function renameDoc(owner: string | null | undefined, id: string, name: string) {
  const list = listDocs(owner);
  const d = list.find((x) => x.id === id);
  if (d) { d.name = name; writeList(owner, list); }
}

/** Removes it, and hands back what it was so it can be put back. */
export function removeDoc(owner: string | null | undefined, id: string): { meta: DocMeta; json: unknown } | null {
  const list = listDocs(owner);
  const meta = list.find((d) => d.id === id);
  if (!meta) return null;
  const json = loadDoc(owner, id);
  writeList(owner, list.filter((d) => d.id !== id));
  try { localStorage.removeItem(docKey(owner, id)); } catch { /* private browsing */ }
  return { meta, json };
}

export function restoreDoc(owner: string | null | undefined, meta: DocMeta, json: unknown) {
  try { localStorage.setItem(docKey(owner, meta.id), JSON.stringify(json)); } catch { /* private browsing */ }
  const list = listDocs(owner).filter((d) => d.id !== meta.id);
  list.push(meta);
  writeList(owner, list);
}
