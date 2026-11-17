"use client";

import { useEffect, useRef } from "react";
import type { SlashAt } from "@/lib/cutter/slash";

/** One line of the menu: a whole block (ai null) or one card of it. */
export interface SlashRow {
  id: string; ai: number | null; title: string; sub: string;
  /** the card tags it is: one, or all of a block's */
  tags: string[];
  /** which card of the block each tag is */
  ais: number[];
  /** the block's name */
  block: string;
}

/** What "/words" finds in the library: each block, then the cards in it the words found (a few). */
export function slashRows(q: string): SlashRow[] | null {
  const EV = (typeof window !== "undefined" ? (window as any).EV : null);
  if (!EV?.quickFind) return null;
  const rows: SlashRow[] = [];
  for (const r of EV.quickFind(q, 8) as { id: string; title: string; where: string; args: string[]; hits: number[] }[]) {
    const n = r.args.length;
    const tag = (a: string) => a.replace(/\s+/g, " ").trim();
    const all = r.args.map((a, ai) => ({ t: tag(a), ai })).filter((x) => x.t);
    rows.push({ id: r.id, ai: null, title: r.title || "Untitled block", sub: [r.where, n === 1 ? "1 card" : n + " cards"].filter(Boolean).join(" · "), tags: all.map((x) => x.t), ais: all.map((x) => x.ai), block: r.title });
    for (const ai of r.hits.slice(0, 3)) {
      if (r.args[ai] === undefined) continue;
      rows.push({ id: r.id, ai, title: r.args[ai] || "Card " + (ai + 1), sub: "", tags: [tag(r.args[ai])].filter(Boolean), ais: [ai], block: r.title });
    }
  }
  return rows;
}

/** The menu under the "/words" line: fixed to the window, above the line when the line is low. */
export default function SlashFind({ at, rows, sel, onPick, onSel, width = 400, hint = "Enter puts it in" }: {
  at: Pick<SlashAt, "q" | "left" | "top" | "bottom">; rows: SlashRow[] | null; sel: number;
  onPick: (r: SlashRow) => void; onSel: (i: number) => void;
  width?: number; hint?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    (box.current?.querySelector(".on") as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  }, [sel, rows]);
  const W = width, H = 340;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = Math.max(8, Math.min(at.left - 10, vw - W - 8));
  const below = vh - at.bottom - 12;
  const pos: React.CSSProperties = below >= Math.min(H, 180) || below >= at.top
    ? { left, top: at.bottom + 6, maxHeight: Math.min(H, below) }
    : { left, bottom: vh - at.top + 6, maxHeight: Math.min(H, at.top - 12) };
  const note = rows === null ? "The library is still loading"
    : !at.q.trim() ? "Type to find a card in your library"
    : !rows.length ? `Nothing in your library for “${at.q.trim().slice(0, 40)}”` : "";
  return (
    <div className="rm-slash" ref={box} style={{ ...pos, width: W }} role="listbox" aria-label="Cards in your library"
      onMouseDown={(e) => e.preventDefault() /* the cursor stays in the speech doc */}>
      {note ? <div className="rm-slash-note">{note}</div> : rows!.map((r, i) => (
        <button key={r.id + ":" + r.ai} type="button" role="option" aria-selected={i === sel}
          className={"rm-slash-row" + (r.ai === null ? " blk" : " card") + (i === sel ? " on" : "")}
          onMouseEnter={() => onSel(i)} onClick={() => onPick(r)}>
          <b>{r.title}</b>
          {r.sub && <small>{r.sub}</small>}
        </button>
      ))}
      <div className="rm-slash-keys">↑ ↓ choose · {hint} · Esc closes</div>
    </div>
  );
}
