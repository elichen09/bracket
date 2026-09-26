"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Node as PMNode } from "prosemirror-model";
import { markHits, clearHits, type Head } from "@/lib/viewer/doc";
import { drawDoc } from "@/lib/viewer/draw";
import { listDocs, getDoc, type ViewDoc, type ViewMeta } from "@/lib/viewer/store";
import { openBus, type Bus } from "@/lib/toolsBus";
import { scoped } from "@/lib/owner";
import { sheetColumns } from "@/lib/flow/format";
import { schema } from "@/lib/docflow/schema";
import { toDocsHtml } from "@/lib/docflow/io";
import { listDocs as listFlowDocs, loadDoc as loadFlowDoc, type DocMeta } from "@/lib/docflow/store";
import ThemePicker from "./ThemePicker";
import Ico from "./Ico";
import { useFitBar } from "./fitBar";
import "./docviewer.css";
import "./flow.css";
import "./finish.css";

/**
 * A pop-out: one thing from one tool, in a small window of its own, to keep
 * an eye on while the tools themselves are busy — the other team's doc while
 * Evidence and Flow share the screen, the send doc while you flow, the flow
 * while you cut cards.
 *
 * It only looks. Nothing in it can be typed into, so it can never save over
 * the tool it came from; it follows that tool live instead.
 *
 *   doc      a document from the Doc viewer — following whatever the Doc
 *            viewer shows, or pinned to one of its recent docs
 *   send     Evidence's send doc, or the read doc, as it is being written
 *   flow     the flow's grid, a sheet at a time
 *   docflow  a Doc flow, as the doc it is
 *
 * The doc-like three share a pane with a search, Highlighted only, zoom and
 * a jump to any heading.
 */
export type PeekView = "doc" | "send" | "flow" | "docflow";

interface Src { key: string; kind: ViewDoc["kind"]; blob?: Blob; html?: string }

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function Peek({ owner, view, doc, id }: { owner?: string; view: PeekView; doc?: string; id?: string }) {
  if (view === "flow") return <FlowPeek owner={owner} />;
  if (view === "send") return <SendPeek owner={owner} />;
  if (view === "docflow") return <DocFlowPeek owner={owner} id={id} />;
  return <DocPeek owner={owner} first={doc} />;
}

/* ================================================================ the banner */

function Bar({ brand, title, live, children }: { brand: string; title?: string; live?: string | null; children?: React.ReactNode }) {
  const bar = useRef<HTMLElement>(null);
  useFitBar(bar);
  useEffect(() => { document.title = (title ? title + " · " : "") + brand + " · pop-out"; }, [brand, title]);
  return (
    <header className="dv-top pk-bar" ref={bar}>
      <div className="dv-brand mono">{brand}</div>
      {(title || live) && (
        <div className="dv-now">
          {title && <b title={title}>{title}</b>}
          {live && <span className={"dv-src mono" + (/^live/i.test(live) ? " live" : "")}>{/^live/i.test(live) ? <i /> : null}{live}</span>}
        </div>
      )}
      <div className="dv-gap" />
      {children}
      <ThemePicker />
    </header>
  );
}

/* ================================================================ a document pane, with its small tools */

