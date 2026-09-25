import { scoped } from "./owner";

/**
 * Past flows — every round an account has flowed, in either tool.
 *
 * Both Flow (the grid) and Doc flow write here as they save, so nothing has
 * to be filed by hand: a round is in the archive from its first keystroke,
 * and starting the next one never loses the last. The Past flows tool reads
 * it back, and opening a round from there hands it to the tool it came from.
 *
 * It lives in IndexedDB rather than localStorage because a season is a lot
 * of rounds, and localStorage's few megabytes are shared with everything else
 * the tools keep. One database per account, like the rest.
 *
 * Each record carries a summary next to the flow itself — counts, the first
 * few lines, the words for searching — worked out when it is saved, so the
 * list can be drawn and searched without reading every flow's insides.
 */

export type Kind = "doc" | "grid";

/** A line of the preview: what kind of thing it is, how deep, whose. */
export interface Glance { k: "box" | "head" | "line" | "para" | "sheet"; d?: number; who?: string; t: string }

export interface Round {
  id: string;
  kind: Kind;
  name: string;
  /** Set by hand in Past flows; groups rounds from the same tournament. */
  tourn?: string;
  /** The name was chosen in Past flows, and saving the flow must not undo that. */
  named?: boolean;
  created: number;
  updated: number;
  stats: string;
  glance: Glance[];
  text: string;
  data: unknown;
}

export type RoundMeta = Omit<Round, "data">;

const STORE = "rounds";
const dbs = new Map<string, Promise<IDBDatabase>>();

function db(owner?: string | null): Promise<IDBDatabase> {
  const name = scoped("flows", owner);
  let p = dbs.get(name);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore(STORE, { keyPath: "id" });
        s.createIndex("updated", "updated");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbs.set(name, p);
  }
  return p;
}

