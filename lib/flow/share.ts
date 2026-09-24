/**
 * Flowing with your partner.
 *
 * One of you starts a room, reads the code out, and the other types it in.
 * From then on both flows are the same flow: a cell either of you writes
 * appears in the other's within a beat, and each of you can see where the
 * other is working.
 *
 * It rides on Supabase Realtime's broadcast channels, which means there is no
 * table, no row-level policy and **no migration to run** — a channel is just
 * a name two browsers agree on, and the code is that name. That also means
 * nothing is stored: a room exists while somebody is in it. Whoever is
 * already in the room answers a newcomer with the whole flow, so joining
 * late still gets you everything.
 *
 * The merge rule is last-writer-wins on a cell, which is the right rule for
 * this and not for much else: two people flowing the same round write in
 * different columns almost all of the time, and on the rare collision the
 * later keystroke is the one that should survive.
 */

import { supabaseBrowser } from "@/lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type Status = "joining" | "live" | "alone" | "error";

export interface Caret { sheet: string; row: string; col: number }

/** A flow; an Evidence tab sharing its send doc; or a Doc viewer reading that send doc. */
export type Kind = "flow" | "evidence" | "viewer";

export interface Peer {
  id: string;
  name: string;
  /** A flow, or an Evidence tab sharing its send doc into the room. */
  kind: Kind;
  /** A hue of their own, so two carets are never the same colour. */
  hue: number;
  caret: Caret | null;
}

export interface Handlers {
  /** A change from the other side, already unpacked. */
  onEvent: (type: string, payload: any) => void;
  /** Someone arrived, left, or moved. */
  onPeers: (peers: Peer[]) => void;
  onStatus: (status: Status, detail?: string) => void;
  /** Answering a newcomer: hand back the whole flow. */
  snapshot: () => any;
}

export interface Session {
  code: string;
  me: string;
  send: (type: string, payload?: any) => void;
  leave: () => void;
}

/** Codes people read down a table to each other: no O/0, no I/1. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newCode(len = 5) {
  const n = new Uint8Array(len);
  crypto.getRandomValues(n);
  return Array.from(n, (x) => ALPHABET[x % ALPHABET.length]).join("");
}
export const tidyCode = (s: string) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

const HUES = [18, 210, 145, 275, 340, 45];

/**
 * Into a room. A flow tab takes part in the flow; an Evidence tab only
 * publishes its send doc there, so it never answers a newcomer's ask for the
 * flow — it is handed the ask instead, to publish the doc again.
 */
export function joinFlow(code: string, who: string, h: Handlers, kind: Kind = "flow"): Session {
  const me = newCode(8);
  const hue = HUES[Math.floor(Math.random() * HUES.length)];
  let channel: RealtimeChannel | null = null;
  let gone = false;
  let peers: Peer[] = [];

  const carets = new Map<string, Caret | null>();

  const readPresence = () => {
    if (!channel) return;
    const state = channel.presenceState() as Record<string, any[]>;
    peers = Object.entries(state)
      .flatMap(([, entries]) => entries)
      .filter((e: any) => e && e.id && e.id !== me)
      .map((e: any) => ({ id: e.id, name: e.name || "Partner", hue: e.hue ?? 210, kind: (e.kind || "flow") as Kind, caret: carets.get(e.id) || null }));
    h.onPeers(peers);
    h.onStatus(peers.length ? "live" : "alone");
  };

  const supabase = supabaseBrowser();
  channel = supabase.channel(`flow-${code}`, {
    config: { broadcast: { self: false }, presence: { key: me } },
  });

  channel
    .on("broadcast", { event: "flow" }, ({ payload }: any) => {
      if (!payload || payload.from === me) return;
      const { type, data } = payload;

      if (type === "ask") {
        if (kind !== "flow") { h.onEvent("ask", null); return; }
        // Everyone in the room hears this, so only one answers: the peer whose
        // id sorts first. The wait lets presence settle before that is decided.
        setTimeout(() => {
          if (gone) return;
          const others = peers.filter((p) => p.kind === "flow").map((p) => p.id).filter((id) => id !== payload.from);
          const first = [me, ...others].sort()[0];
          if (first === me) send("full", { to: payload.from, doc: h.snapshot() });
        }, 220);
        return;
      }
      if (type === "full" && data?.to !== me) return;
      if (type === "caret") {
        carets.set(payload.from, data || null);
        peers = peers.map((p) => (p.id === payload.from ? { ...p, caret: data || null } : p));
        h.onPeers(peers);
        return;
      }
      h.onEvent(type, data);
    })
    .on("presence", { event: "sync" }, readPresence)
    .on("presence", { event: "join" }, readPresence)
    .on("presence", { event: "leave" }, readPresence)
    .subscribe(async (status: string, err?: Error) => {
      if (gone) return;
      if (status === "SUBSCRIBED") {
        await channel!.track({ id: me, name: who || "Partner", hue, kind });
        h.onStatus("alone");
        // Ask for the room's flow. If nobody answers, this browser's copy is
        // the room's copy and the ask cost nothing.
        if (kind === "flow") send("ask", null);
        // a viewer asks for the send doc itself, whole
        if (kind === "viewer") send("askdoc", null);
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        h.onStatus("error", err?.message || status);
      }
    });

  function send(type: string, data?: any) {
    if (gone || !channel) return;
    channel.send({ type: "broadcast", event: "flow", payload: { from: me, type, data } });
  }

  return {
    code,
    me,
    send,
    leave() {
      gone = true;
      try { channel?.untrack(); } catch { /* already gone */ }
      try { if (channel) supabaseBrowser().removeChannel(channel); } catch { /* already gone */ }
      channel = null;
    },
  };
}
