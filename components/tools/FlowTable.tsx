"use client";

import { useEffect, useRef, useState } from "react";
import { toDocsHtml, type FlowSection } from "@/lib/gflowTable";
import { RESPONSE_COLOUR } from "@/lib/gdocsApi";
import { scoped } from "@/lib/owner";
import SlashFind, { slashRows, type SlashRow } from "./SlashFind";

/**
 * Your partner's flow tab, as tables you write in.
 *
 * Each numbered argument in the Doc is a row; its lettered responses fill the
 * Responses cell, one a line. Type in that cell like a spreadsheet — Enter
 * starts the next response, Tab goes on to the next row, ↑ and ↓ off the
 * edge of a cell move between rows — and in the blank row at the bottom of a
 * part to add an argument. What you write is kept here, against the Doc and
 * the argument, until the Doc says the same: COPY FOR DOCS puts the whole
 * flow on the clipboard as the Doc's own numbered and lettered lists, to
 * paste over the flow tab (click in it, Ctrl+A, Ctrl+V). A Google Doc cannot
 * be written to from outside without a Google sign-in; this is the way
 * without one.
 */

interface Edits { rows: Record<string, string[]>; added: { arg: string; responses: string[] }[] }
type All = Record<string, Edits>;

const secKey = (s: FlowSection, i: number) => (s.title || "") + "#" + i;
/** between the parts of a cell's id (a part's title can hold almost anything but a tab) */
const SEP = "\t";
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
// kept as typed — a line just started with Enter is still there; blank lines are dropped only on the way out
const linesOf = (v: string) => v.split("\n");

/** What has changed in one part, to be written into the Doc. */
export interface SectionWrite { si: number; rows: { arg: string; responses: string[] }[]; added: { arg: string; responses: string[] }[] }

/** A card put in the speech doc from a cell of the flow ("/"): enough to find it there again, or send it again. */
export interface FlowedCard { id: string; ai: number; block: string; tag: string }

