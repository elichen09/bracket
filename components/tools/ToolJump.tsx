"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { markHop } from "@/lib/toolsHop";
import Ico from "./Ico";
import "./jump.css";

/**
 * Jump: from any tool to any other, by typing.
 *
 * Ctrl+Shift+K anywhere in the tools — a tool on its own, either side of the
 * split screen, the floating search — opens one box. A few letters and Enter
 * and you are there; with nothing typed, Enter goes back to the tool you were
 * in before this one, so two tools trade places at two keys. Numbers pick a
 * row outright.
 *
 * Going from a flow to another tool keeps the flow you are on (the hop), and
 * the move is the app's own, not a page load, so it is quick.
 *
 * In the split screen the box opens over both halves, whichever side the keys
 * were pressed in, and a tool goes in place of that side — the other side
 * keeps going. The other side, the tool on its own, swapping sides and round
 * mode are a row or two further down.
 */

type Slug = "evidence" | "flow" | "docflow" | "viewer" | "flows" | "split" | "tutorial";
type SideKey = "evidence" | "flow" | "docflow" | "viewer";

const TOOLS: { slug: Slug; name: string; icon: string; sub: string; words: string }[] = [
  { slug: "evidence", name: "Evidence", icon: "cards", sub: "Search cards, send, cut the speech doc", words: "ev cards search send doc speech file cut" },
  { slug: "flow", name: "Flow", icon: "grid", sub: "The grid, on the clock", words: "grid sheet flowing clock timer prep" },
  { slug: "docflow", name: "Doc flow", icon: "doc", sub: "A flow the way a Google Doc gets flowed", words: "docflow google doc flow" },
  { slug: "viewer", name: "Doc viewer", icon: "list", sub: "Your partner's send doc, SpeechDrop, any .docx", words: "viewer read reader speechdrop docx pdf partner outline rehighlight" },
  { slug: "flows", name: "Past flows", icon: "history", sub: "Every round you have flowed", words: "past flows history archive rounds old" },
  { slug: "split", name: "Split screen", icon: "split", sub: "Two tools side by side", words: "split side by side two both" },
  { slug: "tutorial", name: "Tutorial", icon: "command", sub: "Every tool explained", words: "tutorial help guide learn how" },
];
const SIDE: SideKey[] = ["evidence", "flow", "docflow", "viewer"];
const nameOf = (s: string) => TOOLS.find((t) => t.slug === s)?.name || s;
const iconOf = (s: string) => TOOLS.find((t) => t.slug === s)?.icon || "command";
const isSide = (s: unknown): s is SideKey => typeof s === "string" && (SIDE as string[]).includes(s);