function useDocPane(src: Src | null) {
  const pane = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [heads, setHeads] = useState<Head[]>([]);
  const [pdf, setPdf] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const qRef = useRef(q);
  qRef.current = q;
  const hits = useRef<HTMLElement[]>([]);
  const [hitAt, setHitAt] = useState(0);
  const [hitCount, setHitCount] = useState(0);
  const [hl, setHl] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const lastKey = useRef("");

  const showHit = useCallback((i: number) => {
    const list = hits.current;
    if (!list.length) return;
    const k = ((i % list.length) + list.length) % list.length;
    paper.current?.querySelectorAll("mark.dv-hit.cur").forEach((m) => m.classList.remove("cur"));
    paper.current?.querySelectorAll(`mark.dv-hit[data-k="${list[k].getAttribute("data-k")}"]`).forEach((m) => m.classList.add("cur"));
    const p = pane.current;
    if (p) {
      const r = list[k].getBoundingClientRect(), R = p.getBoundingClientRect();
      p.scrollTo({ top: p.scrollTop + r.top - R.top - R.height / 3, behavior: "smooth" });
    }
    setHitAt(k);
  }, []);
  const find = useCallback((query: string, jump: boolean) => {
    const el = paper.current;
    if (!el) return;
    hits.current = markHits(el, query);
    setHitCount(hits.current.length);
    setHitAt(0);
    if (hits.current.length && jump) showHit(0);
  }, [showHit]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!paper.current) return;
      if (q.trim().length < 2) { clearHits(paper.current); hits.current = []; setHitCount(0); return; }
      find(q, true);
    }, 160);
    return () => clearTimeout(t);
  }, [q, find]);

  // drawn again whenever it changes — in place, at the same spot, when it is the same document moving on
  useEffect(() => {
    const el = paper.current;
    if (!el) return;
    let dead = false;
    setPdf(null);
    if (!src) { el.innerHTML = ""; setHeads([]); lastKey.current = ""; return; }
    if (src.kind === "pdf" && src.blob) {
      const u = URL.createObjectURL(src.blob);
      el.innerHTML = ""; setHeads([]); setPdf(u); lastKey.current = src.key;
      return () => { URL.revokeObjectURL(u); };
    }
    const same = lastKey.current === src.key;
    const top = pane.current?.scrollTop || 0;
    // a new document dims while it is laid out; the same one moving on just changes
    if (!same) setBusy(true);
    drawDoc(el, src, () => dead).then((hs) => {
      if (!hs || dead) return;
      setBusy(false);
      setHeads(hs);
      lastKey.current = src.key;
      if (pane.current) pane.current.scrollTop = same ? top : 0;
      if (qRef.current.trim().length >= 2) find(qRef.current, false);
    }).catch((e) => { setBusy(false); el.innerHTML = `<p class="dv-err">This document would not open: ${String(e?.message || e).replace(/[<>&]/g, "")}</p>`; });
    return () => { dead = true; };
  }, [src, find]);

  const go = useCallback((hid: string) => {
    const el = document.getElementById(hid), p = pane.current;
    if (!el || !p) return;
    p.scrollTo({ top: el.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop - 16, behavior: "smooth" });
    el.classList.remove("dv-flash"); void el.offsetWidth; el.classList.add("dv-flash");
  }, []);

  // Ctrl+F finds, F3 goes on, + and − size it
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); search.current?.focus(); search.current?.select(); return; }
      if (e.key === "F3") { e.preventDefault(); showHit(hitAt + (e.shiftKey ? -1 : 1)); return; }
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT")) return;
      if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(1.8, +(z + 0.1).toFixed(2)));
      if (e.key === "-") setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(2)));
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [showHit, hitAt]);

  const minLevel = heads.length ? Math.min(...heads.map((h) => h.level)) : 1;
  const tools = src && src.kind !== "pdf" ? (
    <>
      {heads.length > 0 && (
        <select className="pk-jump" value="" onChange={(e) => { if (e.target.value) go(e.target.value); }} aria-label="Jump to a heading" title="Jump to a heading">
          <option value="">Jump to…</option>
          {heads.map((h) => <option key={h.id} value={h.id}>{"  ".repeat(Math.min(h.level - minLevel, 4)) + (h.text.length > 70 ? h.text.slice(0, 69) + "…" : h.text)}</option>)}
        </select>
      )}
      <div className={"dv-search" + (q.trim().length >= 2 ? " on" : "")}>
        <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" spellCheck={false} aria-label="Search this doc"
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); showHit(hitAt + (e.shiftKey ? -1 : 1)); }
            if (e.key === "Escape") { e.preventDefault(); setQ(""); search.current?.blur(); }
          }} />
        <span className="dv-count mono">{q.trim().length >= 2 ? (hitCount ? `${hitAt + 1}/${hitCount}` : "none") : ""}</span>
        <button type="button" onClick={() => showHit(hitAt - 1)} disabled={!hitCount} aria-label="Previous match">‹</button>
        <button type="button" onClick={() => showHit(hitAt + 1)} disabled={!hitCount} aria-label="Next match">›</button>
      </div>
      <button type="button" className={"dv-btn" + (hl ? " on" : "")} onClick={() => setHl((h) => !h)} aria-pressed={hl} title="Highlighted only — fade what is not read">
        <Ico n="highlight" /><span className="lbl">Highlighted only</span>
      </button>
      <div className="dv-zoom">
        <button type="button" className="dv-btn" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(2)))} aria-label="Smaller" title="Smaller (−)">A−</button>
        <button type="button" className="dv-btn" onClick={() => setZoom((z) => Math.min(1.8, +(z + 0.1).toFixed(2)))} aria-label="Larger" title="Larger (+)">A+</button>
      </div>
    </>
  ) : null;

  const body = (empty: React.ReactNode) => (
    <div className="dv-body pk-body">
      <main className="dv-pane" ref={pane}>
        {!src && <div className="pk-empty">{empty}</div>}
        {pdf && <iframe className="dv-pdf" src={pdf} title="PDF" />}
        <div className={"dv-paper" + (hl ? " hl-only" : "") + (busy ? " busy" : "") + (!src || pdf ? " gone" : "")} style={{ zoom } as React.CSSProperties}>
          <div className="dv-doc" ref={paper} />
        </div>
      </main>
    </div>
  );
  return { tools, body };
}

