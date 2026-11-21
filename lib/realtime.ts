/**
 * The rooms partners meet in, by a room's code: Flow's shared rounds and the
 * speech doc's Room. A room is a channel with broadcast and presence.
 *
 * On the site it's a Supabase Realtime channel on the site's own client.
 *
 * In the desktop app — no account, nothing signed in — a room rides two roads
 * at once, and either is enough:
 * - **Direct, app to app** (lib/p2p.ts → src-tauri/src/p2p.rs, iroh). Two apps
 *   on the same Wi-Fi find each other with no internet at all; across the
 *   internet they connect straight through, or through iroh's relay, which
 *   can't read what passes.
 * - **The relay** (Supabase Realtime, a client of the app's own made from the
 *   relay's public address and key, fetched from the site the first time and
 *   kept). It's how the app meets a partner on coda's website, and how two
 *   apps far apart learn each other's address for the direct road.
 * Every message goes both ways and carries an id, so whoever hears it twice
 * keeps it once. Presence is the two roads' together: a partner is in the
 * room while either road still has them.
 *
 * Nothing about a round is stored anywhere: both roads only pass messages
 * between you while you're both in the room.
 */
import { createClient, type SupabaseClient, type RealtimeChannel } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase";
import { isDesktop, CODA_WEB } from "@/lib/desktop";
import type { P2pEvent } from "@/lib/p2p";

/** The part of a Realtime channel the rooms use. */
export interface RoomChannel {
  on(type: "broadcast", filter: { event: string }, cb: (m: { payload: any }) => void): RoomChannel;
  on(type: "presence", filter: { event: string }, cb: () => void): RoomChannel;
  subscribe(cb: (status: string, err?: Error) => void): RoomChannel;
  send(m: { type: "broadcast"; event: string; payload: any }): Promise<unknown>;
  track(state: Record<string, unknown>): Promise<unknown>;
  untrack(): Promise<unknown>;
  presenceState(): Record<string, any[]>;
}
export interface RoomClient {
  channel(name: string, opts: { config: { broadcast?: { self?: boolean }; presence?: { key?: string } } }): RoomChannel;
  removeChannel(ch: RoomChannel): Promise<unknown>;
}

const KEPT = "coda.realtime";

async function relayClient(): Promise<RoomClient> {
  let cfg: { url: string; key: string } | null = null;
  try { cfg = JSON.parse(localStorage.getItem(KEPT) || "null"); } catch { /* fetched below */ }
  const fetched = fetch(CODA_WEB + "/api/tools/realtime").then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url || !j.key) throw new Error(j.error || "coda's site didn't answer");
    try { localStorage.setItem(KEPT, JSON.stringify({ url: j.url, key: j.key })); } catch { /* not kept */ }
    return { url: j.url as string, key: j.key as string };
  });
  if (!cfg) cfg = await fetched;
  else fetched.catch(() => { /* the kept one will do */ });
  const { url, key } = cfg;
  const make = () => anonClient(url, key);
  return pooled(make(), make);
}

/** A client of the relay with no sign-in of its own: rooms need none. */
let extras = 0;
const anonClient = (url: string, key: string) =>
  createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "coda-room-" + extras++ } });

/**
 * Rooms on a relay, one connection per room name at a time. supabase-js hands
 * back the channel already open when a name is asked for twice, and that one
 * takes no new listeners — but one page can be in a room twice: Flow, and the
 * speech doc's Room, on the same code. The second gets a connection of its own,
 * just as two tabs would.
 */
function pooled(first: SupabaseClient, make: () => SupabaseClient): RoomClient {
  const pool: { c: SupabaseClient; names: Set<string> }[] = [{ c: first, names: new Set() }];
  const whose = new Map<unknown, { e: (typeof pool)[number]; name: string }>();
  return {
    channel(name, opts) {
      let e = pool.find((p) => !p.names.has(name));
      if (!e) { e = { c: make(), names: new Set() }; pool.push(e); }
      e.names.add(name);
      const ch = e.c.channel(name, opts);
      whose.set(ch, { e, name });
      return ch as unknown as RoomChannel;
    },
    async removeChannel(ch) {
      const o = whose.get(ch);
      if (!o) return "ok";
      whose.delete(ch);
      o.e.names.delete(o.name);
      return o.e.c.removeChannel(ch as unknown as RealtimeChannel);
    },
  };
}

