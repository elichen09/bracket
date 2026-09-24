import { scoped } from "../owner";
import { putRound, getRound, summarizeDoc, deleteRound } from "../pastflows";

/**
 * The flows an account is working on — one per round, as the Docs they
 * replace were.
 *
 * Kept in this browser, apart per account like the other tools: a list of
 * names and when each was last touched, and each flow's document on its own
 * key so that opening one never reads the rest.
 *
 * This is the working set, not the record. Every save is copied into Past
 * flows (lib/pastflows), and once a flow is safely there and a dozen newer
 * ones have been touched since, its copy here is let go — a season of rounds
 * would not fit in localStorage. Opening it again from Past flows brings it
 * back.
 */

export interface DocMeta { id: string; name: string; updated: number; created?: number; archived?: number }

/** How many flows stay here once they are also in Past flows. */
const KEEP = 12;

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
  const now = Date.now();
  if (at >= 0) { list[at].updated = now; if (name) list[at].name = name; }
  else list.push({ id, name: name || "Untitled flow", updated: now, created: now });
  writeList(owner, list);
  archive(owner, id);
}

/** Copy a flow into Past flows, and let go of old ones that are safely there. */
function archive(owner: string | null | undefined, id: string) {
  const meta = listDocs(owner).find((d) => d.id === id);
  const json = loadDoc(owner, id);
  if (!meta || !json) return;
  const at = meta.updated;
  putRound(owner, summarizeDoc(id, meta.name, json, meta.created || meta.updated, meta.updated)).then(() => {
    const list = listDocs(owner);
    const d = list.find((x) => x.id === id);
    if (d && d.updated === at) { d.archived = at; writeList(owner, list); }
    prune(owner);
  });
}

function prune(owner: string | null | undefined) {
  const list = listDocs(owner);
  if (list.length <= KEEP) return;
  const keep = list.slice(0, KEEP);
  const old = list.slice(KEEP);
  const go = old.filter((d) => d.archived && d.archived >= d.updated);
  if (!go.length) return;
  go.forEach((d) => { try { localStorage.removeItem(docKey(owner, d.id)); } catch { /* private browsing */ } });
  writeList(owner, [...keep, ...old.filter((d) => !go.includes(d))]);
}

/** Everything kept here from before Past flows existed goes into it. */
export async function archiveAll(owner: string | null | undefined) {
  for (const d of listDocs(owner)) {
    if (!(await getRound(owner, d.id))) archive(owner, d.id);
  }
}

/**
 * A flow to open: from here, or back out of Past flows if it has been let go.
 * Resolves to its name, or null if it is nowhere.
 */
export async function fetchDoc(owner: string | null | undefined, id: string): Promise<string | null> {
  const here = listDocs(owner).find((d) => d.id === id);
  if (here && loadDoc(owner, id)) return here.name;
  const rec = await getRound(owner, id);
  if (!rec || rec.kind !== "doc") return null;
  try { localStorage.setItem(docKey(owner, id), JSON.stringify(rec.data)); } catch { return null; }
  const list = listDocs(owner).filter((d) => d.id !== id);
  list.push({ id, name: rec.name, updated: Date.now(), created: rec.created, archived: 0 });
  writeList(owner, list);
  return rec.name;
}

/** Gone from here and from Past flows. */
export async function forgetDoc(owner: string | null | undefined, id: string) {
  removeDoc(owner, id);
  await deleteRound(owner, id);
}

export function renameDoc(owner: string | null | undefined, id: string, name: string) {
  const list = listDocs(owner);
  const d = list.find((x) => x.id === id);
  if (d) { d.name = name; writeList(owner, list); archive(owner, id); }
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