const TRAIL = "tools.jump.trail";
const readTrail = (): string[] => { try { const v = JSON.parse(localStorage.getItem(TRAIL) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

interface Row { id: string; label: string; sub: string; tag?: string; icon: string; words: string; run: () => void }

/** How well a row answers what was typed: higher is better, -1 not at all. */
function score(q: string, r: Row): number {
  if (!q) return 0;
  const label = r.label.toLowerCase(), hay = label + " " + r.sub.toLowerCase() + " " + r.words;
  let total = 0;
  for (const w of q.split(/\s+/).filter(Boolean)) {
    let s = -1;
    if (label.startsWith(w)) s = 100;
    else if (label.split(/[\s+]+/).some((x) => x.startsWith(w))) s = 85;
    else if (r.words.split(" ").some((x) => x.startsWith(w))) s = 70;
    else if (hay.includes(w)) s = 50;
    else {
      // the letters in order, closer together is better ("dv" for Doc viewer)
      let i = 0, gaps = 0, last = -1;
      for (const ch of w) {
        const at = label.indexOf(ch, i);
        if (at < 0) { gaps = -1; break; }
        if (last >= 0) gaps += at - last - 1;
        last = at; i = at + 1;
      }
      if (gaps >= 0) s = Math.max(5, 40 - gaps * 3);
    }
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

export default function ToolJump() {
  const path = usePathname() || "";
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const [from, setFrom] = useState<0 | 1 | null>(null);    // the split side the keys came from
  const [host, setHost] = useState<Element | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const before = useRef<HTMLElement | null>(null);           // what had the cursor, for Esc to give it back
  const framed = typeof window !== "undefined" && window.top !== window;
  const peek = path.startsWith("/tools/peek");
  const here = (path.match(/^\/tools\/([a-z]+)/)?.[1] || "") as Slug | "";

  // where you have been, newest first — so an empty Enter goes back
  useEffect(() => {
    if (framed || peek || !here) return;
    try { localStorage.setItem(TRAIL, JSON.stringify([here, ...readTrail().filter((s) => s !== here)].slice(0, 10))); } catch { /* private browsing */ }
  }, [here, framed, peek]);

  const show = useCallback((side: 0 | 1 | null) => {
    // drawn inside whatever is full screen (a tool, round mode), or it would not be seen
    const fs = document.fullscreenElement;
    setHost(fs && fs.tagName !== "IFRAME" ? fs : document.querySelector(".toolpage") || document.body);
    before.current = document.activeElement as HTMLElement | null;
    setFrom(side);
    setQ(""); setHl(0); setOpen(true);
    for (const t of TOOLS) router.prefetch("/tools/" + t.slug);
  }, [router]);

  // the keys, before any tool sees them; in a split frame, the box opens over the whole split
  useEffect(() => {
    if (peek) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.code !== "KeyK") return;
      e.preventDefault(); e.stopPropagation();
      if (framed && !document.fullscreenElement) { window.top?.postMessage({ kind: "tool-jump" }, location.origin); return; }
      if (open) setOpen(false); else show(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [peek, framed, open, show]);
  useEffect(() => {
    if (framed || peek) return;
    const on = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.kind !== "tool-jump") return;
      const f = [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-slot]")].find((x) => x.contentWindow === e.source);
      const slot = f ? Number(f.dataset.slot) : NaN;
      window.focus();
      if (open) setOpen(false); else show(slot === 0 || slot === 1 ? slot : null);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [framed, peek, open, show]);

  // somewhere to go back to when it closes: the frame the keys came from
  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (!refocus) return;
    if (from === null) { const el = before.current; if (el?.isConnected) el.focus({ preventScroll: true }); return; }
    const f = document.querySelector<HTMLIFrameElement>(`iframe[data-slot="${from}"]`);
    f?.focus(); f?.contentWindow?.focus();
  }, [from]);

  const rows = useMemo<Row[]>(() => {
    if (!open) return [];
    const top = framed ? window.top! : window;
    const go = (href: string) => {
      markHop();
      setOpen(false);
      if (framed) top.location.assign(href); else router.push(href);
    };
    const trail = readTrail();
    const byTrail = (a: Slug, b: Slug) => {
      const i = trail.indexOf(a), j = trail.indexOf(b);
      return (i < 0 ? 99 : i) - (j < 0 ? 99 : j);
    };
    const out: Row[] = [];

    // in the split screen: what is on each side, read off the page
    const sv = !framed ? document.querySelector<HTMLElement>(".splitv[data-tools]") : null;
    if (sv) {
      const sides = (sv.dataset.tools || "").split(",") as SideKey[];
      const leftSlot = Number(sv.dataset.left) as 0 | 1;
      const sideName = (slot: number) => (slot === leftSlot ? "left" : "right");
      const tell = (detail: object) => window.dispatchEvent(new CustomEvent("tools-split", { detail }));
      const focusSide = (slot: number) => {
        setOpen(false);
        const f = document.querySelector<HTMLIFrameElement>(`iframe[data-slot="${slot}"]`);
        f?.focus(); f?.contentWindow?.focus();
      };
      const order = [...SIDE].sort((a, b) => (sides.includes(a) ? 1 : 0) - (sides.includes(b) ? 1 : 0));
      const slots: (0 | 1)[] = from === null ? [leftSlot, (1 - leftSlot) as 0 | 1] : [from, (1 - from) as 0 | 1];
      for (const k of order) {
        const at = sides.indexOf(k);
        if (at >= 0) {
          out.push({ id: "focus-" + k, label: nameOf(k), sub: "Go to it", tag: sideName(at) + " side", icon: iconOf(k), words: TOOLS.find((t) => t.slug === k)!.words, run: () => focusSide(at) });
        } else {
          slots.forEach((slot, n) => out.push({
            id: `put-${k}-${slot}`, label: nameOf(k), sub: `In place of ${nameOf(sides[slot])}`, tag: sideName(slot) + " side",
            icon: iconOf(k), words: TOOLS.find((t) => t.slug === k)!.words + (n ? " other" : ""),
            run: () => { setOpen(false); tell({ put: k, slot }); },
          }));
        }
      }
      const round = !!document.fullscreenElement;
      out.push({ id: "round", label: round ? "Leave round mode" : "Round mode", sub: "Full screen, the chrome out of the way", icon: round ? "unfull" : "full", words: "round full screen fullscreen focus", run: () => { setOpen(false); tell({ round: true }); } });
      out.push({ id: "swap", label: "Swap sides", sub: `${nameOf(sides[leftSlot])} to the right`, icon: "split", words: "swap flip switch sides", run: () => { setOpen(false); tell({ swap: true }); } });
      for (const k of SIDE) out.push({ id: "alone-" + k, label: nameOf(k) + " on its own", sub: "Leave the split", icon: iconOf(k), words: "alone own single leave close exit whole", run: () => go("/tools/" + k) });
      for (const t of TOOLS) if (!isSide(t.slug) && t.slug !== "split") out.push({ id: t.slug, label: t.name, sub: t.sub, icon: t.icon, words: t.words, run: () => go("/tools/" + t.slug) });
    } else {
      const cur = framed ? "" : here;
      for (const t of TOOLS.filter((x) => x.slug !== cur).sort((a, b) => byTrail(a.slug, b.slug))) {
        out.push({ id: t.slug, label: t.name, sub: t.sub, icon: t.icon, words: t.words, run: () => go("/tools/" + t.slug) });
      }
      // two side by side: the one you are in with each of the others first
      const pairs: [SideKey, SideKey][] = [];
      if (isSide(cur)) for (const k of SIDE) { if (k !== cur) pairs.push([cur, k]); }
      for (let i = 0; i < SIDE.length; i++) for (let j = i + 1; j < SIDE.length; j++) {
        if (SIDE[i] !== cur && SIDE[j] !== cur) pairs.push([SIDE[i], SIDE[j]]);
      }
      for (const [a, b] of pairs) out.push({
        id: `pair-${a}-${b}`, label: `${nameOf(a)} + ${nameOf(b)}`, sub: "Side by side", icon: "split",
        words: "split side by side both", run: () => go(`/tools/split?a=${a}&b=${b}`),
      });
      if (here) out.push({ id: "all", label: "All tools", sub: "The tools page", icon: "command", words: "index home tools all", run: () => go("/tools") });
    }
    return out;
  }, [open, framed, here, from, router]);

  const shown = useMemo(() => {
    const w = q.trim().toLowerCase();
    if (!w) return rows;
    return rows.map((r, i) => ({ r, s: score(w, r), i })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.r);
  }, [rows, q]);

  useEffect(() => { setHl(0); }, [q]);
  // the cursor in the box as it is drawn, so the first letters typed straight after the keys land in it
  useLayoutEffect(() => { if (open) { window.focus(); input.current?.focus(); } }, [open, host]);
  useEffect(() => {
    const li = list.current?.children[hl] as HTMLElement | undefined;
    li?.scrollIntoView({ block: "nearest" });
  }, [hl]);

  if (!open || !host) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); setHl((h) => Math.min(shown.length - 1, h + 1)); return; }
    if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) { e.preventDefault(); setHl((h) => Math.max(0, h - 1)); return; }
    if (e.key === "Enter") { e.preventDefault(); shown[hl]?.run(); return; }
    // with nothing typed, a number picks its row
    if (!q && /^[1-9]$/.test(e.key) && shown[Number(e.key) - 1]) { e.preventDefault(); shown[Number(e.key) - 1].run(); }
  };

  return createPortal(
    <div className="tj-veil" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="tj" role="dialog" aria-label="Jump to a tool">
        <div className="tj-in">
          <span className="tj-glyph" aria-hidden="true">↗</span>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder={from !== null ? "Which tool on this side?" : "Jump to a tool…"} aria-label="Jump to a tool"
            role="combobox" aria-expanded="true" aria-controls="tj-list" aria-activedescendant={shown[hl] ? "tj-" + shown[hl].id : undefined}
            spellCheck={false} autoComplete="off" />
          <kbd>Esc</kbd>
        </div>
        <ul id="tj-list" ref={list} role="listbox">
          {shown.map((r, i) => (
            <li key={r.id} id={"tj-" + r.id} role="option" aria-selected={i === hl} className={i === hl ? "on" : ""}
              onPointerMove={() => { if (i !== hl) setHl(i); }} onClick={() => r.run()}>
              <span className="tj-ico"><Ico n={r.icon} /></span>
              <span className="tj-lb"><b>{r.label}</b><small>{r.sub}</small></span>
              {r.tag && <span className="tj-tag">{r.tag}</span>}
              {!q && i < 9 && <kbd className="tj-n">{i + 1}</kbd>}
            </li>
          ))}
          {!shown.length && <li className="tj-none">No tool called that</li>}
        </ul>
        <div className="tj-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> go</span><span><kbd>1</kbd>–<kbd>9</kbd> straight there</span>
          <span className="tj-k"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>K</kbd> from any tool</span>
        </div>
      </div>
    </div>,
    host,
  );
}