/* ================================================================ doc: from the Doc viewer */

function DocPeek({ owner, first }: { owner?: string; first?: string }) {
  const [follow, setFollow] = useState(true);
  const followRef = useRef(follow);
  followRef.current = follow;
  const [cur, setCur] = useState<ViewDoc | null>(null);
  const [recents, setRecents] = useState<ViewMeta[]>([]);
  const [heard, setHeard] = useState(false);
  const bus = useRef<Bus | null>(null);

  /** A doc out of the viewer's store — waiting a moment for the newest copy of a live one to be written. */
  const load = useCallback(async (docId: string, at?: number) => {
    for (let i = 0; i < 8; i++) {
      const d = await getDoc(owner, docId);
      if (d && (!at || d.at >= at)) { setCur(d); return; }
      if (d && i === 7) { setCur(d); return; }
      await new Promise((r) => setTimeout(r, 350));
    }
  }, [owner]);

  useEffect(() => { listDocs(owner).then(setRecents); }, [owner, cur]);
  useEffect(() => {
    const b = openBus(owner, (m) => {
      if (m.kind !== "viewer-doc") return;
      setHeard(true);
      if (followRef.current) load(m.id, m.at);
    });
    bus.current = b;
    if (first) load(first);
    b.post({ kind: "viewer-ask" });
    return () => { b.close(); bus.current = null; };
  }, [owner, first, load]);

  const src = useMemo<Src | null>(() => (cur ? { key: cur.id, kind: cur.kind, blob: cur.blob, html: cur.html } : null), [cur]);
  const { tools, body } = useDocPane(src);

  const pick = (v: string) => {
    if (v === "__follow") { setFollow(true); bus.current?.post({ kind: "viewer-ask" }); return; }
    setFollow(false);
    load(v);
  };
  const live = follow ? (heard ? "Live · following the Doc viewer" : "Following the Doc viewer") : cur ? "Pinned · " + clock(cur.at) : null;
  return (
    <div className="dvw pk">
      <Bar brand="Doc" title={cur?.name} live={live}>
        <select className="pk-pick" value={follow ? "__follow" : cur?.id || ""} onChange={(e) => pick(e.target.value)} aria-label="Which doc" title="Which doc">
          <option value="__follow">↻ Follow the Doc viewer</option>
          {recents.map((m) => <option key={m.id} value={m.id}>{m.name.length > 48 ? m.name.slice(0, 47) + "…" : m.name}</option>)}
        </select>
        {tools}
      </Bar>
      {body(<><h2>No doc yet</h2><p>Open a doc in the <b>Doc viewer</b> and it shows up here — or pick one of your recent docs above.</p></>)}
    </div>
  );
}

/* ================================================================ send: Evidence's send or read doc */

