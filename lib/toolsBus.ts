/**
 * The line between the tools.
 *
 * Evidence and Flow are separate pages, usually open in two tabs side by
 * side, and they talk over a BroadcastChannel — one per account, so two
 * people on the same browser never hear each other's tools. Nothing here is
 * stored: the send list itself lives in Evidence's database, and this only
 * says "it changed" or "this was just sent".
 *
 *   send-changed  Flow put a card in the send list; Evidence reloads it.
 *   sent          Evidence sent a card; Flow offers to put its tags in the flow.
 *   senddoc       Evidence's send doc, as an outline of blocks and tags, so a
 *                 Flow tab can show it and flow it.
 */

import { scoped } from "./owner";

export type BusMessage =
  | { kind: "send-changed"; title?: string }
  | { kind: "sent"; title: string; trigger: string; tags: string[] }
  | { kind: "senddoc"; by: string; at: number; blocks: DocBlock[] };

/** One block of a send doc, as Flow needs it: its header and its tags. */
export interface DocBlock { head: string; section: string; tags: { tag: string; cite: string }[] }

export interface Bus {
  post: (m: BusMessage) => void;
  close: () => void;
}

export function openBus(owner: string | null | undefined, onMessage: (m: BusMessage) => void): Bus {
  if (typeof BroadcastChannel === "undefined") return { post: () => {}, close: () => {} };
  const ch = new BroadcastChannel(scoped("break-tools", owner));
  ch.onmessage = (e) => { if (e.data && e.data.kind) onMessage(e.data as BusMessage); };
  return {
    post: (m) => { try { ch.postMessage(m); } catch { /* closed */ } },
    close: () => { try { ch.close(); } catch { /* closed */ } },
  };
}
