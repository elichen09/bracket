"use client";

import { useEffect, useRef } from "react";
import type { SlashAt } from "@/lib/cutter/slash";

/**
 * The "/" menu, shared by the speech doc and the flow's cells. It lists blocks first; Enter on a block
 * opens it to its cards (its tags, the heading 4s), Enter on a card takes that card, and Shift+Enter
 * takes the whole block, from either list. Esc in a block's cards goes back to the blocks.
 */

/** One block the words found. */
export interface SlashBlock { id: string; title: string; where: string; args: string[]; hits: number[] }

/** One line of the menu: a block (to open), the whole block, or one card of it. */
export interface SlashRow {
  kind: "block" | "all" | "card";
  id: string; ai: number | null; title: string; sub: string;
  /** the card tags it is: one, or all of a block's */
  tags: string[];
  /** which card of the block each tag is */
  ais: number[];
  /** the block's name */
  block: string;
}

/** The menu as it stands: what was found, the block opened (if one is), the line marked. */
export interface SlashMenu { blocks: SlashBlock[] | null; open: string | null; i: number }

const tag = (a: string) => a.replace(/\s+/g, " ").trim();

/** What "/words" finds in the library: blocks. Null while the library is still loading. */
export function slashFind(q: string): SlashBlock[] | null {
  const EV = (typeof window !== "undefined" ? (window as any).EV : null);
  if (!EV?.quickFind) return null;
  return EV.quickFind(q, 10) as SlashBlock[];
}

function wholeOf(b: SlashBlock, kind: "block" | "all"): SlashRow {
  const n = b.args.length;
  const all = b.args.map((a, ai) => ({ t: tag(a), ai })).filter((x) => x.t);
  const count = n === 1 ? "1 card" : n + " cards";
  return {
    kind, id: b.id, ai: null, title: b.title || "Untitled block",
    sub: kind === "all" ? "The whole block · " + count : [b.where, count].filter(Boolean).join(" · "),
    tags: all.map((x) => x.t), ais: all.map((x) => x.ai), block: b.title,
  };
}

/** The lines showing: the blocks, or one block's cards under a line for the whole of it. */
export function slashRows(m: SlashMenu): SlashRow[] | null {
  if (!m.blocks) return null;
  const b = m.open ? m.blocks.find((x) => x.id === m.open) : null;
  if (!b) return m.blocks.map((x) => wholeOf(x, "block"));
  return [wholeOf(b, "all"), ...b.args.map((a, ai): SlashRow => ({
    kind: "card", id: b.id, ai, title: tag(a) || "Card " + (ai + 1), sub: "", tags: [tag(a)].filter(Boolean), ais: [ai], block: b.title,
  }))];
}

/** The menu for these words: kept as it was (opened, marked) while the words are the same. */
export function slashFor(q: string, was: { q: string; menu: SlashMenu } | null): SlashMenu {
  if (was && was.q === q && was.menu.blocks) return was.menu;
  return { blocks: slashFind(q), open: null, i: 0 };
}

type Step = { menu?: SlashMenu; pick?: SlashRow };

/** A row chosen (Enter, or a click): a block opens to its cards; a card, or the whole, is taken. Shift: the whole block. */
export function slashChoose(m: SlashMenu, i: number, whole: boolean): Step {
  const rows = slashRows(m);
  const r = rows?.[Math.min(i, (rows?.length || 1) - 1)];
  if (!r || !m.blocks) return {};
  const b = m.blocks.find((x) => x.id === r.id);
  if (whole) return { pick: b ? wholeOf(b, "all") : r };
  if (r.kind !== "block") return { pick: r };
  if (!b || !b.args.length) return { pick: r };
  // its cards, the first one the words found marked
  return { menu: { ...m, open: b.id, i: 1 + (b.hits.find((h) => h < b.args.length) ?? 0) } };
}

/** A key while the menu is up: what it does, or null when the menu doesn't take it. */
export function slashStep(m: SlashMenu, e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): Step | null {
  const rows = slashRows(m);
  if (e.key === "Escape" && m.open) {
    // back to the blocks, on the one that was open
    const at = (m.blocks || []).findIndex((x) => x.id === m.open);
    return { menu: { ...m, open: null, i: Math.max(0, at) } };
  }
  if (!rows?.length) return null;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") return { menu: { ...m, i: (m.i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length } };
  if ((e.key === "Enter" || e.key === "Tab") && !e.ctrlKey && !e.altKey && !e.metaKey) return slashChoose(m, m.i, e.shiftKey);
  return null;
}

/** The menu under the "/words" line: fixed to the window, above the line when the line is low. */
export default function SlashFind({ at, menu, onMenu, onPick, width = 400, verb = "adds" }: {
  at: Pick<SlashAt, "q" | "left" | "top" | "bottom">; menu: SlashMenu;
  onMenu: (m: SlashMenu) => void; onPick: (r: SlashRow) => void;
  width?: number; verb?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const rows = slashRows(menu);
  useEffect(() => {
    (box.current?.querySelector(".on") as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  }, [menu]);
  const W = width, H = 360;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = Math.max(8, Math.min(at.left - 10, vw - W - 8));
  const below = vh - at.bottom - 12;
  const pos: React.CSSProperties = below >= Math.min(H, 180) || below >= at.top
    ? { left, top: at.bottom + 6, maxHeight: Math.min(H, below) }
    : { left, bottom: vh - at.top + 6, maxHeight: Math.min(H, at.top - 12) };
  const note = rows === null ? "The library is still loading"
    : !at.q.trim() ? "Type to find a block in your library"
    : !rows.length ? `Nothing in your library for “${at.q.trim().slice(0, 40)}”` : "";
  const click = (i: number, shift: boolean) => {
    const s = slashChoose(menu, i, shift);
    if (s.pick) onPick(s.pick); else if (s.menu) onMenu(s.menu);
  };
  return (
    <div className="rm-slash" ref={box} style={{ ...pos, width: W }} role="listbox" aria-label="Blocks in your library"
      onMouseDown={(e) => e.preventDefault() /* the cursor stays where you're typing */}>
      {note ? <div className="rm-slash-note">{note}</div> : rows!.map((r, i) => (
        <button key={r.kind + ":" + r.id + ":" + r.ai} type="button" role="option" aria-selected={i === menu.i}
          className={"rm-slash-row " + r.kind + (i === menu.i ? " on" : "")}
          onMouseEnter={() => { if (menu.i !== i) onMenu({ ...menu, i }); }} onClick={(e) => click(i, e.shiftKey)}>
          <b>{r.kind === "block" && <span className="rm-slash-open" aria-hidden="true">›</span>}{r.title}</b>
          {r.sub && <small>{r.sub}</small>}
        </button>
      ))}
      <div className="rm-slash-keys">{menu.open
        ? `↑ ↓ choose · Enter ${verb} the card · Shift+Enter the whole block · Esc back`
        : `↑ ↓ choose · Enter shows its cards · Shift+Enter ${verb} the whole block · Esc closes`}</div>
    </div>
  );
}