/** The app's relay, made once it can be; offline with nothing kept, tried again by the next room. */
let relay: Promise<RoomClient> | null = null;
function appRelay(): Promise<RoomClient | null> {
  if (!relay) {
    relay = relayClient();
    relay.catch(() => { relay = null; });
  }
  return relay.catch(() => null);
}

const rid = () => Math.random().toString(36).slice(2, 12);
/**
 * Alone in a room with no relay: how long to wait for a partner's app on the
 * network before saying so. Short, because until then what you write isn't yet
 * the room's; a partner found later still gets it (the rooms ask again when
 * someone who was there first turns up).
 */
const ALONE_AFTER = 2500;

/** A room on both roads at once (the desktop app). */
class BothRoads implements RoomChannel {
  private bc = new Map<string, ((m: { payload: any }) => void)[]>();
  private pres = new Set<() => void>();
  private sb: RealtimeChannel | null = null;
  private sbUp = false;
  private sbState: Record<string, any[]> = {};
  /** partner app → who they are in the room */
  private direct = new Map<string, { key: string; state: any }>();
  private mine: Record<string, unknown> | null = null;
  private addr = "";
  private joined = false;
  private directFailed = false;
  private relayFailed = false;
  private told = false;
  private gone = false;
  private status: ((s: string, e?: Error) => void) | null = null;
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private p2p: Promise<typeof import("@/lib/p2p")> = import("@/lib/p2p");

  constructor(private name: string, private key: string) {}

  on(type: "broadcast" | "presence", filter: { event: string }, cb: any): RoomChannel {
    if (type === "broadcast") {
      const list = this.bc.get(filter.event) || [];
      list.push(cb);
      this.bc.set(filter.event, list);
    } else this.pres.add(cb);
    return this;
  }

  subscribe(cb: (status: string, err?: Error) => void): RoomChannel {
    this.status = cb;

    // the direct road
    this.p2p.then((p) => p.p2pJoin(this.name, this.hearDirect)).then((j) => {
      if (this.gone) return;
      this.joined = true;
      this.addr = j.addr;
      if (this.mine) this.track(this.mine);          // again, now with the address
      this.dialFromRelay();
      setTimeout(() => this.ready(), ALONE_AFTER);
    }).catch((e) => { this.directFailed = true; this.failIfBoth(e); });

    // the relay
    appRelay().then((client) => {
      if (this.gone) return;
      if (!client) { this.relayFailed = true; this.failIfBoth(new Error("no internet")); return; }
      const ch = client.channel(this.name, { config: { broadcast: { self: false }, presence: { key: this.key } } }) as unknown as RealtimeChannel;
      this.sb = ch;
      for (const ev of this.bc.keys()) ch.on("broadcast", { event: ev }, ({ payload }: any) => this.deliver(ev, payload));
      const sync = () => { this.sbState = ch.presenceState() as Record<string, any[]>; this.dialFromRelay(); this.firePresence(); };
      ch.on("presence", { event: "sync" }, sync).on("presence", { event: "join" }, sync).on("presence", { event: "leave" }, sync);
      ch.subscribe((status: string, err?: Error) => {
        if (this.gone) return;
        if (status === "SUBSCRIBED") {
          this.sbUp = true;
          if (this.mine) ch.track(this.relayState(this.mine));
          this.ready();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          this.sbUp = false;
          if (status !== "CLOSED") { this.relayFailed = true; this.failIfBoth(err || new Error(status)); }
        }
      });
    });
    return this;
  }

  send(m: { type: "broadcast"; event: string; payload: any }) {
    const id = rid();
    this.remember(id);
    const payload = { ...m.payload, _m: id };
    if (this.sb && this.sbUp) this.sb.send({ type: "broadcast", event: m.event, payload });
    if (this.joined) this.p2p.then((p) => p.p2pSend(this.name, JSON.stringify({ k: "b", event: m.event, payload })));
    return Promise.resolve("ok");
  }

