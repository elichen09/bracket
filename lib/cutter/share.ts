import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import type { Node as PMNode } from "prosemirror-model";
import { openRoom, MATE_COLORS, type Mate, type Room, type RoomStatus } from "../docflow/room";

/**
 * A file shared the way a Google Doc is.
 *
 * Share a file and it has a link; whoever is signed in and has the link opens
 * the same file, and everyone in it types into it at once — each other's
 * carets in view, nobody's words lost. It stays a file of yours (and becomes
 * one of theirs): it is in each person's own list, opens when nobody else is
 * around, and catches up when they are.
 *
 * The document is a Yjs CRDT — the same one Doc flow and a room's speech doc
 * use — so any two edits merge, in any order. It travels two ways. Between
 * the browsers that have it open, edits cross a realtime channel as they are
 * typed (lib/docflow/room.ts). And the whole document is kept on the site
 * (app/api/tools/share), saved a moment after any change by whoever made it,
 * which is what a link opens to and what a browser that was away catches up
 * from. A save first takes in what is already there, then puts back the two
 * merged, so saves that cross lose nothing either.
 *
 * Something too big for the realtime channel — a whole file pasted in — goes
 * by way of the save instead: it is saved at once, and the others are told
 * to fetch it.
 */

export interface Shared {
  id: string;
  ydoc: Y.Doc;
  frag: Y.XmlFragment;
  awareness: Awareness;
  /** This account shared it; only it can stop the sharing. */
  mine: boolean;
  owner: string;
  status: RoomStatus;
  mates: Mate[];
  /** The whole document, to keep with the file in this browser. */
  snapshot: () => Uint8Array;
  rename: (title: string) => void;
  /** Save now, and say when it is saved. */
  save: () => Promise<void>;
  close: () => void;
}

export interface ShareHooks {
  /** Who this is, over their caret. */
  name: string;
  title: () => string;
  /** The file as it is in this browser, for the first time it is shared. */
  seed: () => PMNode | null;
  /** This browser is the one sharing it, now: its document is the document. */
  first?: boolean;
  /** The document as this browser last had it. */
  local?: Uint8Array | null;
  /** Who is in it, or whether it is connected, changed. */
  onChange: () => void;
  onTitle: (title: string) => void;
  /** It is not shared any more. */
  onGone: () => void;
}

export class NotShared extends Error {}

export const shareLink = (id: string) => `${location.origin}/tools/magic?doc=${id}`;

async function api(body: Record<string, unknown>) {
  const r = await fetch("/api/tools/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404) throw new NotShared(j.error || "That doc is not shared any more");
  if (!r.ok) throw new Error(j.error || `the server said ${r.status}`);
  return j;
}

/** Make a file a shared one: the id its link carries. */
export const createShare = async (title: string): Promise<string> => (await api({ op: "create", title })).id;
/** Stop sharing (its owner): the link stops opening it; every copy already opened stays where it is. */
export const stopShare = (id: string) => api({ op: "stop", id });
/** What a link points at, before opening it. */
export async function peekShare(id: string): Promise<{ title: string; owner: string; mine: boolean }> {
  const r = await fetch(`/api/tools/share?id=${encodeURIComponent(id)}`, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404) throw new NotShared(j.error || "That doc is not shared any more");
  if (!r.ok) throw new Error(j.error || `the server said ${r.status}`);
  return j;
}

const colorFor = (name: string) => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return MATE_COLORS[h % MATE_COLORS.length]; };

