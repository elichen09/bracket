/**
 * The desktop app's direct road to a partner's app (src-tauri/src/p2p.rs,
 * iroh): join a room by name, send into it, hear its messages and who comes
 * and goes. Only the app has it; lib/realtime.ts rides it beside the relay.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type P2pEvent =
  | { kind: "msg"; room: string; from: string; data: string }
  | { kind: "peer"; room: string; peer: string; up: boolean };

type Hear = (e: P2pEvent) => void;

const rooms = new Map<string, Set<Hear>>();
let listening: Promise<unknown> | null = null;

function hear() {
  if (!listening) {
    listening = listen<P2pEvent>("coda-p2p", ({ payload }) => {
      rooms.get(payload.room)?.forEach((f) => { try { f(payload); } catch { /* one listener's trouble */ } });
    });
    listening.catch(() => { listening = null; });
  }
  return listening;
}

/** Into a room: this app's id, and the address a partner's app can reach it at. */
export async function p2pJoin(room: string, on: Hear): Promise<{ id: string; addr: string }> {
  await hear();
  let set = rooms.get(room);
  if (!set) rooms.set(room, (set = new Set()));
  set.add(on);
  try {
    return await invoke<{ id: string; addr: string }>("p2p_join", { room });
  } catch (e) {
    p2pLeave(room, on);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export function p2pLeave(room: string, on: Hear) {
  const set = rooms.get(room);
  set?.delete(on);
  if (set && set.size) return;
  rooms.delete(room);
  invoke("p2p_leave", { room }).catch(() => { /* already gone */ });
}

export function p2pSend(room: string, data: string) {
  invoke("p2p_send", { room, data }).catch(() => { /* the relay carries it too */ });
}

/** A partner's app, met on the relay: connect to it directly as well. */
export function p2pDial(room: string, addr: string) {
  invoke("p2p_dial", { room, addr }).catch(() => { /* the relay still works */ });
}
