import { joinFlow, type Peer, type Session, type Status } from "@/lib/flow/share";

/**
 * Reading a partner's send doc, live.
 *
 * The viewer joins the same room a flow and an Evidence tab share, as a
 * reader. Evidence sees a reader arrive and sends the whole send document —
 * gzipped, base64, in pieces (see publishHtml in the Evidence engine) — and
 * sends it again whenever it changes. Pieces of one version share an id;
 * when every piece of a version is in, it is unpacked and handed over.
 */

export interface RoomDoc { html: string; by: string; at: number }

export interface ViewerRoom { code: string; leave: () => void; ask: () => void }

async function unpack(enc: string, data: string) {
  if (enc !== "gzip") return data;
  const bin = atob(data);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export function readRoom(code: string, me: string, h: {
  onDoc: (d: RoomDoc) => void;
  onPeers: (peers: Peer[]) => void;
  onStatus: (s: Status, detail?: string) => void;
}): ViewerRoom {
  const parts = new Map<string, { n: number; got: Map<number, string>; enc: string; by: string; at: number }>();
  let newest = 0;
  const session: Session = joinFlow(code, me, {
    onEvent: async (type, d) => {
      if (type !== "senddoc-html" || !d || typeof d.part !== "string") return;
      let p = parts.get(d.id);
      if (!p) { p = { n: d.n, got: new Map(), enc: d.enc, by: d.by, at: d.at }; parts.set(d.id, p); }
      p.got.set(d.i, d.part);
      if (p.got.size < p.n) return;
      parts.delete(d.id);
      // an older version finishing after a newer one is not news
      if (p.at < newest) return;
      newest = p.at;
      try {
        const data = Array.from({ length: p.n }, (_, i) => p!.got.get(i) || "").join("");
        h.onDoc({ html: await unpack(p.enc, data), by: p.by, at: p.at });
      } catch { /* a broken version; the next one will do */ }
    },
    onPeers: h.onPeers,
    onStatus: h.onStatus,
    snapshot: () => null,
  }, "viewer");
  return {
    code,
    leave: () => session.leave(),
    ask: () => session.send("askdoc", null),
  };
}
