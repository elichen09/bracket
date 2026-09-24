"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  listRounds, patchRound, deleteRound, restoreRound, putRound, onArchive, summarizeGrid, gridHasWriting, type Round,
} from "@/lib/pastflows";
import { archiveAll, renameDoc, removeDoc, restoreDoc, listDocs } from "@/lib/docflow/store";
import { columns } from "@/lib/flow/format";
import { scoped } from "@/lib/owner";
import { polish } from "@/lib/evidence/polish";
import "./pastflows.css";

/**
 * Past flows — every round, in either tool, in one place.
 *
 * A list down the left, grouped by tournament (or by month, for rounds not
 * given one), and the round itself read back on the right without opening
 * it: a Doc flow as its page, a grid as its sheets. Search reads every word
 * flowed. Open hands the round back to the tool it came from.
 */

type Filter = "all" | "doc" | "grid";

const KIND = { doc: "Doc", grid: "Grid" } as const;
const month = (t: number) => new Date(t).toLocaleDateString([], { month: "long", year: "numeric" });
const day = (t: number) => new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const newId = (k: string) => k + Math.random().toString(36).slice(2, 10);

/* numbering as Docs does it: 1. a. i. */
const alpha = (n: number) => { let s = ""; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };
const ROMAN: [number, string][] = [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
const roman = (n: number) => { let s = ""; for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; } return s; };
const labelFor = (n: number, d: number) => (d % 3 === 0 ? String(n) : d % 3 === 1 ? alpha(n) : roman(n)) + ".";

interface PM { type: string; attrs?: Record<string, any>; content?: PM[]; text?: string; marks?: { type: string; attrs?: Record<string, any> }[] }

/** A Doc flow's inline content, read-only. */
function Inline({ nodes }: { nodes?: PM[] }) {
  return (
    <>
      {(nodes || []).map((n, i) => {
        let el: React.ReactNode = n.text || "";
        for (const m of n.marks || []) {
          if (m.type === "strong") el = <b>{el}</b>;
          else if (m.type === "em") el = <i>{el}</i>;
          else if (m.type === "underline") el = <u>{el}</u>;
          else if (m.type === "strike") el = <s>{el}</s>;
          else if (m.type === "mark") el = <mark data-hl={m.attrs?.hl || "yellow"}>{el}</mark>;
          else if (m.type === "red") el = <span className="red">{el}</span>;
        }
        return <span key={i}>{el}</span>;
      })}
    </>
  );
}