  track(state: Record<string, unknown>) {
    this.mine = state;
    if (this.sb && this.sbUp) this.sb.track(this.relayState(state));
    if (this.joined) this.p2p.then((p) => p.p2pSend(this.name, JSON.stringify({ k: "p", key: this.key, state })));
    return Promise.resolve("ok");
  }

  untrack() {
    this.mine = null;
    if (this.sb && this.sbUp) this.sb.untrack();
    if (this.joined) this.p2p.then((p) => p.p2pSend(this.name, JSON.stringify({ k: "u", key: this.key })));
    return Promise.resolve("ok");
  }

  presenceState(): Record<string, any[]> {
    const out: Record<string, any[]> = {};
    for (const [k, v] of Object.entries(this.sbState)) out[k] = [...v];
    for (const { key, state } of this.direct.values()) if (!out[key]) out[key] = [state];
    return out;
  }

  close(client: RoomClient | null) {
    this.gone = true;
    this.p2p.then((p) => p.p2pLeave(this.name, this.hearDirect)).catch(() => { /* never joined */ });
    if (this.sb && client) client.removeChannel(this.sb as unknown as RoomChannel);
    this.sb = null;
  }

  /* ---------------------------------------------------------------- */

  /** On the relay, this app's presence carries its direct address, so a partner's app can connect. */
  private relayState(state: Record<string, unknown>) {
    return this.addr ? { ...state, p2p: this.addr } : state;
  }

  private hearDirect = (e: P2pEvent) => {
    if (this.gone) return;
    // a partner's app can arrive before the join's answer (it waits on the relay for the address)
    this.joined = true;
    if (e.kind === "peer") {
      if (e.up) {
        if (this.mine) this.track(this.mine);        // so they know who we are
        this.ready();
      } else if (this.direct.delete(e.peer)) this.firePresence();
      return;
    }
    let m: any;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.k === "b") this.deliver(m.event, m.payload);
    else if (m.k === "p" && m.key) { this.direct.set(e.from, { key: m.key, state: m.state }); this.firePresence(); }
    else if (m.k === "u") { if (this.direct.delete(e.from)) this.firePresence(); }
  };

  private deliver(event: string, payload: any) {
    if (payload && typeof payload._m === "string") {
      if (this.seen.has(payload._m)) return;
      this.remember(payload._m);
    }
    for (const f of this.bc.get(event) || []) f({ payload });
  }

  private remember(id: string) {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 2000) this.seen.delete(this.seenOrder.shift()!);
  }

  private dialFromRelay() {
    if (!this.joined) return;
    for (const [k, entries] of Object.entries(this.sbState)) {
      if (k === this.key) continue;
      for (const e of entries) if (e && typeof e.p2p === "string") this.p2p.then((p) => p.p2pDial(this.name, e.p2p));
    }
  }

  private firePresence() {
    this.pres.forEach((f) => { try { f(); } catch { /* the room's own trouble */ } });
  }

  /** In the room: the relay is up, or a partner's app is here, or (alone offline) after a wait. */
  private ready() {
    if (this.told || this.gone) return;
    this.told = true;
    this.status?.("SUBSCRIBED");
  }

  private failIfBoth(e: unknown) {
    if (this.gone || this.told || !(this.directFailed && this.relayFailed)) return;
    this.status?.("CHANNEL_ERROR", e instanceof Error ? e : new Error(String(e)));
  }
}

const appRooms: RoomClient = {
  channel: (name, opts) => new BothRoads(name, opts?.config?.presence?.key || rid()),
  removeChannel: async (ch) => {
    const client = relay ? await relay.catch(() => null) : null;
    (ch as BothRoads).close(client);
    return "ok";
  },
};

/** On the site: the signed-in client first, and a plain one for a second room on the same name. */
let siteRooms: RoomClient | null = null;
function webRooms(): RoomClient {
  if (!siteRooms) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "", key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
    siteRooms = pooled(supabaseBrowser(), () => anonClient(url, key));
  }
  return siteRooms;
}

/** The client to open a room's channel on. Shared: one per page. */
export function realtime(): Promise<RoomClient> {
  if (isDesktop()) return Promise.resolve(appRooms);
  return Promise.resolve(webRooms());
}
