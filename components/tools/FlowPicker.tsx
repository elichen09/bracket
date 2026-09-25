"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { listRounds, roundHasWriting, type Kind, type RoundMeta } from "@/lib/pastflows";

/**
 * Which flow — asked when Flow or Doc flow opens.
 *
 * The flow you were last on comes first and Enter keeps it, so the question
 * costs one key when the answer is "the same one". Below it, the last few
 * rounds from Past flows in this tool, and a new one. Esc keeps going too.
 */

export interface PickerCurrent { id: string; name: string; stats?: string; blank: boolean }

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? "yesterday" : `${d} days ago`;
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
};

type Item = { k: "cur" | "old" | "new"; id?: string; name: string; sub: string; when?: string };

/** Whether there is anything to ask about: a flow with writing in it, or others to go back to. */
export async function worthAsking(owner: string | null | undefined, kind: Kind, current: PickerCurrent): Promise<boolean> {
  if (!current.blank) return true;
  const all = await listRounds(owner);
  return all.some((r) => r.kind === kind && r.id !== current.id && roundHasWriting(r));
}

export default function FlowPicker({ owner, kind, current, onOpen, onNew, onClose }: {
  owner?: string | null;
  kind: Kind;
  current: PickerCurrent;
  onOpen: (id: string, name: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [rounds, setRounds] = useState<RoundMeta[] | null>(null);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const word = kind === "grid" ? "round" : "flow";

  useEffect(() => {
    let dead = false;
    listRounds(owner).then((all) => {
      if (!dead) setRounds(all.filter((r) => r.kind === kind && roundHasWriting(r)));
    });
    return () => { dead = true; };
  }, [owner, kind]);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    const mine = rounds?.find((r) => r.id === current.id);
    if (!current.blank) list.push({ k: "cur", id: current.id, name: mine?.name || current.name, sub: mine?.stats || current.stats || "", when: mine ? ago(mine.updated) : undefined });
    (rounds || []).filter((r) => r.id !== current.id).slice(0, 7)
      .forEach((r) => list.push({ k: "old", id: r.id, name: r.name, sub: r.stats, when: ago(r.updated) }));
    list.push({ k: "new", name: `New ${word}`, sub: current.blank ? "The blank one already open" : `This one stays in Past flows` });
    return list;
  }, [rounds, current, word]);

  useEffect(() => { box.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>(".fp-it.on")?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const choose = (it: Item) => {
    if (it.k === "cur") return onClose();
    if (it.k === "new") return current.blank ? onClose() : onNew();
    onOpen(it.id!, it.name);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp") { e.preventDefault(); setAt((i) => (i + (k === "ArrowDown" ? 1 : -1) + items.length) % items.length); }
    else if (k === "Enter") { e.preventDefault(); const it = items[Math.min(at, items.length - 1)]; if (it) choose(it); }
    else if (k === "Escape") { e.preventDefault(); onClose(); }
    else if ((k === "n" || k === "N") && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); choose(items[items.length - 1]); }
    else if (/^[1-9]$/.test(k)) { const it = items[+k - 1]; if (it) { e.preventDefault(); choose(it); } }
    else return;
    e.stopPropagation();
  };

  return (
    <div className="fpick" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fp-card" role="dialog" aria-modal="true" aria-label={`Which ${word}`} tabIndex={-1} ref={box} onKeyDown={onKey}>
        <div className="fp-head">
          <b>Which {word}?</b>
          <span>{kind === "grid" ? "Flow" : "Doc flow"}</span>
        </div>
        <ul className="fp-list" role="listbox">
          {items.map((it, i) => (
            <li key={it.k + (it.id || "")}>
              <button type="button" role="option" aria-selected={i === at}
                className={"fp-it " + it.k + (i === at ? " on" : "")}
                onMouseEnter={() => setAt(i)} onClick={() => choose(it)}>
                <span className="fp-n">{i < 9 ? i + 1 : ""}</span>
                <span className="fp-t">
                  <span className="fp-tag">{it.k === "cur" ? "Keep going" : it.k === "new" ? "Start fresh" : "Past " + word}</span>
                  <b>{it.name}</b>
                  {it.sub && <small>{it.sub}</small>}
                </span>
                {it.when && <span className="fp-w">{it.when}</span>}
              </button>
            </li>
          ))}
          {rounds === null && <li className="fp-wait">Looking in Past flows…</li>}
        </ul>
        <div className="fp-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> choose</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>N</kbd> new</span>
          <span><kbd>Esc</kbd> keep going</span>
          <Link href="/tools/flows" className="fp-all">Every past flow →</Link>
        </div>
      </div>
    </div>
  );
}