function tx<T>(owner: string | null | undefined, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db(owner).then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/** Tell any open Past flows tab that something changed. */
function ping(owner?: string | null) {
  try { const c = new BroadcastChannel(scoped("break-flows", owner)); c.postMessage("changed"); c.close(); } catch { /* no channel */ }
}
export function onArchive(owner: string | null | undefined, fn: () => void) {
  try {
    const c = new BroadcastChannel(scoped("break-flows", owner));
    c.onmessage = () => fn();
    return () => c.close();
  } catch { return () => {}; }
}

export async function listRounds(owner?: string | null): Promise<Round[]> {
  try {
    const all = (await tx<Round[]>(owner, "readonly", (s) => s.getAll())) || [];
    return all.sort((a, b) => b.updated - a.updated);
  } catch { return []; }
}

export async function getRound(owner: string | null | undefined, id: string): Promise<Round | null> {
  try { return (await tx<Round>(owner, "readonly", (s) => s.get(id))) || null; } catch { return null; }
}

/**
 * Save a round. A name or tournament set in Past flows outlives the tool
 * saving over it, and so does when the round was first made.
 */
export async function putRound(owner: string | null | undefined, rec: Round): Promise<void> {
  try {
    const had = await getRound(owner, rec.id);
    const next: Round = had
      ? { ...rec, created: had.created || rec.created, tourn: rec.tourn || had.tourn, ...(had.named ? { name: had.name, named: true } : {}) }
      : rec;
    await tx(owner, "readwrite", (s) => { s.put(next); });
    ping(owner);
  } catch { /* storage refused: the tool's own copy still stands */ }
}

export async function patchRound(owner: string | null | undefined, id: string, patch: Partial<Round>): Promise<void> {
  const had = await getRound(owner, id);
  if (!had) return;
  await tx(owner, "readwrite", (s) => { s.put({ ...had, ...patch }); });
  ping(owner);
}

export async function deleteRound(owner: string | null | undefined, id: string): Promise<Round | null> {
  const had = await getRound(owner, id);
  await tx(owner, "readwrite", (s) => { s.delete(id); });
  ping(owner);
  return had;
}

export async function restoreRound(owner: string | null | undefined, rec: Round): Promise<void> {
  await tx(owner, "readwrite", (s) => { s.put(rec); });
  ping(owner);
}

/* ------------------------------------------------------------------
   Summaries, one for each kind of flow.
   ------------------------------------------------------------------ */

const clip = (s: string, n = 20000) => (s.length > n ? s.slice(0, n) : s);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

interface PMJSON { type: string; attrs?: Record<string, any>; content?: PMJSON[]; text?: string }
const textOf = (n: PMJSON): string => (n.text || "") + (n.content || []).map(textOf).join("");

/** Whether a Doc flow has been written in: a speech box's label alone is not writing. */
export const docHasWriting = (json: unknown) =>
  (((json as PMJSON)?.content || []) as PMJSON[]).some((b) => b.type !== "box" && textOf(b).trim());

/** Whether a round in either tool has anything in it worth going back to. */
export const roundHasWriting = (r: Round) => (r.kind === "doc" ? docHasWriting(r.data) : gridHasWriting(r.data as GridDoc));

/** A Doc flow: its lines, how many were theirs, and its boxes. */
export function summarizeDoc(id: string, name: string, json: unknown, created: number, updated: number): Round {
  const blocks = ((json as PMJSON)?.content || []) as PMJSON[];
  let lines = 0, theirs = 0, boxes = 0;
  const glance: Glance[] = [];
  const words: string[] = [];
  for (const b of blocks) {
    const t = textOf(b).trim();
    if (b.type === "item") { if (!t) continue; lines++; if (b.attrs?.who === "them") theirs++; }
    if (b.type === "box") boxes++;
    if (t) words.push(t);
    if (glance.length < 14 && t) {
      glance.push(b.type === "item" ? { k: "line", d: b.attrs?.depth || 0, who: b.attrs?.who, t: t.slice(0, 140) }
        : { k: b.type === "box" ? "box" : b.type === "head" ? "head" : "para", who: b.attrs?.who, t: t.slice(0, 140) });
    }
  }
  const stats = [plural(lines, "line"), `${theirs} theirs`, boxes ? `${boxes} box${boxes === 1 ? "" : "es"}` : ""].filter(Boolean).join(" · ");
  return { id, kind: "doc", name, created, updated, stats, glance, text: clip(words.join("\n")), data: json };
}

interface GridDoc { id: string; created?: number; first?: string; meta?: { tourn?: string; round?: string; side?: string }; notes?: string; sheets?: { name: string; side?: string; rows?: { c?: string[] }[] }[] }

/** Whether a grid round has anything in it worth keeping. */
export const gridHasWriting = (S: GridDoc) =>
  !!(S.notes && S.notes.trim()) || (S.sheets || []).some((s) => (s.rows || []).some((r) => (r.c || []).some((c) => c && c.trim())));

const cellText = (c: string) => String(c || "").replace(/\s+/g, " ").trim();

/** A grid round: its sheets, how many cells are written, and what they say. */
export function summarizeGrid(S: GridDoc, updated: number): Round {
  const sheets = S.sheets || [];
  let cells = 0;
  const glance: Glance[] = [];
  const words: string[] = [];
  for (const sh of sheets) {
    const rows = sh.rows || [];
    const firsts: string[] = [];
    rows.forEach((r) => (r.c || []).forEach((c, i) => {
      const t = cellText(c);
      if (!t) return;
      cells++; words.push(t);
      if (i <= 1 && firsts.length < 3) firsts.push(t);
    }));
    if (glance.length < 14) {
      glance.push({ k: "sheet", who: sh.side, t: sh.name });
      firsts.forEach((t) => glance.length < 14 && glance.push({ k: "line", d: 1, who: sh.side === "con" ? "them" : "us", t: t.slice(0, 140) }));
    }
  }
  const m = S.meta || {};
  const at = new Date(S.created || updated);
  const when = at.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const name = [m.tourn, m.round].filter(Boolean).join(" · ") || `Grid flow — ${when}`;
  return {
    id: S.id, kind: "grid", name, tourn: m.tourn || undefined, created: S.created || updated, updated,
    stats: [plural(sheets.length, "sheet"), plural(cells, "cell")].join(" · "),
    glance, text: clip([name, ...words, S.notes || ""].join("\n")), data: S,
  };
}
