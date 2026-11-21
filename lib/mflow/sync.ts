/**
 * Flowing with your partner: what changed between two copies of a round, as a
 * patch to send, and a partner's patch put onto yours. Cells merge one by one
 * (last writer wins, as the old Flow did: two people flowing a round write in
 * different places almost always); the sheets, the round's info and the RFD go
 * whole when they change.
 */
import type { Round, Cell, Sheet } from "./model";

export interface Patch {
  cells: { s: string; k: string; c: Cell | null }[];
  meta?: { sheets: { id: string; name: string; kind: Sheet["kind"] }[]; info: Round["info"]; rfd: string; order: Round["order"] };
}

const sameCell = (a?: Cell, b?: Cell) => JSON.stringify(a || null) === JSON.stringify(b || null);

export function diff(a: Round | null, b: Round): Patch | null {
  const cells: Patch["cells"] = [];
  const before = new Map((a?.sheets || []).map((s) => [s.id, s]));
  for (const s of b.sheets) {
    const old = before.get(s.id);
    const keys = new Set([...Object.keys(s.cells), ...Object.keys(old?.cells || {})]);
    for (const k of keys) if (!sameCell(old?.cells[k], s.cells[k])) cells.push({ s: s.id, k, c: s.cells[k] || null });
  }
  const shape = (r: Round | null) => (r ? JSON.stringify([r.sheets.map((s) => [s.id, s.name, s.kind]), r.info, r.rfd, r.order]) : "");
  const meta = shape(a) !== shape(b) ? { sheets: b.sheets.map((s) => ({ id: s.id, name: s.name, kind: s.kind })), info: b.info, rfd: b.rfd, order: b.order } : undefined;
  if (!cells.length && !meta) return null;
  return { cells, meta };
}

export function patch(r: Round, p: Patch): Round {
  let sheets = r.sheets;
  if (p.meta) {
    const have = new Map(r.sheets.map((s) => [s.id, s]));
    sheets = p.meta.sheets.map((m) => ({ ...(have.get(m.id) || { cells: {} }), id: m.id, name: m.name, kind: m.kind } as Sheet));
  }
  if (p.cells.length) {
    const bySheet = new Map<string, Patch["cells"]>();
    for (const c of p.cells) { const l = bySheet.get(c.s) || []; l.push(c); bySheet.set(c.s, l); }
    sheets = sheets.map((s) => {
      const l = bySheet.get(s.id);
      if (!l) return s;
      const cells = { ...s.cells };
      for (const c of l) { if (c.c) cells[c.k] = c.c; else delete cells[c.k]; }
      return { ...s, cells };
    });
  }
  return {
    ...r, sheets, updated: Date.now(),
    ...(p.meta ? { info: p.meta.info, rfd: p.meta.rfd, order: p.meta.order } : {}),
  };
}