/** A Doc flow, as its page. */
function DocPage({ data, q }: { data: any; q: string[] }) {
  const counters: number[] = [];
  return (
    <div className="pf-doc">
      {((data?.content || []) as PM[]).map((b, i) => {
        const text = (b.content || []).map((c) => c.text || "").join("");
        const hit = q.length > 0 && q.every((w) => text.toLowerCase().includes(w));
        if (b.type !== "item") counters.length = 0;
        if (b.type === "box") return <div key={i} className={"pf-box" + (b.attrs?.who === "them" ? " them" : "") + (hit ? " hit" : "")}><Inline nodes={b.content} /></div>;
        if (b.type === "head") return <div key={i} className={"pf-head" + (b.attrs?.who === "them" ? " them" : "") + (hit ? " hit" : "")}><Inline nodes={b.content} /></div>;
        if (b.type === "para") return text ? <p key={i} className={"pf-p" + (hit ? " hit" : "")}><Inline nodes={b.content} /></p> : null;
        const d = Number(b.attrs?.depth) || 0;
        counters.length = d + 1;
        for (let k = 0; k < d; k++) if (!counters[k]) counters[k] = 1;
        counters[d] = (counters[d] || 0) + 1;
        if (!text) return null;
        return (
          <div key={i} className={"pf-line" + (b.attrs?.who === "them" ? " them" : "") + (hit ? " hit" : "")} style={{ ["--d" as any]: d }} data-hl={b.attrs?.hl || undefined}>
            <span className="pf-n">{labelFor(counters[d], d)}</span>
            <span className="pf-t"><Inline nodes={b.content} /></span>
            {b.attrs?.stop != null && <span className="pf-stop" title={"Round vision — " + b.attrs.stop}>{b.attrs.stop}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** A grid round, sheet by sheet, only the rows with writing in them. */
function GridSheets({ data, q }: { data: any; q: string[] }) {
  const cols = columns(data?.first === "con" ? "con" : "pro");
  const sheets = (data?.sheets || []) as { id: string; name: string; side?: string; rows: { id: string; c: string[] }[] }[];
  return (
    <div className="pf-grid">
      {data?.meta && (data.meta.tourn || data.meta.round) && (
        <p className="pf-gmeta mono">{[data.meta.tourn, data.meta.round, data.meta.side ? `we were ${data.meta.side}` : ""].filter(Boolean).join(" · ")}</p>
      )}
      {sheets.map((sh) => {
        const rows = (sh.rows || []).filter((r) => (r.c || []).some((c) => c && c.trim()));
        const used = cols.map((_, i) => rows.some((r) => r.c?.[i]?.trim()));
        const last = used.lastIndexOf(true);
        const shown = cols.slice(0, Math.max(1, last + 1));
        return (
          <section key={sh.id} className="pf-sheet">
            <h4><span className={"pf-side " + (sh.side || "pro")}>{sh.side === "con" ? "Con" : "Pro"}</span>{sh.name}</h4>
            {rows.length ? (
              <div className="pf-tablew">
                <table>
                  <thead><tr>{shown.map((c) => <th key={c.key} className={c.side} title={c.long}>{c.key}</th>)}</tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        {shown.map((c, i) => {
                          const t = r.c?.[i] || "";
                          const hit = q.length > 0 && q.every((w) => t.toLowerCase().includes(w));
                          return <td key={i} className={c.side + (hit ? " hit" : "")}>{t}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="pf-emptysheet">Nothing written on this sheet.</p>}
          </section>
        );
      })}
      {data?.notes?.trim() && <section className="pf-sheet"><h4>Notes</h4><p className="pf-notes">{data.notes}</p></section>}
    </div>
  );
}

export default function PastFlows({ owner }: { owner?: string }) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listEl = useRef<HTMLDivElement>(null);
  const [rounds, setRounds] = useState<Round[] | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sel, setSel] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<{ text: string; undo?: () => void; n: number } | null>(null);
  const [liveGrid, setLiveGrid] = useState<string | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((text: string, undo?: () => void) => {
    setToastMsg({ text, undo, n: Date.now() });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), undo ? 4600 : 2400);
  }, []);

  const reload = useCallback(async () => { setRounds(await listRounds(owner)); }, [owner]);

  // Bring in what was flowed before Past flows existed, then read it all.
  useEffect(() => {
    let dead = false;
    (async () => {
      await archiveAll(owner);
      try {
        const raw = localStorage.getItem(scoped("flow.doc", owner));
        const S = raw ? JSON.parse(raw) : null;
        if (S && Array.isArray(S.sheets)) {
          if (!S.id) { S.id = newId("g"); S.created = Date.now(); localStorage.setItem(scoped("flow.doc", owner), JSON.stringify(S)); }
          setLiveGrid(S.id);
          if (gridHasWriting(S)) await putRound(owner, summarizeGrid(S, Date.now()));
        }
      } catch { /* nothing kept */ }
      // a moment for the Doc flow copies to land
      await new Promise((r) => setTimeout(r, 150));
      if (!dead) await reload();
    })();
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onArchive(owner, () => { if (t) clearTimeout(t); t = setTimeout(reload, 300); });
    return () => { dead = true; off(); if (t) clearTimeout(t); };
  }, [owner, reload]);

  useEffect(() => { const el = root.current; if (!el) return; return polish(el); }, []);

  const words = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const shown = useMemo(() => (rounds || []).filter((r) =>
    (filter === "all" || r.kind === filter) &&
    (!words.length || words.every((w) => (r.name + "\n" + (r.tourn || "") + "\n" + r.text).toLowerCase().includes(w)))), [rounds, filter, words]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const m = new Map<string, Round[]>();
    shown.forEach((r) => {
      const g = r.tourn?.trim() || month(r.created);
      if (!m.has(g)) { m.set(g, []); order.push(g); }
      m.get(g)!.push(r);
    });
    return order.map((g) => ({ g, items: m.get(g)!, tourn: !!m.get(g)![0].tourn?.trim() }));
  }, [shown]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const tourns = useMemo(() => Array.from(new Set((rounds || []).map((r) => r.tourn?.trim()).filter(Boolean))) as string[], [rounds]);
  const counts = useMemo(() => ({ all: (rounds || []).length, doc: (rounds || []).filter((r) => r.kind === "doc").length, grid: (rounds || []).filter((r) => r.kind === "grid").length }), [rounds]);

  // something is always chosen when there is something to choose
  useEffect(() => { if (flat.length && !flat.some((r) => r.id === sel)) setSel(flat[0].id); }, [flat, sel]);
  const cur = flat.find((r) => r.id === sel) || null;

  useEffect(() => {
    const el = listEl.current?.querySelector(".pf-row.on") as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  /* ------------------------------------------------------------ acting on a round */
  const openRound = useCallback((r: Round) => {
    router.push(`/tools/${r.kind === "doc" ? "docflow" : "flow"}?open=${encodeURIComponent(r.id)}`);
  }, [router]);

  const rename = useCallback(async (r: Round, name: string) => {
    const v = name.trim();
    if (!v || v === r.name) return;
    if (r.kind === "doc") {
      await patchRound(owner, r.id, { name: v });
      if (listDocs(owner).some((d) => d.id === r.id)) renameDoc(owner, r.id, v);
    } else await patchRound(owner, r.id, { name: v, named: true });
    await reload();
  }, [owner, reload]);

  const setTourn = useCallback(async (r: Round, t: string) => {
    const v = t.trim();
    if (v === (r.tourn || "")) return;
    await patchRound(owner, r.id, { tourn: v || undefined });
    await reload();
    if (v) toast(`Filed under ${v}`);
  }, [owner, reload, toast]);

  const remove = useCallback(async (r: Round) => {
    const i = flat.findIndex((x) => x.id === r.id);
    const kept = r.kind === "doc" ? removeDoc(owner, r.id) : null;
    const rec = await deleteRound(owner, r.id);
    await reload();
    const next = flat[i + 1] || flat[i - 1];
    if (next) setSel(next.id);
    toast(`Deleted “${r.name}”` + (r.kind === "grid" && r.id === liveGrid ? " — it is still open in Flow" : ""), async () => {
      if (rec) await restoreRound(owner, rec);
      if (kept) restoreDoc(owner, kept.meta, kept.json);
      await reload();
      setSel(r.id);
    });
  }, [flat, owner, reload, toast, liveGrid]);

  const duplicate = useCallback(async (r: Round) => {
    const now = Date.now();
    const id = r.kind === "doc" ? newId("d") : newId("g");
    const data = r.kind === "grid" ? { ...(r.data as object), id, created: now } : r.data;
    await restoreRound(owner, { ...r, id, name: "Copy of " + r.name, named: r.kind === "grid" ? true : r.named, created: now, updated: now, data });
    await reload();
    setSel(id);
    toast(`Copied — “Copy of ${r.name}”`);
  }, [owner, reload, toast]);

  const docx = useCallback(async (r: Round) => {
    const [{ Node }, { schema }, { flowDocx }] = await Promise.all([import("prosemirror-model"), import("@/lib/docflow/schema"), import("@/lib/docflow/docx")]);
    const { blob, filename } = await flowDocx(Node.fromJSON(schema, r.data), r.name);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
    toast("Saved " + filename);
  }, [toast]);

  /* ------------------------------------------------------------ keys */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
      if (e.key === "/" && !typing) { e.preventDefault(); search.current?.focus(); return; }
      if (e.key === "Escape" && t === search.current) { setQ(""); search.current?.blur(); return; }
      if (typing && t !== search.current) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!flat.length) return;
        e.preventDefault();
        const i = flat.findIndex((r) => r.id === sel);
        const n = Math.max(0, Math.min(flat.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        setSel(flat[n].id);
        return;
      }
      if (e.key === "Enter" && cur) { e.preventDefault(); openRound(cur); return; }
      if (e.key === "Delete" && cur && !typing) { e.preventDefault(); remove(cur); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, sel, cur, openRound, remove]);

  /** The line of a round that matches the search, marked. */
  const matchLine = (r: Round) => {
    if (!words.length) return null;
    const line = r.text.split("\n").find((l) => words.some((w) => l.toLowerCase().includes(w)));
    if (!line) return null;
    const w = words.find((x) => line.toLowerCase().includes(x))!;
    const at = line.toLowerCase().indexOf(w);
    const from = Math.max(0, at - 30);
    return <>{from > 0 ? "…" : ""}{line.slice(from, at)}<mark>{line.slice(at, at + w.length)}</mark>{line.slice(at + w.length, at + 90)}</>;
  };

  return (
    <div className="pfl" ref={root}>
      <header className="pf-top">
        <Link className="pf-back mono" href="/tools" title="Back to the tools">←</Link>
        <div className="pf-brand mono">Past flows</div>
        <div className="pf-search">
          <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search every word you have flowed" spellCheck={false} aria-label="Search past flows" />
          <kbd>/</kbd>
        </div>
        <div className="pf-seg mono" role="tablist" aria-label="Which flows">
          {(["all", "doc", "grid"] as Filter[]).map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : KIND[f]}<em>{counts[f]}</em>
            </button>
          ))}
        </div>
        <div className="pf-gap" />
        <Link className="pf-btn" href="/tools/docflow">+ Doc flow</Link>
        <Link className="pf-btn" href="/tools/flow">+ Grid flow</Link>
      </header>

      <div className="pf-body">
        <aside className="pf-list" ref={listEl} aria-label="Your rounds">
          {rounds === null ? (
            <div className="pf-loading">{[0, 1, 2, 3].map((i) => <i key={i} style={{ ["--i" as any]: i }} />)}</div>
          ) : !rounds.length ? (
            <div className="pf-none">
              <b>Nothing flowed yet.</b>
              <p>Every round you flow — in <Link href="/tools/docflow">Doc flow</Link> or on the <Link href="/tools/flow">grid</Link> — lands here on its own, and starting the next one never loses the last.</p>
            </div>
          ) : !shown.length ? (
            <div className="pf-none"><b>Nothing matches.</b><p>{words.length ? "No round has all of those words in it." : "No rounds of that kind yet."}</p></div>
          ) : groups.map(({ g, items, tourn }) => (
            <section key={g} className="pf-group">
              <h3 className="mono">{tourn ? <span className="pf-trophy" aria-hidden="true">◆</span> : null}{g}<em>{items.length}</em></h3>
              {items.map((r, i) => (
                <button key={r.id} type="button" className={"pf-row" + (r.id === sel ? " on" : "")} style={{ ["--i" as any]: Math.min(i, 12) }}
                  onClick={() => setSel(r.id)} onDoubleClick={() => openRound(r)}>
                  <span className={"pf-kind mono " + r.kind}>{KIND[r.kind]}</span>
                  <span className="pf-main">
                    <b>{r.name}</b>
                    <small>{day(r.created)} · {r.stats}{r.kind === "grid" && r.id === liveGrid ? " · in Flow now" : ""}</small>
                    {words.length ? <span className="pf-match">{matchLine(r)}</span> : (
                      r.glance[0] && <span className={"pf-first" + (r.glance.find((x) => x.k === "line")?.who === "them" ? " them" : "")}>{(r.glance.find((x) => x.k === "line") || r.glance[0]).t}</span>
                    )}
                  </span>
                </button>
              ))}
            </section>
          ))}
        </aside>

        <main className="pf-view">
          {cur ? (
            <div className="pf-card" key={cur.id}>
              <div className="pf-vhead">
                <div className="pf-vtop">
                  <span className={"pf-kind mono " + cur.kind}>{KIND[cur.kind]} flow</span>
                  <span className="pf-when mono">Flowed {day(cur.created)} · last touched {day(cur.updated)}, {time(cur.updated)}</span>
                </div>
                <input className="pf-name" defaultValue={cur.name} key={cur.id + cur.name} spellCheck={false} aria-label="Name"
                  onBlur={(e) => rename(cur, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { (e.target as HTMLInputElement).value = cur.name; (e.target as HTMLInputElement).blur(); } }} />
                <div className="pf-vrow">
                  <label className="pf-tourn">
                    <span className="mono">Tournament</span>
                    <input list="pf-tourns" defaultValue={cur.tourn || ""} key={cur.id + (cur.tourn || "")} placeholder="Which tournament — groups its rounds" spellCheck={false}
                      onBlur={(e) => setTourn(cur, e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                    <datalist id="pf-tourns">{tourns.map((t) => <option key={t} value={t} />)}</datalist>
                  </label>
                  <span className="pf-stats mono">{cur.stats}</span>
                </div>
                <div className="pf-acts">
                  <button type="button" className="pf-btn ink" onClick={() => openRound(cur)}
                    title={cur.kind === "grid" ? "Opens in Flow — the round there now is kept here first" : "Opens in Doc flow"}>
                    Open in {cur.kind === "doc" ? "Doc flow" : "Flow"} <kbd>Enter</kbd>
                  </button>
                  <button type="button" className="pf-btn" onClick={() => duplicate(cur)}>Duplicate</button>
                  {cur.kind === "doc" && <button type="button" className="pf-btn" onClick={() => docx(cur)}>.docx</button>}
                  <button type="button" className="pf-btn danger" onClick={() => remove(cur)}>Delete</button>
                </div>
              </div>
              <div className="pf-read">
                {cur.kind === "doc" ? <DocPage data={cur.data} q={words} /> : <GridSheets data={cur.data} q={words} />}
              </div>
            </div>
          ) : rounds && rounds.length ? <div className="pf-pick">Choose a round to read it back.</div> : null}
        </main>
      </div>

      {toastMsg && (
        <div className="pf-toast mono" key={toastMsg.n} style={{ ["--life" as any]: toastMsg.undo ? "4600ms" : "2400ms" }}>
          {toastMsg.text}
          {toastMsg.undo && <button type="button" onClick={() => { toastMsg.undo?.(); setToastMsg(null); }}>Undo</button>}
        </div>
      )}
    </div>
  );
}