export async function openShare(id: string, hooks: ShareHooks): Promise<Shared> {
  const ydoc = new Y.Doc();
  const frag = ydoc.getXmlFragment("doc");
  const awareness = new Awareness(ydoc);
  let gone = false;
  if (hooks.local && hooks.local.length) { try { Y.applyUpdate(ydoc, hooks.local, "local"); } catch { /* a snapshot that will not read: the site's copy, then */ } }

  /** What the site has, merged into this. */
  let pulled = 0;
  const pull = async (): Promise<{ mine: boolean; owner: string; had: boolean }> => {
    const r = await fetch(`/api/tools/share?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (r.status === 404) throw new NotShared(j.error || "That doc is not shared any more");
    if (!r.ok) throw new Error(j.error || `the server said ${r.status}`);
    if (j.url) {
      const b = await fetch(j.url);
      if (b.ok) { const u = new Uint8Array(await b.arrayBuffer()); if (u.length && !gone) Y.applyUpdate(ydoc, u, "server"); }
    }
    pulled = Date.now();
    return { mine: !!j.mine, owner: String(j.owner || ""), had: !!j.url };
  };

  let info = { mine: !!hooks.first, owner: "", had: false };
  try { info = await pull(); }
  catch (e) {
    // no way to the site, but the file is here: it opens, and catches up when there is one
    if (e instanceof NotShared || !(hooks.local && hooks.local.length)) { ydoc.destroy(); throw e; }
  }
  // the first time: the file as it is here becomes the shared document
  if (!frag.length && (hooks.first || (info.mine && !info.had))) {
    const seed = hooks.seed();
    if (seed) prosemirrorToYXmlFragment(seed, frag);
  }

  awareness.setLocalStateField("user", { name: hooks.name, color: colorFor(hooks.name) });

  /* ---- saving: a moment after a change made here, and never two at once */
  let dirty = false, saving: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | null = null, since = 0;
  const put = async () => {
    dirty = false; since = 0;
    // what is there first, unless it was read a moment ago: a save never drops what was saved while this browser was not listening
    if (Date.now() - pulled > 45_000) await pull();
    const j = await api({ op: "save", id, title: hooks.title() });
    const up = await fetch(j.url, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-upsert": "true" }, body: Y.encodeStateAsUpdate(ydoc) as unknown as BodyInit });
    if (!up.ok) throw new Error(`the save said ${up.status}`);
  };
  const save = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (saving) return saving.then(() => (dirty ? save() : undefined));
    saving = put().catch((e) => {
      if (e instanceof NotShared) { if (!gone) hooks.onGone(); return; }
      dirty = true; soon(8000);                        // the network, most likely: again in a while
    }).finally(() => { saving = null; });
    return saving;
  };
  const soon = (ms = 2500) => {
    if (gone) return;
    if (!since) since = Date.now();
    if (timer) clearTimeout(timer);
    // a pause in the typing — or twelve seconds of typing without one
    timer = setTimeout(() => { timer = null; void save(); }, Date.now() - since > 12_000 ? 0 : ms);
  };
  const onUpdate = (_u: Uint8Array, origin: unknown) => {
    if (origin === "room" || origin === "server" || origin === "local") return;   // somebody else's edit is theirs to save
    dirty = true; soon();
  };
  ydoc.on("update", onUpdate);

  const shared: Shared = {
    id, ydoc, frag, awareness, mine: info.mine, owner: info.owner, status: "joining", mates: [],
    snapshot: () => Y.encodeStateAsUpdate(ydoc),
    rename: (title) => { room.rename(title); dirty = true; soon(600); },
    save,
    close() {
      if (gone) return;
      if (dirty && !saving) void put().catch(() => { /* this browser's copy has it; the next opening saves it */ });
      gone = true;
      if (timer) clearTimeout(timer);
      ydoc.off("update", onUpdate);
      room.leave();
      setTimeout(() => ydoc.destroy(), 4000);          // after the last save has read it
    },
  };

  const room: Room = openRoom({
    code: id, channel: "magicdoc", ydoc, awareness, fresh: false,
    title: hooks.title,
    onStatus: (s) => { if (shared.status !== s) { shared.status = s; hooks.onChange(); } },
    onMates: (m) => { shared.mates = m; hooks.onChange(); },
    onSynced: () => {},
    onSeed: () => {},
    onTitle: hooks.onTitle,
    big: { limit: 120_000, carry: save, fetch: () => { void pull().catch(() => { /* the next one */ }); } },
  });

  if (hooks.first || (info.mine && !info.had)) void save();
  return shared;
}