export default function FlowTable({ sections, docKey, owner, onLook, toast, writer, compact, onUnflow }: {
  sections: FlowSection[]; compact?: boolean; docKey: string; owner?: string | null; onLook: (text: string) => void; toast: (s: string) => void;
  /** cells deleted that had flowed cards into the speech doc: those cards out of it too */
  onUnflow?: (cards: FlowedCard[]) => number;
  /** connected to Google: what you write goes into the Doc by itself */
  writer?: (w: SectionWrite[]) => Promise<void>;
}) {
  const store = scoped("gflow.edits", owner) + ":" + docKey;
  const [edits, setEdits] = useState<All>({});
  // what was written is read back first; only after that is anything written over it
  const loadedFor = useRef("");
  const skip = useRef(false);
  useEffect(() => {
    try { setEdits(JSON.parse(localStorage.getItem(store) || "{}") || {}); } catch { setEdits({}); }
    loadedFor.current = store;
    skip.current = true;
  }, [store]);
  useEffect(() => {
    if (loadedFor.current !== store) return;
    if (skip.current) { skip.current = false; return; }      // the render before what was kept arrives
    try { localStorage.setItem(store, JSON.stringify(edits)); } catch { /* private browsing */ }
  }, [edits, store]);

  // what the Doc now says, once it says it, is no longer an edit of yours
  useEffect(() => {
    setEdits((all) => {
      let changed = false;
      const next: All = { ...all };
      sections.forEach((s, i) => {
        const k = secKey(s, i), e = next[k];
        if (!e) return;
        const rows = { ...e.rows };
        const typing = (document.activeElement as HTMLElement | null)?.closest?.("tr")?.getAttribute("data-arg");
        s.rows.forEach((r) => { if (rows[r.arg] && r.arg !== typing && same(rows[r.arg].map((x) => x.trim()).filter(Boolean), r.responses)) { delete rows[r.arg]; changed = true; } });
        const added = e.added.filter((a) => !s.rows.some((r) => r.arg === a.arg.trim()) || (changed = true, false));
        next[k] = { rows, added };
      });
      return changed ? next : all;
    });
  }, [sections]);

  // ---- which cells put which cards in the speech doc: by part, row and what the cell says
  const linkStore = store + ":sent";
  const links = useRef<Record<string, FlowedCard[]>>({});
  useEffect(() => { try { links.current = JSON.parse(localStorage.getItem(linkStore) || "{}") || {}; } catch { links.current = {}; } }, [linkStore]);
  const saveLinks = () => { try { localStorage.setItem(linkStore, JSON.stringify(links.current)); } catch { /* private browsing */ } };
  const linkKey = (k: string, row: string, cell: string) => k + SEP + row + SEP + cell.replace(/\s+/g, " ").trim();
  /** Cards no other cell still points at: only those come out of the speech doc. */
  const unused = (cards: FlowedCard[]) => {
    const n = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();
    const live = new Set(Object.values(links.current).flat().map((c) => n(c.block) + SEP + n(c.tag)));
    return cards.filter((c) => !live.has(n(c.block) + SEP + n(c.tag)));
  };
  const link = (key: string, cards: FlowedCard[]) => { links.current[key] = cards; saveLinks(); };
  /** A linked cell's words changed: the link follows them — and a cell emptied takes its cards out. */
  const relink = (from: string, to: string | null) => {
    const c = links.current[from];
    if (!c || from === to) return;
    delete links.current[from];
    if (to && !to.endsWith(SEP)) links.current[to] = c;
    else onUnflow?.(unused(c));
    saveLinks();
  };

  const edit = (k: string, f: (e: Edits) => Edits) => setEdits((all) => ({ ...all, [k]: f(all[k] || { rows: {}, added: [] }) }));

  /** The flow as it will be: the Doc, with what you have written. */
  const merged = sections.map((s, i) => {
    const k = secKey(s, i), e = edits[k] || { rows: {}, added: [] };
    let n = s.rows.length ? s.rows[s.rows.length - 1].n : 0;
    const colour = s.rows[0]?.color || "";
    return {
      k, title: s.title,
      rows: [
        ...s.rows.map((r) => ({ ...r, responses: e.rows[r.arg] ?? r.responses, mine: !!e.rows[r.arg] && !same(e.rows[r.arg].map((x) => x.trim()).filter(Boolean), r.responses), added: -1 })),
        ...e.added.map((a, j) => ({ a, j })).filter(({ a }) => a.arg.trim() || a.responses.some((x) => x.trim()))
          .map(({ a, j }) => ({ n: ++n, arg: a.arg, color: colour, responses: a.responses, mine: true, added: j })),
      ],
      next: n + 1,
    };
  });
  const pending = merged.reduce((t, s) => t + s.rows.filter((r) => r.mine).length, 0);

  // ---- connected: what you write goes into the Doc a moment after you stop
  const [saving, setSaving] = useState<"" | "saving" | "error">("");
  const mergedRef = useRef(merged);
  mergedRef.current = merged;
  const busy = useRef(false);
  const timer = useRef(0);
  // what each row was last written as: the same thing is never written twice (if the Doc reads it back
  // differently, writing it again would only add it again)
  const sent = useRef(new Map<string, string>());
  const [stuck, setStuck] = useState(0);
  const flush = async () => {
    if (!writer) return;
    if (busy.current) { clearTimeout(timer.current); timer.current = window.setTimeout(() => void flush(), 700); return; }
    // an argument still being typed waits until you leave its row
    const here = (document.activeElement as HTMLElement | null)?.closest?.("tr")?.getAttribute("data-addkey");
    const writes: SectionWrite[] = [];
    const marks: [string, string][] = [];
    let held = 0;
    const fresh = (key: string, value: string) => { if (sent.current.get(key) === value) { held++; return false; } marks.push([key, value]); return true; };
    mergedRef.current.forEach((s, si) => {
      const rows = s.rows.filter((r) => r.added < 0 && r.mine).map((r) => ({ arg: r.arg, responses: r.responses.map((x) => x.trim()).filter(Boolean) }))
        .filter((r) => fresh(s.k + "|" + r.arg, JSON.stringify(r.responses)));
      const added = s.rows.filter((r) => r.added >= 0 && r.arg.trim() && here !== s.k + ":" + r.added)
        .map((r) => ({ arg: r.arg.trim(), responses: r.responses.map((x) => x.trim()).filter(Boolean) }))
        .filter((a) => fresh(s.k + "|+" + a.arg, JSON.stringify(a.responses)));
      if (rows.length || added.length) writes.push({ si, rows, added });
    });
    setStuck(held);
    if (!writes.length) return;
    busy.current = true;
    setSaving("saving");
    try { await writer(writes); marks.forEach(([k, v]) => sent.current.set(k, v)); setSaving(""); }
    catch (e) { setSaving("error"); toast((e as Error).message || "Couldn't write to the Doc"); }
    // what wasn't written stays marked, and goes in once Google is connected again
    finally { busy.current = false; }
  };
  const later = (ms = 1100) => { if (!writer) return; clearTimeout(timer.current); timer.current = window.setTimeout(() => void flush(), ms); };
  useEffect(() => { later(); }, [edits, writer]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const { html: h, text } = toDocsHtml(merged.map((s) => ({ title: s.title, rows: s.rows.filter((r) => r.arg.trim()).map((r) => ({ n: r.n, arg: r.arg.trim(), color: r.color, responses: r.responses })) })));
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([h], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
      toast("Copied — in the Doc's flow tab: click in it, Ctrl+A, Ctrl+V");
    } catch {
      toast("The browser would not copy — allow the clipboard for this site");
    }
  };

  // Excel's keys: Tab on to the next cell, ↑ ↓ off a cell's edge to the row above or below
  const box = useRef<HTMLDivElement>(null);
  const cells = () => Array.from(box.current?.querySelectorAll<HTMLTextAreaElement>("textarea[data-cell]") || []);
  const go = (from: HTMLTextAreaElement, d: number) => {
    const all = cells(), i = all.indexOf(from), to = all[i + d];
    if (!to) return false;
    to.focus();
    return true;
  };
  const place = (t: HTMLTextAreaElement, at: number) => requestAnimationFrame(() => t.setSelectionRange(at, at));
  const keys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    const after = () => document.activeElement as HTMLTextAreaElement;
    // Tab: the next cell, ready to add to; ↑ ↓ off a cell's edge: the row above or below
    if (e.key === "Tab") { if (go(t, e.shiftKey ? -1 : 1)) { e.preventDefault(); place(after(), after().value.length); } return; }
    if (e.key === "ArrowDown") { if (go(t, 1)) { e.preventDefault(); place(after(), 0); } return; }
    if (e.key === "ArrowUp") { if (go(t, -1)) { e.preventDefault(); place(after(), after().value.length); } return; }
    if (e.key === "Escape") t.blur();
  };

  // ---- "/" in a cell: the library, searched there; a card chosen flows as its tag (a block, as its tags)
  type Slash = { cell: string; q: string; left: number; top: number; bottom: number; rows: SlashRow[] | null; i: number; apply: (r: SlashRow) => void };
  const [sl, setSl] = useState<Slash | null>(null);
  const slRef = useRef(sl);
  slRef.current = sl;
  const shut = useRef("");
  /** What was just typed in a cell: a "/words" cell opens the menu under it; anything else shuts it. */
  const slashCheck = (t: HTMLTextAreaElement, v: string, cell: string, apply: (r: SlashRow) => void) => {
    const id = cell + "|" + v;
    if (shut.current && shut.current !== id) shut.current = "";
    const on = v.startsWith("/") && !v.startsWith("//") && v.length <= 80 && t.selectionStart === v.length && shut.current !== id;
    if (!on) { if (slRef.current) setSl(null); return; }
    const q = v.slice(1), was = slRef.current, b = t.getBoundingClientRect();
    const same = !!was && was.cell === cell && was.q === q;
    setSl({ cell, q, left: b.left, top: b.top, bottom: b.bottom, rows: same ? was!.rows : slashRows(q), i: same ? was!.i : 0, apply });
  };
  /** What was flowed from the library goes in the speech doc too: the real card (or block), its block's heading on it. */
  const toSpeech = (p: SlashRow) => { void (window as any).EV?.quickSend?.(p.id, p.ai, { head: true, from: "from the flow" }); };
  const cardsOf = (p: SlashRow): FlowedCard[] => p.tags.map((tag, i) => ({ id: p.id, ai: p.ais[i], block: p.block, tag }));
  const pickSlash = (r: SlashRow | undefined) => {
    const s = slRef.current;
    setSl(null);
    if (!s || !r) return;
    if (!r.tags.length && r.ai !== null) { toast("That card has no tag to flow"); return; }
    s.apply(r);
  };
  /** A key in a cell while its menu is up: true when the menu took it. */
  const slashKey = (e: React.KeyboardEvent<HTMLTextAreaElement>, cell: string) => {
    const s = slRef.current;
    if (!s || s.cell !== cell) return false;
    if (e.key === "Escape") { e.preventDefault(); shut.current = cell + "|" + e.currentTarget.value; setSl(null); return true; }
    const rows = s.rows;
    if (!rows?.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setSl({ ...s, i: (s.i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length }); return true; }
    if ((e.key === "Enter" || e.key === "Tab") && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); pickSlash(rows[Math.min(s.i, rows.length - 1)]); return true; }
    return false;
  };

  // ---- several cells at once: Shift+click, a drag across them, or Shift+↑ ↓ off a cell's edge;
  // Delete clears them (Ctrl+Z, straight after, puts them back), Ctrl+C / Ctrl+X copy or cut them
  const [cellSel, setCellSel] = useState<{ a: string; b: string } | null>(null);
  const cellSelRef = useRef(cellSel);
  cellSelRef.current = cellSel;
  const dragFrom = useRef<string | null>(null);
  const lastDel = useRef<{ edits: All; links: Record<string, FlowedCard[]> } | null>(null);
  const cids = () => cells().map((t) => t.getAttribute("data-cid") || "");
  const selected = (): string[] => {
    const s = cellSelRef.current;
    if (!s) return [];
    const all = cids(), i = all.indexOf(s.a), j = all.indexOf(s.b);
    if (i < 0 || j < 0) return [];
    return all.slice(Math.min(i, j), Math.max(i, j) + 1);
  };
  const selSet = new Set(cellSel ? selected() : []);
  const cellText = (ids: string[]) => {
    const els = cells().filter((t) => ids.includes(t.getAttribute("data-cid") || ""));
    return els.map((t) => t.value.trim()).filter(Boolean).join("\n");
  };
  const deleteCells = (ids: string[]) => {
    const resp = new Map<string, Map<number, Set<number>>>(), args = new Map<string, Set<number>>();
    for (const id of ids) {
      const p = id.split(SEP);
      if (p[0] === "r") {
        const k = p.slice(1, -2).join(SEP), ri = +p[p.length - 2], li = +p[p.length - 1];
        if (!resp.has(k)) resp.set(k, new Map());
        const m = resp.get(k)!;
        if (!m.has(ri)) m.set(ri, new Set());
        m.get(ri)!.add(li);
      } else if (p[0] === "a") {
        const k = p.slice(1, -1).join(SEP);
        if (!args.has(k)) args.set(k, new Set());
        args.get(k)!.add(+p[p.length - 1]);
      }
    }
    let n = 0;
    const next: All = { ...edits };
    const gone: Record<string, FlowedCard[]> = {};
    const unlink = (key: string) => { const c = links.current[key]; if (c) { gone[key] = c; delete links.current[key]; } };
    for (const s of mergedRef.current) {
      const rm = resp.get(s.k), am = args.get(s.k);
      if (!rm && !am) continue;
      const e = next[s.k] || { rows: {}, added: [] };
      const rows = { ...e.rows };
      const added = e.added.map((a) => ({ ...a, responses: [...a.responses] }));
      rm?.forEach((lis, ri) => {
        const r = s.rows[ri];
        if (!r) return;
        const keep = r.responses.filter((x, li) => { const go = lis.has(li); if (go && x.trim()) { n++; unlink(linkKey(s.k, r.arg, x)); } return !go; });
        if (r.added >= 0) { if (added[r.added]) added[r.added].responses = keep; }
        else rows[r.arg] = keep;
      });
      am?.forEach((j) => { if (added[j]?.arg.trim()) { n++; unlink(linkKey(s.k, "+", added[j].arg)); added[j].arg = ""; } });
      next[s.k] = { rows, added: added.filter((a) => a.arg.trim() || a.responses.some((x) => x.trim())) };
    }
    if (!n) { setCellSel(null); return; }
    lastDel.current = { edits, links: gone };
    setEdits(next);
    setCellSel(null);
    const cards = unused(Object.values(gone).flat());
    const out = cards.length && onUnflow ? onUnflow(cards) : 0;
    if (Object.keys(gone).length) saveLinks();
    toast(`Deleted ${n === 1 ? "a cell" : n + " cells"}${out ? ` and ${out === 1 ? "its card" : out + " cards"} in the speech doc` : ""} — Ctrl+Z puts ${n === 1 && !out ? "it" : "them"} back`);
  };
  const boxKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLTextAreaElement;
    const cid = t.getAttribute?.("data-cid");
    if (!cid) return;
    const mod = e.ctrlKey || e.metaKey;
    // Ctrl+Z straight after a delete: the cells back
    if (mod && !e.shiftKey && e.key.toLowerCase() === "z" && lastDel.current) {
      e.preventDefault(); e.stopPropagation();
      const d = lastDel.current;
      setEdits(d.edits); lastDel.current = null;
      // the cards too, sent again: into their block, if it's still there
      for (const [k, cs] of Object.entries(d.links)) {
        links.current[k] = cs;
        for (const c of cs) void (window as any).EV?.quickSend?.(c.id, c.ai, { head: true, from: "from the flow" });
      }
      saveLinks();
      return;
    }
    if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt" && e.key !== "Meta" && !(mod && e.key.toLowerCase() === "c")) lastDel.current = null;
    const s = cellSelRef.current;
    if (e.shiftKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown") && !slRef.current) {
      const up = e.key === "ArrowUp";
      const all = cids();
      if (!s) {
        // off the edge of the cell's text: a selection of cells starts
        const atEdge = up ? t.selectionStart === 0 && t.selectionEnd === 0 : t.selectionStart === t.value.length && t.selectionEnd === t.value.length;
        if (!atEdge) return;
      }
      const from = s ? s.a : cid, at = all.indexOf(s ? s.b : cid);
      const to = all[at + (up ? -1 : 1)];
      if (!to) return;
      e.preventDefault(); e.stopPropagation();
      setCellSel({ a: from, b: to });
      return;
    }
    if (!s) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); deleteCells(selected()); return; }
    if (mod && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
      e.preventDefault(); e.stopPropagation();
      const ids = selected(), text = cellText(ids);
      void navigator.clipboard?.writeText(text).catch(() => toast("The browser would not copy — allow the clipboard for this site"));
      if (e.key.toLowerCase() === "x") deleteCells(ids); else toast("Copied");
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setCellSel(null); return; }
    if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
    setCellSel(null);
  };
  const boxDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = (e.target as HTMLElement).closest?.("textarea[data-cid]") as HTMLTextAreaElement | null;
    if (!t) { setCellSel(null); return; }
    const cid = t.getAttribute("data-cid")!;
    if (e.shiftKey) {
      const here = (document.activeElement as HTMLElement | null)?.getAttribute?.("data-cid");
      const a = cellSelRef.current?.a || here || cid;
      e.preventDefault();
      setCellSel({ a, b: cid });
      return;
    }
    setCellSel(null);
    dragFrom.current = cid;
  };
  const boxOver = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragFrom.current || !(e.buttons & 1)) { dragFrom.current = null; return; }
    const t = (e.target as HTMLElement).closest?.("textarea[data-cid]");
    const cid = t?.getAttribute("data-cid");
    if (!cid || (cid === dragFrom.current && !cellSelRef.current)) return;
    if (cellSelRef.current?.b === cid) return;
    // dragging out of one cell into another: cells, not the words in the first
    const src = document.activeElement as HTMLTextAreaElement | null;
    if (src?.setSelectionRange) src.setSelectionRange(src.selectionEnd, src.selectionEnd);
    setCellSel({ a: dragFrom.current, b: cid });
  };
  useEffect(() => {
    const up = () => { dragFrom.current = null; };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);
  const sc = (cid: string) => (selSet.has(cid) ? " csel" : "");

  if (!sections.length) return <p className="rm-gferr">No numbered lists in the flow tab yet.</p>;

  return (
    <div className={"rm-ft" + (compact ? " compact" : "")} ref={box} onKeyDownCapture={boxKey} onMouseDownCapture={boxDown} onPointerOver={boxOver}
      onBlur={(e) => { later(250); if (slRef.current) setSl(null); if (!box.current?.contains(e.relatedTarget as Node)) setCellSel(null); }}>
      {sl && <SlashFind at={sl} rows={sl.rows} sel={sl.i} width={340} hint="Enter flows its tags" onPick={pickSlash} onSel={(i) => setSl((x) => x && { ...x, i })} />}
      <div className="rm-ftbar">
        <span className={saving === "error" ? "bad" : ""}>{writer
          ? (saving === "saving" ? "Writing into the Doc…" : saving === "error" ? "Couldn't write it — it'll try again"
            : stuck && stuck >= pending ? `Written — but the Doc shows ${stuck === 1 ? "a row" : stuck + " rows"} differently; change ${stuck === 1 ? "it" : "them"} here to write again`
            : pending ? `${pending} change${pending === 1 ? "" : "s"} going into the Doc…` : "Saved in the Doc")
          : (pending ? `${pending} change${pending === 1 ? "" : "s"} not in the Doc yet` : "Everything here is in the Doc")}</span>
        <span className="rm-grow" />
        <button type="button" className={"rm-pbtn" + (pending && !writer ? " acc" : "")} onClick={() => void copy()} title="The flow as the Doc's numbered and lettered lists — paste it over the flow tab (click in it, Ctrl+A, Ctrl+V)">COPY FOR DOCS</button>
      </div>
      {merged.map((s) => (
        <section key={s.k} className="rm-fts">
          {s.title && <h3>{s.title}</h3>}
          <table>
            <colgroup><col className="n" /><col className="a" /><col className="r" /></colgroup>
            {!compact && <thead><tr><th>#</th><th>Argument</th><th>Responses</th></tr></thead>}
            <tbody>
              {s.rows.map((r, ri) => (
                <tr key={ri} className={r.mine ? "mine" : ""} data-arg={r.added < 0 ? r.arg : undefined} data-addkey={r.added >= 0 ? s.k + ":" + r.added : undefined}>
                  <td className="n">{r.n}</td>
                  <td className="a">
                    {r.added >= 0 ? (
                      <textarea data-cell data-cid={"a" + SEP + s.k + SEP + r.added} className={sc("a" + SEP + s.k + SEP + r.added)} data-added={s.k + ":" + r.added} value={r.arg} rows={1} spellCheck={false} placeholder="Argument" style={{ color: r.color || undefined }}
                        onKeyDown={(e) => { if (!slashKey(e, "a:" + s.k + ":" + r.added)) keys(e); }}
                        onChange={(e) => {
                          const v = e.target.value.replace(/\n/g, " ");
                          relink(linkKey(s.k, "+", r.arg), linkKey(s.k, "+", v));
                          const setArg = (a: string) => edit(s.k, (x) => ({ ...x, added: x.added.map((y, j) => (j === r.added ? { ...y, arg: a } : y)) }));
                          setArg(v);
                          // an argument of yours from the library: the card's tag (a block: its name)
                          slashCheck(e.target, v, "a:" + s.k + ":" + r.added, (p) => {
                            const a = p.ai === null ? p.title : p.tags[0];
                            setArg(a);
                            toSpeech(p);
                            link(linkKey(s.k, "+", a), cardsOf(p));
                            requestAnimationFrame(() => {
                              const t = box.current?.querySelector<HTMLTextAreaElement>(`textarea[data-added="${CSS.escape(s.k + ":" + r.added)}"]`);
                              if (t) { t.focus(); t.setSelectionRange(a.length, a.length); }
                            });
                          });
                        }} />
                    ) : (
                      <button type="button" className="arg" style={{ color: r.color || undefined }} onClick={() => onLook(r.arg)} title="Look for this in the library">{r.arg}</button>
                    )}
                  </td>
                  <td className="r">
                    {/* each response its own cell; the dashed one at the bottom starts another */}
                    {[...r.responses, ""].map((line, li, all) => {
                      const extra = li === all.length - 1;
                      if (extra && r.responses.length && !r.responses[r.responses.length - 1].trim()) return null;
                      const set = (next: string[]) => {
                        if (r.added >= 0) edit(s.k, (x) => ({ ...x, added: x.added.map((a, j) => (j === r.added ? { ...a, responses: next } : a)) }));
                        else edit(s.k, (x) => ({ ...x, rows: { ...x.rows, [r.arg]: next } }));
                      };
                      const key = s.k + ":" + ri + ":" + li;
                      return (
                        <textarea key={li} data-cell data-cid={"r" + SEP + s.k + SEP + ri + SEP + li} data-resp={key} value={line} rows={1} spellCheck={false} className={"resp" + (extra ? " more" : "") + sc("r" + SEP + s.k + SEP + ri + SEP + li)}
                          style={{ color: RESPONSE_COLOUR }} placeholder={extra ? (r.responses.length ? "+ another response" : r.added >= 0 ? "" : "Respond…") : ""}
                          onKeyDown={(e) => {
                            if (slashKey(e, key)) return;
                            const t = e.currentTarget;
                            // Enter: a new cell under this one (what was after the cursor goes with it)
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              if (extra && !line.trim()) return;
                              const cur = [...r.responses];
                              const head = t.value.slice(0, t.selectionStart), tail = t.value.slice(t.selectionEnd);
                              if (extra) cur.push(head, tail); else cur.splice(li, 1, head, tail);
                              set(cur);
                              requestAnimationFrame(() => {
                                const n = box.current?.querySelector<HTMLTextAreaElement>(`textarea[data-resp="${CSS.escape(s.k + ":" + ri + ":" + (li + 1))}"]`);
                                if (n) { n.focus(); n.setSelectionRange(0, 0); }
                              });
                              return;
                            }
                            // Backspace at the start of a cell: it joins the one above
                            if (e.key === "Backspace" && t.selectionStart === 0 && t.selectionEnd === 0 && li > 0 && !extra) {
                              e.preventDefault();
                              const cur = [...r.responses], prev = cur[li - 1], at = prev.length;
                              cur.splice(li - 1, 2, prev + line);
                              set(cur);
                              requestAnimationFrame(() => {
                                const n = box.current?.querySelector<HTMLTextAreaElement>(`textarea[data-resp="${CSS.escape(s.k + ":" + ri + ":" + (li - 1))}"]`);
                                if (n) { n.focus(); n.setSelectionRange(at, at); }
                              });
                              return;
                            }
                            keys(e);
                          }}
                          onChange={(e) => {
                            const v = e.target.value.replace(/\n/g, " ");
                            if (!extra) relink(linkKey(s.k, r.arg, line), linkKey(s.k, r.arg, v));
                            const cur = [...r.responses];
                            if (extra) { if (!v) return; cur.push(v); } else cur[li] = v;
                            set(cur);
                            // a response from the library: the card's tag goes in this cell (a block: its tags, one a cell)
                            const was = [...r.responses];
                            slashCheck(e.target, v, key, (p) => {
                              if (!p.tags.length) { toast("That block has no tags to flow"); return; }
                              const next = [...was];
                              next.splice(li, extra ? 0 : 1, ...p.tags);
                              set(next);
                              toSpeech(p);
                              cardsOf(p).forEach((c) => link(linkKey(s.k, r.arg, c.tag), [c]));
                              const last = li + p.tags.length - 1, end = p.tags[p.tags.length - 1].length;
                              requestAnimationFrame(() => {
                                const n = box.current?.querySelector<HTMLTextAreaElement>(`textarea[data-resp="${CSS.escape(s.k + ":" + ri + ":" + last)}"]`);
                                if (n) { n.focus(); n.setSelectionRange(end, end); }
                              });
                            });
                          }} />
                      );
                    })}
                  </td>
                </tr>
              ))}
              {/* the blank row: an argument of your own, the next number */}
              <tr className="new">
                <td className="n">{s.next}</td>
                <td className="a"><textarea data-cell data-cid={"n" + SEP + s.k} className={sc("n" + SEP + s.k)} value="" rows={1} spellCheck={false} placeholder="+ Add an argument" onKeyDown={keys}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\n/g, " ");
                    if (!v) return;
                    const j = (edits[s.k]?.added || []).length;
                    edit(s.k, (x) => ({ ...x, added: [...x.added, { arg: v, responses: [] }] }));
                    // the row it became takes the cursor, at the end of what was typed
                    requestAnimationFrame(() => {
                      const t = box.current?.querySelector<HTMLTextAreaElement>(`textarea[data-added="${CSS.escape(s.k + ":" + j)}"]`);
                      if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
                    });
                  }} /></td>
                <td className="r" />
              </tr>
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
