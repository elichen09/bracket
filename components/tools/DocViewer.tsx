"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Presence from "./Presence";
import { sanitize, readDoc, readTime, markHits, clearHits, type Head } from "@/lib/viewer/doc";
import { listDocs, getDoc, keepDoc, dropDoc, newDocId, type ViewDoc, type ViewMeta, type DocKind } from "@/lib/viewer/store";
import { readRoom, type ViewerRoom, type RoomDoc } from "@/lib/viewer/room";
import { tidyCode } from "@/lib/flow/share";
import type { Peer, Status } from "@/lib/flow/share";
import { polish } from "@/lib/evidence/polish";
import "./docviewer.css";
import "./finish.css";
import ThemePicker from "./ThemePicker";

/**
 * Doc viewer — reading someone else's document properly.
 *
 * Your partner's send doc, live from the room you share; the other team's
 * speech doc off SpeechDrop; any .docx, web page or Google Doc you open or
 * paste. Whatever it is, it is laid out as the document it is, with an
 * outline down the side built from its headings (pocket, hat, block, tag),
 * how long each block's highlighting takes to read, and a search that marks
 * every place the words appear.
 */

interface SdFile { i: number; name: string; ctime: number }

const kindOf = (name: string, type = ""): DocKind => {
  const n = name.toLowerCase();
  if (n.endsWith(".docx") || type.includes("wordprocessingml")) return "docx";
  if (n.endsWith(".pdf") || type.includes("pdf")) return "pdf";
  if (n.endsWith(".html") || n.endsWith(".htm") || type.includes("html")) return "html";
  return "text";
};
const textToHtml = (t: string) => t.replace(/\r/g, "").split(/\n{2,}/).map((p) => "<p>" + p.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!)).replace(/\n/g, "<br>") + "</p>").join("");
const when = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const SOURCE = { room: "Partner", speechdrop: "SpeechDrop", file: "File", paste: "Pasted" } as const;

