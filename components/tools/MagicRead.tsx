"use client";

import { useMemo, useRef } from "react";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "@/lib/evidence/docSchema";
import { readHighlight } from "@/lib/cutter/reference";
import { readWords } from "@/lib/cutter/verbatim";

/**
 * Round Magic's Read mode: a document the way it will be read out.
 *
 * Tags big, the cite under them, and in each card only what is highlighted
 * set large — the rest of the card small and grey, or gone altogether. Down
 * the side, the pace you read at and what that makes the speech: its length,
 * and every card's. The words counted are the ones Verbatimise shows and the
 * outline counts (lib/cutter/verbatim.ts): tags and analytics whole, cards
 * where they are highlighted (grey is a card kept for reference, not read).
 */

const count = (s: string) => (s.replace(/-{2,}/g, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
export const clock = (secs: number) => {
  const s = Math.max(0, Math.round(secs));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

type Run = { text: string; read: boolean; bold: boolean };
type Item =
  | { k: "sec"; level: number; text: string; pos: number }
  | { k: "tag"; text: string; pos: number; n: number }
  | { k: "cite"; runs: Run[] }
  | { k: "body"; runs: Run[]; any: boolean }
  | { k: "plain"; text: string };

interface CardRow { n: number; text: string; words: number; pos: number }

function runsOf(node: PMNode): Run[] {
  const out: Run[] = [];
  node.forEach((t) => {
    if (!t.isText) return;
    const read = readHighlight(t), bold = t.marks.some((m) => m.type === schema.marks.strong);
    const last = out[out.length - 1];
    if (last && last.read === read && last.bold === bold) last.text += t.text;
    else out.push({ text: t.text || "", read, bold });
  });
  return out;
}

function survey(doc: PMNode): { items: Item[]; cards: CardRow[] } {
  const items: Item[] = [], cards: CardRow[] = [];
  let inCard = false, citeNext = false;
  let card: CardRow | null = null;
  doc.forEach((node, pos) => {
    if (node.type === schema.nodes.heading) {
      const text = node.textContent.trim();
      if (node.attrs.level === 4) {
        inCard = true; citeNext = true;
        card = { n: cards.length, text: text || "(untitled)", words: count(text), pos };
        cards.push(card);
        items.push({ k: "tag", text: text || "(untitled)", pos, n: card.n });
      } else {
        inCard = false; card = null;
        if (text) items.push({ k: "sec", level: node.attrs.level, text, pos });
      }
      return;
    }
    if (node.type !== schema.nodes.paragraph || !node.textContent.trim()) return;
    if (!inCard) { items.push({ k: "plain", text: node.textContent }); return; }
    if (citeNext) { citeNext = false; if (!/^<<.*>>$/.test(node.textContent.trim())) { items.push({ k: "cite", runs: runsOf(node) }); return; } }
    const runs = runsOf(node);
    const any = runs.some((r) => r.read);
    if (card) card.words += runs.filter((r) => r.read).reduce((n, r) => n + count(r.text), 0);
    items.push({ k: "body", runs, any });
  });
  return { items, cards };
}

export default function MagicRead({ doc, source, setSource, hasSpeech, wpm, setWpm, hideDim, setHideDim, onEdit, onExit }: {
  doc: PMNode | null;
  source: "speech" | "file"; setSource: (s: "speech" | "file") => void; hasSpeech: boolean;
  wpm: number; setWpm: (n: number) => void;
  hideDim: boolean; setHideDim: (b: boolean) => void;
  /** a click on a tag: back to editing, at that card */
  onEdit: (pos: number) => void;
  onExit: () => void;
}) {
  const page = useRef<HTMLElement>(null);
  const { items, cards } = useMemo(() => (doc ? survey(doc) : { items: [], cards: [] }), [doc]);
  const total = useMemo(() => (doc ? readWords(doc) : 0), [doc]);
  const secs = (total / Math.max(60, wpm)) * 60;
  const goCard = (n: number) => {
    const el = page.current?.querySelector(`[data-card="${n}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className={"rm-readview" + (hideDim ? " hide-dim" : "")}>
      <div className="rm-rmain">
        <div className="rm-rbar">
          <span>READING</span>
          <div className="rm-lseg" role="group" aria-label="Read which document">
            <button type="button" className="rm-lbtn" aria-pressed={source === "speech"} disabled={!hasSpeech} onClick={() => setSource("speech")}>SPEECH DOC</button>
            <button type="button" className="rm-lbtn" aria-pressed={source === "file"} onClick={() => setSource("file")}>THIS FILE</button>
          </div>
          <span className="rm-grow" />
          <button type="button" className="rm-lbtn" aria-pressed={hideDim} onClick={() => setHideDim(!hideDim)}>{hideDim ? "SHOW EVERYTHING" : "HIDE UNHIGHLIGHTED"}</button>
          <button type="button" className="rm-lbtn" onClick={onExit}>EXIT · ESC</button>
        </div>
        <article className="rm-rpage" ref={page}>
          {!items.length && (
            <p className="rm-rempty">{source === "speech" ? "Nothing in the speech doc yet. Send cards to it — Alt+Enter on a card, or Enter on a search result — and they read here." : "This file has no cards yet."}</p>
          )}
          {items.map((it, i) => {
            if (it.k === "sec") return <div key={i} className={"rm-rhead" + (it.level === 1 ? " pocket" : "")}>{it.text}</div>;
            if (it.k === "tag") return <h2 key={i} className="rm-rtag" data-card={it.n} title="Edit this card" onClick={() => onEdit(it.pos)}>{it.text}</h2>;
            if (it.k === "cite") return <p key={i} className="rm-rcite">{it.runs.map((r, j) => <span key={j} className={r.bold ? "c" : ""}>{r.text}</span>)}</p>;
            if (it.k === "plain") return <p key={i} className="rm-rplain">{it.text}</p>;
            return (
              <p key={i} className={"rm-rbody" + (it.any ? "" : " dim")}>
                {it.runs.map((r, j) => <span key={j} className={r.read ? "hl" : "dim"}>{r.text}</span>)}
              </p>
            );
          })}
        </article>
      </div>
      <aside className="rm-rrail">
        <div className="rm-cap rm-capline"><label htmlFor="rm-wpm">READING PACE</label><b>{wpm} WPM</b></div>
        <input id="rm-wpm" type="range" min={140} max={380} step={10} value={wpm} onChange={(e) => setWpm(Number(e.target.value))} />
        <div className="rm-est">
          <b>{clock(secs)}</b> to read · {total.toLocaleString()} word{total === 1 ? "" : "s"} · {cards.length} card{cards.length === 1 ? "" : "s"}
        </div>
        <div className="rm-cap">CARDS</div>
        <div className="rm-clist">
          {cards.map((c) => (
            <button key={c.n} type="button" className="rm-cl" onClick={() => goCard(c.n)} title={c.text}>
              <span>{c.text}</span><em>{clock((c.words / Math.max(60, wpm)) * 60)}</em>
            </button>
          ))}
          {!cards.length && <p className="rm-rnote">No tags yet.</p>}
        </div>
      </aside>
    </div>
  );
}