function SendPeek({ owner }: { owner?: string }) {
  const [want, setWant] = useState<"send" | "read">("send");
  const [doc, setDoc] = useState<{ html: string; at: number; want: string } | null>(null);
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    setQuiet(false);
    const b = openBus(owner, (m) => { if (m.kind === "evidence-doc" && m.want === want) { setDoc({ html: m.html, at: m.at, want: m.want }); setQuiet(false); } });
    // saying it is here, now and every little while, keeps Evidence sending
    const ask = () => b.post({ kind: "evidence-ask", want });
    ask();
    const every = setInterval(ask, 30000);
    const nobody = setTimeout(() => setQuiet(true), 3500);
    return () => { clearInterval(every); clearTimeout(nobody); b.close(); };
  }, [owner, want]);
  const src = useMemo<Src | null>(() => (doc && doc.want === want ? { key: "evidence-" + want, kind: "html", html: doc.html } : null), [doc, want]);
  const { tools, body } = useDocPane(src);
  return (
    <div className="dvw pk">
      <Bar brand={want === "send" ? "Send doc" : "Read doc"} live={doc && doc.want === want ? "Live · " + clock(doc.at) : quiet ? "Waiting for Evidence" : "Connecting"}>
        <div className="dv-zoom pk-sw" role="group" aria-label="Which doc">
          <button type="button" className={"dv-btn" + (want === "send" ? " on" : "")} aria-pressed={want === "send"} onClick={() => setWant("send")}>Send</button>
          <button type="button" className={"dv-btn" + (want === "read" ? " on" : "")} aria-pressed={want === "read"} onClick={() => setWant("read")}>Read</button>
        </div>
        {tools}
      </Bar>
      {body(quiet
        ? <><h2>Evidence is not open</h2><p>Open <b>Evidence</b> in this browser — its {want} doc shows up here and keeps up as it changes.</p></>
        : <p className="pk-wait mono">Finding Evidence…</p>)}
    </div>
  );
}

/* ================================================================ docflow: a Doc flow, as the doc it is */

