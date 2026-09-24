import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase";

/**
 * Flowing one document with your partner.
 *
 * Flow's grid can merge cell by cell, last writer wins, because two people
 * almost never write the same cell. A document is different — both of you
 * are typing into the same lines — so the document is a Yjs CRDT, and what
 * crosses the room is Yjs updates: any two edits merge, in any order, and
 * nobody's keystrokes are lost.
 *
 * The room is the same kind of room Flow uses: a Supabase Realtime broadcast
 * channel named by the code, with presence for who is in it. No table, no
 * migration, nothing stored — the room is only the wire. Whoever starts it
 * brings the flow; whoever joins starts from nothing and is sent the flow by
 * everyone already there, and anything either side has that the other lacks
 * is swapped in the same exchange, so a dropped connection heals itself.
 *
 * Realtime allows about ten messages a second from a client, and a fast
 * typist plus a moving caret is more than that, so edits and caret moves are
 * gathered and sent together at most every 120ms.
 */

export type RoomStatus = "joining" | "alone" | "live" | "error";
export interface Mate { client: number; name: string; color: string }

export interface RoomOptions {
  code: string;
  /** The channel's prefix — Doc flow's rooms by default; Evidence shares its send doc on its own. */
  channel?: string;
  ydoc: Y.Doc;
  awareness: Awareness;
  /** The flow's name, to hand to a newcomer. */
  title: () => string;
  /** Joining with nothing: wait for the room's flow instead of offering one. */
  fresh: boolean;
  onStatus: (s: RoomStatus, detail?: string) => void;
  onMates: (m: Mate[]) => void;
  /** The room's flow arrived, and this is its name. */
  onSynced: (title: string | null) => void;
  /** Nobody had a flow to give: this browser starts the room's flow itself. */
  onSeed: () => void;
  onTitle: (title: string) => void;
}

export interface Room { code: string; leave: () => void; rename: (title: string) => void }

const REMOTE = "room";

/** Colours for carets, readable on white and none of them the flow's red. */
export const MATE_COLORS = ["#2E5FAE", "#0F766E", "#7C3AED", "#B45309", "#0E7490", "#BE185D"];