export default function DocViewer({ owner, me, room, sd }: { owner?: string; me?: string; room?: string; sd?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);

  const [doc, setDoc] = useState<ViewDoc | null>(null);
  const [heads, setHeads] = useState<Head[]>([]);
  const [cur, setCur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [tab, setTab] = useState<"outline" | "open">("open");
  const [recents, setRecents] = useState<ViewMeta[]>([]);
  const [q, setQ] = useState("");
  const [hitCount, setHitCount] = useState(0);
  const [hitAt, setHitAt] = useState(0);
  const hits = useRef<HTMLElement[]>([]);
  const [hlOnly, setHlOnly] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [tags, setTags] = useState(true);
  const [filter, setFilter] = useState("");
  const [toastMsg, setToastMsg] = useState<{ t: string; n: number } | null>(null);
  const [pasting, setPasting] = useState(false);
  const [dragging, setDragging] = useState(false);

  // a partner's send doc
  const [roomCode, setRoomCode] = useState(room ? tidyCode(room) : "");
  const live = useRef<ViewerRoom | null>(null);
  const [roomState, setRoomState] = useState<{ code: string; status: Status; peers: Peer[]; last: RoomDoc | null } | null>(null);
  const [waiting, setWaiting] = useState<RoomDoc | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;

  // SpeechDrop
  const [sdCode, setSdCode] = useState(sd || "");
  const [sdState, setSdState] = useState<{ code: string; files: SdFile[] | null; err: string; loading: boolean } | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((t: string) => {
    setToastMsg({ t, n: Date.now() });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2600);
  }, []);

  const refreshRecents = useCallback(async () => setRecents(await listDocs(owner)), [owner]);
  useEffect(() => { refreshRecents(); }, [refreshRecents]);
  useEffect(() => { const el = root.current; if (!el) return; return polish(el); }, []);

  /** Show a doc, and keep it among the recent ones. */
  const open = useCallback(async (d: ViewDoc, keep = true) => {
    setDoc(d);
    setTab("outline");
    if (keep) { await keepDoc(owner, d); refreshRecents(); }
  }, [owner, refreshRecents]);

  /* ------------------------------------------------------------ drawing the document */
  /**
   * Where an element sits in the scrolling pane, from the top of the document.
   * Not offsetTop: that counts from the nearest positioned box, and the .docx
   * renderer puts every section of a document in one — so offsetTop starts
   * again from nought at each section break, and the outline lost its place.
   */
  const topIn = (el: Element, p: HTMLElement) => el.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop;
  const anchor = useRef<{ id: string; text: string; off: number } | null>(null);
  useEffect(() => {
    const el = paper.current;
    if (!el) return;
    let dead = false;
    if (pdfUrl) { URL.revokeObjectURL(pdfUrl); setPdfUrl(null); }
    if (!doc) { el.innerHTML = ""; setHeads([]); return; }
    // the same doc, newer: keep your place by the heading at the top
    const keepPlace = anchor.current && anchor.current.id === doc.id ? anchor.current : null;
    (async () => {
      setBusy(true);
      try {
        el.innerHTML = "";
        if (doc.kind === "pdf" && doc.blob) {
          setPdfUrl(URL.createObjectURL(doc.blob));
          setHeads([]);
          return;
        }
        if (doc.kind === "docx" && doc.blob) {
          const { renderAsync } = await import("docx-preview");
          if (dead) return;
          await renderAsync(doc.blob, el, el, {
            inWrapper: false, ignoreWidth: true, ignoreHeight: true, breakPages: false, ignoreLastRenderedPageBreak: true,
            renderHeaders: false, renderFooters: false, renderFootnotes: true, renderEndnotes: true, className: "docx", useBase64URL: true,
          });
        } else {
          el.innerHTML = sanitize(doc.kind === "text" ? textToHtml(doc.html || "") : doc.html || "");
        }
        if (dead) return;
        const hs = readDoc(el);
        setHeads(hs);
        if (keepPlace && pane.current) {
          const again = hs.find((h) => h.text === keepPlace.text);
          const target = again && document.getElementById(again.id);
          if (target) pane.current.scrollTop = topIn(target, pane.current) - keepPlace.off;
        } else if (pane.current) pane.current.scrollTop = 0;
        if (q.trim().length >= 2) runSearch(q, false);
      } catch (e: any) {
        el.innerHTML = `<p class="dv-err">This document would not open: ${String(e?.message || e).replace(/[<>&]/g, "")}</p>`;
      } finally { if (!dead) setBusy(false); }
    })();
    return () => { dead = true; };
    // search and the anchor are read through refs at draw time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  /* ------------------------------------------------------------ where you are */
  useEffect(() => {
    const p = pane.current;
    if (!p) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // the last heading at or above a line just under the top of the pane;
        // headings are in document order, so halve the list rather than walk it
        const line = p.getBoundingClientRect().top + 90;
        const rows = heads.map((h) => document.getElementById(h.id));
        let lo = 0, hi = heads.length - 1, found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const el = rows[mid];
          if (el && el.getBoundingClientRect().top <= line) { found = mid; lo = mid + 1; } else hi = mid - 1;
        }
        const at: Head | null = found >= 0 ? heads[found] : null;
        setCur(at ? at.id : heads[0]?.id || null);
        const top = at && rows[found];
        anchor.current = docRef.current && top ? { id: docRef.current.id, text: at!.text, off: topIn(top, p) - p.scrollTop } : null;
      });
    };
    p.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => { p.removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, [heads]);

  const go = useCallback((id: string) => {
    const el = document.getElementById(id);
    const p = pane.current;
    if (!el || !p) return;
    p.scrollTo({ top: topIn(el, p) - 24, behavior: "smooth" });
    el.classList.remove("dv-flash"); void el.offsetWidth; el.classList.add("dv-flash");
  }, []);

  // keep the outline's current row in view
  useEffect(() => {
    const row = root.current?.querySelector(".dv-orow.on") as HTMLElement | null;
    row?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  /* ------------------------------------------------------------ search */
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
  const runSearch = useCallback((query: string, jump = true) => {
    const el = paper.current;
    if (!el) return;
    hits.current = markHits(el, query);
    setHitCount(hits.current.length);
    setHitAt(0);
    if (hits.current.length && jump) showHit(0);
    else if (hits.current.length) hits.current[0] && paper.current?.querySelectorAll(`mark.dv-hit[data-k="${hits.current[0].getAttribute("data-k")}"]`).forEach((m) => m.classList.add("cur"));
  }, [showHit]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!paper.current) return;
      if (q.trim().length < 2) { clearHits(paper.current); hits.current = []; setHitCount(0); return; }
      runSearch(q);
    }, 160);
    return () => clearTimeout(t);
  }, [q, runSearch]);

  /* ------------------------------------------------------------ keys */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && doc && doc.kind !== "pdf") {
        e.preventDefault(); search.current?.focus(); search.current?.select(); return;
      }
      if (e.key === "F3") { e.preventDefault(); showHit(hitAt + (e.shiftKey ? -1 : 1)); return; }
      if (typing) return;
      if ((e.key === "j" || e.key === "k") && heads.length) {
        const i = Math.max(0, heads.findIndex((h) => h.id === cur));
        const next = heads.slice(e.key === "j" ? i + 1 : 0, e.key === "j" ? undefined : i).filter((h) => h.level <= 3);
        const h = e.key === "j" ? next[0] : next[next.length - 1];
        if (h) go(h.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, heads, cur, hitAt, showHit, go]);

  /* ------------------------------------------------------------ opening things */
  const openFile = useCallback(async (f: File) => {
    const kind = kindOf(f.name, f.type);
    const base = { id: newDocId(), name: f.name.replace(/\.(docx|html?|txt|pdf|md)$/i, ""), kind, source: "file" as const, at: Date.now() };
    if (kind === "docx" || kind === "pdf") await open({ ...base, blob: f });
    else await open({ ...base, html: await f.text() });
    toast(`Opened ${f.name}`);
  }, [open, toast]);

  const onPaste = useCallback(async (e: React.ClipboardEvent) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (!html && !text.trim()) { toast("Nothing on the clipboard to read"); return; }
    const firstLine = (text || "").split("\n").map((l) => l.trim()).find(Boolean) || "Pasted doc";
    setPasting(false);
    await open({ id: newDocId(), name: firstLine.slice(0, 60), kind: html ? "html" : "text", source: "paste", at: Date.now(), html: html || text });
  }, [open, toast]);

  // SpeechDrop: the files in a room, and one of them
  const listSd = useCallback(async (raw: string) => {
    const code = raw.trim().replace(/^https?:\/\/[^/]+\//i, "").replace(/\/.*$/, "");
    if (!code) return;
    setSdState({ code, files: null, err: "", loading: true });
    try {
      const r = await fetch(`/api/tools/speechdrop?room=${encodeURIComponent(code)}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `SpeechDrop said ${r.status}`);
      setSdState({ code, files: (j.files as SdFile[]).slice().reverse(), err: "", loading: false });
    } catch (e: any) {
      setSdState({ code, files: null, err: String(e?.message || e), loading: false });
    }
  }, []);
  const openSd = useCallback(async (f: SdFile) => {
    if (!sdState) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/tools/speechdrop?room=${encodeURIComponent(sdState.code)}&i=${f.i}`, { cache: "no-store" });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `SpeechDrop said ${r.status}`); }
      const blob = await r.blob();
      const kind = kindOf(f.name, blob.type);
      const base = { id: `sd-${sdState.code}-${f.i}`, name: f.name.replace(/\.(docx|html?|txt|pdf)$/i, ""), kind, source: "speechdrop" as const, by: `SpeechDrop ${sdState.code}`, at: f.ctime || Date.now() };
      if (kind === "docx" || kind === "pdf") await open({ ...base, blob });
      else await open({ ...base, html: await blob.text() });
    } catch (e: any) {
      toast(String(e?.message || e));
    } finally { setBusy(false); }
  }, [sdState, open, toast]);
  useEffect(() => { if (sd) listSd(sd); }, [sd, listSd]);

  // a partner's send doc, live
  const joinRoom = useCallback((raw: string) => {
    const code = tidyCode(raw);
    if (code.length < 4) { toast("That is not a room code"); return; }
    live.current?.leave();
    setRoomState({ code, status: "joining", peers: [], last: null });
    live.current = readRoom(code, me || "Reader", {
      onDoc: (d) => {
        const id = `room-${code}`;
        const next: ViewDoc = { id, name: `${d.by}'s send doc`, kind: "html", source: "room", by: d.by, at: d.at, html: d.html };
        setRoomState((s) => (s && s.code === code ? { ...s, last: d } : s));
        keepDoc(owner, next).then(refreshRecents);
        const now = docRef.current;
        if (!now || now.id === id) { setDoc(next); setTab((t) => (now ? t : "outline")); setWaiting(null); }
        else setWaiting(d);
      },
      onPeers: (peers) => setRoomState((s) => (s && s.code === code ? { ...s, peers } : s)),
      onStatus: (status) => setRoomState((s) => (s && s.code === code ? { ...s, status } : s)),
    });
  }, [me, owner, refreshRecents, toast]);
  const leaveRoom = useCallback(() => { live.current?.leave(); live.current = null; setRoomState(null); setWaiting(null); }, []);
  useEffect(() => { if (room) joinRoom(room); return () => live.current?.leave(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openRecent = useCallback(async (m: ViewMeta) => {
    const d = await getDoc(owner, m.id);
    if (d) { setDoc(d); setTab("outline"); } else { toast("That doc is gone"); refreshRecents(); }
  }, [owner, refreshRecents, toast]);
  const forget = useCallback(async (m: ViewMeta) => {
    await dropDoc(owner, m.id);
    if (doc?.id === m.id) setDoc(null);
    refreshRecents();
  }, [owner, doc, refreshRecents]);

  /* ------------------------------------------------------------ drop a file anywhere */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) openFile(f);
  };

  /* ------------------------------------------------------------ outline */
  const minLevel = useMemo(() => (heads.length ? Math.min(...heads.map((h) => h.level)) : 1), [heads]);
  const shown = useMemo(() => {
    let list = heads.filter((h) => tags || h.level - minLevel < 3);
    const f = filter.trim().toLowerCase();
    if (f) {
      const keep = new Set<string>();
      heads.forEach((h, i) => {
        if (!h.text.toLowerCase().includes(f)) return;
        keep.add(h.id);
        // and the headings it sits under
        let lvl = h.level;
        for (let j = i - 1; j >= 0 && lvl > minLevel; j--) if (heads[j].level < lvl) { keep.add(heads[j].id); lvl = heads[j].level; }
      });
      list = heads.filter((h) => keep.has(h.id));
    }
    return list;
  }, [heads, tags, filter, minLevel]);
  const hlTotal = useMemo(() => heads.filter((h) => h.level === minLevel).reduce((n, h) => n + h.hlWords, 0), [heads, minLevel]);

  const roomLive = roomState && roomState.peers.some((p) => p.kind === "evidence");

  return (
    <div className={"dvw" + (dragging ? " dropping" : "")} ref={root}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}>
      <header className="dv-top">
        <Link className="dv-back mono" href="/tools" title="Back to the tools">←</Link>
        <div className="dv-brand mono">Doc viewer</div>
        {doc && (
          <div className="dv-now">
            <b title={doc.name}>{doc.name}</b>
            <span className={"dv-src mono" + (doc.source === "room" && roomLive ? " live" : "")}>
              {doc.source === "room" && roomLive ? <><i />Live · </> : null}{SOURCE[doc.source]}{doc.by && doc.source !== "room" ? " · " + doc.by : ""} · {doc.source === "room" ? "updated " + clock(doc.at) : when(doc.at)}
            </span>
          </div>
        )}
        <div className="dv-gap" />
        {doc && doc.kind !== "pdf" && (
          <div className={"dv-search" + (q.trim().length >= 2 ? " on" : "")}>
            <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this doc" spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); showHit(hitAt + (e.shiftKey ? -1 : 1)); }
                if (e.key === "Escape") { e.preventDefault(); setQ(""); search.current?.blur(); }
              }} aria-label="Search this doc" />
            <span className="dv-count mono">{q.trim().length >= 2 ? (hitCount ? `${hitAt + 1} / ${hitCount}` : "none") : "Ctrl+F"}</span>
            <button type="button" onClick={() => showHit(hitAt - 1)} disabled={!hitCount} aria-label="Previous match">‹</button>
            <button type="button" onClick={() => showHit(hitAt + 1)} disabled={!hitCount} aria-label="Next match">›</button>
          </div>
        )}
        {doc && doc.kind !== "pdf" && (
          <>
            <button type="button" className={"dv-btn" + (hlOnly ? " on" : "")} onClick={() => setHlOnly((h) => !h)} title="Fade everything that is not highlighted — what gets read">Highlighted only</button>
            <div className="dv-zoom">
              <button type="button" className="dv-btn" onClick={() => setZoom((z) => Math.max(0.7, +(z - 0.1).toFixed(2)))} aria-label="Smaller">A−</button>
              <button type="button" className="dv-btn" onClick={() => setZoom((z) => Math.min(1.8, +(z + 0.1).toFixed(2)))} aria-label="Larger">A+</button>
            </div>
          </>
        )}
        <ThemePicker />
      </header>

      {waiting && (
        <div className="dv-notice">
          <span><b>{waiting.by}</b> changed their send doc · {clock(waiting.at)}</span>
          <button type="button" onClick={() => { setWaiting(null); getDoc(owner, `room-${roomState?.code}`).then((d) => d && setDoc(d)); }}>Open it</button>
          <button type="button" onClick={() => setWaiting(null)}>Later</button>
        </div>
      )}

      <div className="dv-body">
        <aside className="dv-side">
          <div className="dv-tabs mono" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "outline"} className={tab === "outline" ? "on" : ""} onClick={() => setTab("outline")}>Outline{heads.length ? <em>{heads.length}</em> : null}</button>
            <button type="button" role="tab" aria-selected={tab === "open"} className={tab === "open" ? "on" : ""} onClick={() => setTab("open")}>Open</button>
          </div>

          {tab === "outline" ? (
            <div className="dv-outline">
              {heads.length ? (
                <>
                  <div className="dv-ohead">
                    <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a heading" spellCheck={false} />
                    <button type="button" className={"dv-mini mono" + (tags ? " on" : "")} onClick={() => setTags((t) => !t)} title="Show the tags under each block">Tags</button>
                  </div>
                  {hlTotal > 0 && <div className="dv-total mono">Highlighting reads in about {readTime(hlTotal)}</div>}
                  <div className="dv-olist">
                    {shown.map((h) => (
                      <button type="button" key={h.id} className={"dv-orow l" + Math.min(h.level - minLevel + 1, 4) + (h.id === cur ? " on" : "")}
                        style={{ ["--d" as any]: Math.min(h.level - minLevel, 4) }} onClick={() => go(h.id)} title={h.text}>
                        <span className="t">{h.text}</span>
                        {h.hlWords > 0 && <span className="rt mono" title={`${h.hlWords} highlighted words`}>{readTime(h.hlWords)}</span>}
                      </button>
                    ))}
                    {!shown.length && <p className="dv-none">No heading says that.</p>}
                  </div>
                </>
              ) : (
                <p className="dv-none">{doc ? (doc.kind === "pdf" ? "A PDF has no headings to list — use the reader's own search and outline." : "This document has no headings to list.") : "Open a document and its headings — pockets, hats, blocks and tags — show up here."}</p>
              )}
            </div>
          ) : (
            <div className="dv-open">
              <section className="dv-src-box">
                <h3 className="mono">Partner&apos;s send doc</h3>
                {roomState ? (
                  <div className="dv-roomst">
                    <p><i className={"dot" + (roomLive ? " live" : "")} />Room <b className="mono">{roomState.code}</b> · {roomLive ? `${roomState.peers.filter((p) => p.kind === "evidence").map((p) => p.name).join(", ")} is sharing` : roomState.status === "joining" ? "connecting…" : "waiting for their Evidence tab"}</p>
                    {roomState.last && <p className="dim">Last update {clock(roomState.last.at)}</p>}
                    <div className="row">
                      {roomState.last && <button type="button" className="dv-btn2 ink" onClick={() => getDoc(owner, `room-${roomState.code}`).then((d) => d && setDoc(d))}>Read it</button>}
                      <button type="button" className="dv-btn2" onClick={() => live.current?.ask()}>Ask again</button>
                      <button type="button" className="dv-btn2" onClick={leaveRoom}>Leave</button>
                    </div>
                  </div>
                ) : (
                  <form className="row" onSubmit={(e) => { e.preventDefault(); joinRoom(roomCode); }}>
                    <input className="mono" value={roomCode} onChange={(e) => setRoomCode(tidyCode(e.target.value))} placeholder="ROOM CODE" maxLength={8} aria-label="Room code" />
                    <button type="submit" className="dv-btn2 ink">Join</button>
                  </form>
                )}
                <p className="hint">The code your partner shares their send doc in, from Evidence&apos;s Room button — the same code as your flow room.</p>
              </section>

              <section className="dv-src-box">
                <h3 className="mono">SpeechDrop</h3>
                <form className="row" onSubmit={(e) => { e.preventDefault(); listSd(sdCode); }}>
                  <input className="mono" value={sdCode} onChange={(e) => setSdCode(e.target.value)} placeholder="ROOM CODE" aria-label="SpeechDrop room code" />
                  <button type="submit" className="dv-btn2 ink">Look</button>
                </form>
                {sdState?.loading && <p className="dim">Looking in {sdState.code}…</p>}
                {sdState?.err && <p className="err">{sdState.err}</p>}
                {sdState?.files && (
                  sdState.files.length ? (
                    <ul className="dv-files">
                      {sdState.files.map((f) => (
                        <li key={f.i}><button type="button" onClick={() => openSd(f)}>
                          <span className={"k mono " + kindOf(f.name)}>{kindOf(f.name) === "docx" ? "DOCX" : kindOf(f.name).toUpperCase()}</span>
                          <span className="n">{f.name}</span>
                          <small className="mono">{f.ctime ? clock(f.ctime) : ""}</small>
                        </button></li>
                      ))}
                    </ul>
                  ) : <p className="dim">Nothing in room {sdState.code} yet.</p>
                )}
                {sdState?.files && <button type="button" className="dv-link" onClick={() => listSd(sdState.code)}>Look again</button>}
              </section>

              <section className="dv-src-box">
                <h3 className="mono">From this computer</h3>
                <div className="row">
                  <button type="button" className="dv-btn2" onClick={() => fileIn.current?.click()}>Open a file…</button>
                  <button type="button" className="dv-btn2" onClick={() => setPasting(true)}>Paste a doc</button>
                </div>
                <input ref={fileIn} type="file" hidden accept=".docx,.html,.htm,.txt,.pdf,.md" onChange={(e) => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ""; }} />
                {pasting && (
                  <textarea className="dv-paste" autoFocus value="" onChange={() => {}} onPaste={onPaste} placeholder="Click here, then Ctrl+V — a Google Doc keeps its headings and highlighting"
                    onKeyDown={(e) => { if (e.key === "Escape") setPasting(false); }} onBlur={() => setPasting(false)} />
                )}
                <p className="hint">.docx, a web page, a PDF or text — or drop one anywhere on the page.</p>
              </section>

              {recents.length > 0 && (
                <section className="dv-src-box">
                  <h3 className="mono">Recent</h3>
                  <ul className="dv-recent">
                    {recents.map((m) => (
                      <li key={m.id} className={doc?.id === m.id ? "on" : ""}>
                        <button type="button" className="o" onClick={() => openRecent(m)}>
                          <span className="n">{m.name}</span>
                          <small className="mono">{SOURCE[m.source]} · {when(m.at)}</small>
                        </button>
                        <button type="button" className="x" onClick={() => forget(m)} aria-label={`Forget ${m.name}`} title="Forget it">×</button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </aside>

        <main className="dv-pane" ref={pane}>
          {!doc && (
            <div className="dv-empty">
              <h2>Read someone else&apos;s doc properly.</h2>
              <p>Your partner&apos;s send doc as they build it, the other team&apos;s speech doc off SpeechDrop, or any .docx or Google Doc — with an outline down the side and a search that marks every place the words appear.</p>
              <div className="dv-ways">
                <button type="button" onClick={() => setTab("open")}><b>Partner&apos;s send doc</b><span>Join the room code you flow in</span></button>
                <button type="button" onClick={() => { setTab("open"); }}><b>SpeechDrop</b><span>Look in a room, open any file</span></button>
                <button type="button" onClick={() => fileIn.current?.click()}><b>A file</b><span>.docx, PDF, a web page — or drop it here</span></button>
                <button type="button" onClick={() => { setTab("open"); setPasting(true); }}><b>Paste</b><span>Straight out of Google Docs</span></button>
              </div>
            </div>
          )}
          {pdfUrl && <iframe className="dv-pdf" src={pdfUrl} title={doc?.name || "PDF"} />}
          <div className={"dv-paper" + (hlOnly ? " hl-only" : "") + (busy ? " busy" : "") + (!doc || pdfUrl ? " gone" : "")}
            style={{ zoom } as React.CSSProperties}>
            <div className="dv-doc" ref={paper} />
          </div>
        </main>
      </div>

      {dragging && <div className="dv-drop mono">Drop it to read it</div>}
      <Presence show={!!toastMsg}>{toastMsg && <div className="dv-toast mono" key={toastMsg.n}>{toastMsg.t}</div>}</Presence>
    </div>
  );
}