function DocFlowPeek({ owner, id: first }: { owner?: string; id?: string }) {
  const [list, setList] = useState<DocMeta[]>([]);
  const [id, setId] = useState(first || "");
  const [html, setHtml] = useState<{ html: string; at: number } | null>(null);
  const read = useCallback((docId: string, again = false) => {
    const json = loadFlowDoc(owner, docId);
    // Doc flow can take a doc out of storage for a moment (filing it in Past
    // flows) — so a missing doc is looked for again before it is let go of
    if (!json) { if (!again) setTimeout(() => read(docId, true), 700); else setHtml(null); return; }
    try { setHtml({ html: toDocsHtml(PMNode.fromJSON(schema, json)), at: Date.now() }); } catch { /* a doc mid-change: the next save */ }
  }, [owner]);
  useEffect(() => {
    const l = listFlowDocs(owner);
    setList(l);
    if (!first && l[0]) setId(l[0].id);
  }, [owner, first]);
  useEffect(() => {
    if (!id) return;
    read(id);
    const key = scoped("docflow.doc", owner) + ":" + id;
    const on = (e: StorageEvent) => { if (e.key === key) read(id); if (e.key === scoped("docflow.list", owner)) setList(listFlowDocs(owner)); };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, [id, owner, read]);
  const name = list.find((d) => d.id === id)?.name;
  const src = useMemo<Src | null>(() => (html ? { key: "docflow-" + id, kind: "html", html: html.html } : null), [html, id]);
  const { tools, body } = useDocPane(src);
  return (
    <div className="dvw pk">
      <Bar brand="Doc flow" title={name} live={html ? "Live · " + clock(html.at) : null}>
        {list.length > 1 && (
          <select className="pk-pick" value={id} onChange={(e) => setId(e.target.value)} aria-label="Which flow">
            {list.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
        {tools}
      </Bar>
      {body(<><h2>No doc flow yet</h2><p>Start one in <b>Doc flow</b> and it shows up here as you write it.</p></>)}
    </div>
  );
}

/* ================================================================ flow: the grid */

const TAGS = /\b(dropped|ext|turn|perm|nuq|xa|cx)\b/gi;
const escHtml = (s: string) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!));
/** A cell, the way Flow writes it: its marks as chips, a leading arrow drawn. */
const fmtCell = (t: string) => escHtml(t).replace(/^→/, '<span class="arr">→</span>').replace(TAGS, (m) => `<span class="tg ${m.toLowerCase()}">${m.toUpperCase()}</span>`);

interface FlowRow { id: string; c?: string[]; h?: string; t?: string }
interface FlowSheet { id: string; name: string; side: "pro" | "con"; rows: FlowRow[] }

function FlowPeek({ owner }: { owner?: string }) {
  const key = scoped("flow.doc", owner);
  const [doc, setDoc] = useState<{ sheets: FlowSheet[]; meta?: { round?: string; tourn?: string } } | null>(null);
  const [at, setAt] = useState(0);
  const [cur, setCur] = useState(0);
  const [written, setWritten] = useState(false);
  const [size, setSize] = useState(13);
  useEffect(() => {
    const read = () => { try { const d = JSON.parse(localStorage.getItem(key) || "null"); if (d && Array.isArray(d.sheets)) { setDoc(d); setAt(Date.now()); } } catch { /* a half-written save: the next one */ } };
    read();
    // Flow saves as it goes; every save lands here
    const on = (e: StorageEvent) => { if (e.key === key) read(); };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, [key]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "+" || e.key === "=") setSize((s) => Math.min(22, s + 1));
      if (e.key === "-") setSize((s) => Math.max(10, s - 1));
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const sheet = doc?.sheets[Math.min(cur, (doc?.sheets.length || 1) - 1)];
  const cols = sheet ? sheetColumns(sheet.side) : [];
  // with "written only", the columns nobody has spoken in yet step aside
  const show = cols.map((_, i) => !written || !!sheet?.rows.some((r) => r.c && (r.c[i] || "").trim()));
  const nShown = show.filter(Boolean).length || 1;
  const title = [doc?.meta?.tourn, doc?.meta?.round].filter(Boolean).join(" · ") || undefined;

  return (
    <div className="dvw pk pk-flowv">
      <Bar brand="Flow" title={title} live={doc ? "Live · " + clock(at) : null}>
        {doc && (
          <div className="dv-zoom pk-sheets" role="tablist" aria-label="Sheets">
            {doc.sheets.map((s, i) => (
              <button type="button" key={s.id} role="tab" aria-selected={i === cur} className={"dv-btn pk-sheet " + s.side + (i === cur ? " on" : "")} onClick={() => setCur(i)}>{s.name}</button>
            ))}
          </div>
        )}
        <button type="button" className={"dv-btn" + (written ? " on" : "")} aria-pressed={written} onClick={() => setWritten((w) => !w)} title="Only the columns with something in them">
          <Ico n="grid" /><span className="lbl">Written only</span>
        </button>
        <div className="dv-zoom">
          <button type="button" className="dv-btn" onClick={() => setSize((s) => Math.max(10, s - 1))} aria-label="Smaller" title="Smaller (−)">A−</button>
          <button type="button" className="dv-btn" onClick={() => setSize((s) => Math.min(22, s + 1))} aria-label="Larger" title="Larger (+)">A+</button>
        </div>
      </Bar>
      <div className="flw pk-flw" style={{ ["--flw-fs" as any]: size + "px", ["--flw-pad" as any]: "7px 10px" }}>
        {!sheet ? (
          <div className="pk-empty"><h2>No flow yet</h2><p>Flow a round in <b>Flow</b> and it shows up here as you write it.</p></div>
        ) : (
          <div className="pk-scroll">
            <div className="grid pk-grid" style={{ gridTemplateColumns: `repeat(${nShown}, minmax(${Math.round(size * 11)}px, 1fr))` }}>
              {cols.map((col, i) => show[i] && (
                <div key={i} className={"h " + col.side}><b>{col.key.split(" ").slice(1).join(" ")}</b><span className="sd">{col.key.split(" ")[0]}</span></div>
              ))}
              {sheet.rows.map((row, ri) => (row.h !== undefined && !row.c)
                ? <div key={row.id || ri} className="rh pk-rh" style={{ gridColumn: "1 / -1" }}><span className="hn">{row.h}</span>{row.t ? <em>{row.t}</em> : null}</div>
                : <div key={row.id || ri} className="r">
                    {(row.c || []).map((t, ci) => show[ci] && <div key={ci} className={"c " + (cols[ci]?.side || "pro")} dangerouslySetInnerHTML={{ __html: fmtCell(t) }} />)}
                  </div>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