const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function openRoom(o: RoomOptions): Room {
  const { ydoc, awareness } = o;
  const me = Math.random().toString(36).slice(2, 10);
  let channel: RealtimeChannel | null = null;
  let gone = false;
  let synced = !o.fresh;
  let others = 0;
  /** presence id → Yjs client, so a departure takes its caret with it */
  const clients = new Map<string, number>();

  /* ---- outgoing, gathered */
  let pendingY: Uint8Array[] = [];
  let pendingAw = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = (type: string, data: Record<string, unknown>) => {
    if (gone || !channel) return;
    channel.send({ type: "broadcast", event: "docflow", payload: { from: me, type, ...data } });
  };
  const flush = () => {
    timer = null;
    const data: Record<string, string> = {};
    if (pendingY.length) data.y = b64(Y.mergeUpdates(pendingY));
    if (pendingAw.size) data.aw = b64(encodeAwarenessUpdate(awareness, [...pendingAw]));
    pendingY = []; pendingAw = new Set();
    if (data.y || data.aw) send("edit", data);
  };
  const soon = () => { if (!timer) timer = setTimeout(flush, 120); };

  const onUpdate = (u: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    // A fresh joiner's edits before the flow arrives would be typed into
    // nothing; they are held and sent once it has.
    pendingY.push(u);
    if (synced) soon();
  };
  const onAware = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === REMOTE) return;
    [...added, ...updated, ...removed].forEach((c) => pendingAw.add(c));
    soon();
  };
  const mates = () => {
    const list: Mate[] = [];
    awareness.getStates().forEach((st, client) => {
      if (client === ydoc.clientID || !st || !st.user) return;
      list.push({ client, name: String(st.user.name || "Partner"), color: String(st.user.color || MATE_COLORS[0]) });
    });
    o.onMates(list);
  };
  ydoc.on("update", onUpdate);
  awareness.on("update", onAware);
  awareness.on("change", mates);

  /** What I have that they lack, if anything. */
  const diffFor = (sv: string) => {
    const u = Y.encodeStateAsUpdate(ydoc, unb64(sv));
    return u.length > 2 ? b64(u) : null;
  };

  const hello = () => send("hello", { sv: b64(Y.encodeStateVector(ydoc)) });

  const supabase = supabaseBrowser();
  channel = supabase.channel(`${o.channel || "docflow"}-${o.code}`, { config: { broadcast: { self: false }, presence: { key: me } } });

  const readPresence = () => {
    if (!channel) return;
    const state = channel.presenceState() as Record<string, { id?: string; client?: number }[]>;
    const seen = new Map<string, number>();
    Object.values(state).flat().forEach((e) => { if (e && e.id && e.id !== me && typeof e.client === "number") seen.set(e.id, e.client); });
    const left = [...clients.keys()].filter((id) => !seen.has(id)).map((id) => clients.get(id)!);
    clients.clear(); seen.forEach((c, id) => clients.set(id, c));
    if (left.length) removeAwarenessStates(awareness, left, REMOTE);
    others = seen.size;
    o.onStatus(others ? "live" : "alone");
  };

  channel
    .on("broadcast", { event: "docflow" }, ({ payload }: { payload: any }) => {
      if (!payload || payload.from === me || gone) return;
      const t = payload.type as string;
      if (t === "hello") {
        // someone arrived, or came back: give them what they lack, and ask for the same
        if (!synced) return;
        send("state", { to: payload.from, u: diffFor(payload.sv), sv: b64(Y.encodeStateVector(ydoc)), title: o.title() });
        pendingAw.add(ydoc.clientID); soon();
        return;
      }
      if (t === "state") {
        if (payload.to !== me) return;
        if (payload.u) Y.applyUpdate(ydoc, unb64(payload.u), REMOTE);
        const first = !synced;
        synced = true;
        if (first) o.onSynced(payload.title || null);
        const back = payload.sv ? diffFor(payload.sv) : null;
        if (back) send("edit", { y: back });
        if (pendingY.length) soon();
        return;
      }
      if (t === "edit") {
        if (payload.y && synced) Y.applyUpdate(ydoc, unb64(payload.y), REMOTE);
        if (payload.aw) applyAwarenessUpdate(awareness, unb64(payload.aw), REMOTE);
        return;
      }
      if (t === "title" && typeof payload.title === "string") o.onTitle(payload.title);
    })
    .on("presence", { event: "sync" }, readPresence)
    .on("presence", { event: "join" }, readPresence)
    .on("presence", { event: "leave" }, readPresence)
    .subscribe(async (status: string, err?: Error) => {
      if (gone) return;
      if (status === "SUBSCRIBED") {
        await channel!.track({ id: me, client: ydoc.clientID });
        o.onStatus(others ? "live" : "alone");
        hello();
        pendingAw.add(ydoc.clientID); soon();
        if (!synced) waitForFlow(0);
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") o.onStatus("error", err?.message || status);
    });

  // A fresh joiner waits for the room to send its flow; if the room turns
  // out to be empty, this browser's blank flow becomes the room's.
  function waitForFlow(tries: number) {
    setTimeout(() => {
      if (gone || synced) return;
      if (others && tries < 4) { hello(); waitForFlow(tries + 1); return; }
      synced = true;
      o.onSeed();
      o.onSynced(null);
    }, 1400);
  }

  return {
    code: o.code,
    rename(title: string) { send("title", { title }); },
    leave() {
      if (timer) { clearTimeout(timer); flush(); }
      removeAwarenessStates(awareness, [ydoc.clientID], "leave");
      flush();
      gone = true;
      ydoc.off("update", onUpdate);
      awareness.off("update", onAware);
      awareness.off("change", mates);
      try { channel?.untrack(); } catch { /* already gone */ }
      try { if (channel) supabase.removeChannel(channel); } catch { /* already gone */ }
      channel = null;
    },
  };
}
