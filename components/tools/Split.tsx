"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "./finish.css";

/**
 * Evidence and Flow in one window.
 *
 * Each tool runs whole, in its own frame (`?embed=1` drops the site nav from
 * it): they keep their own keys, so typing in Evidence's search never sets off
 * a Flow shortcut, and they still talk to each other the way two tabs do —
 * a card sent from Evidence turns up ready to flow on the other side.
 *
 * The line between them drags (arrow keys nudge it, a double-click puts it
 * back in the middle), and the two can swap sides. Swapping reorders them with
 * CSS rather than in the DOM, because moving a frame reloads it — and nobody
 * wants their flow to blink out mid-round to change sides.
 */

const KEY = "tools.split";
const MIN = 360;          // narrower than this and neither tool is usable
const PANES = [
  { key: "evidence", title: "Evidence", src: "/tools/evidence?embed=1" },
  { key: "flow", title: "Flow", src: "/tools/flow?embed=1" },
];

export default function Split() {
  const box = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(0.5);
  const [swap, setSwap] = useState(false);
  const [drag, setDrag] = useState(false);
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const frames = useRef<Record<string, HTMLIFrameElement | null>>({});

  // A frame can finish loading before React is listening for it (the page
  // arrives with the frames in it, and they start at once), and then onLoad
  // never comes. So look for yourself as well — and never cover a tool for
  // longer than a few seconds whatever happens.
  useEffect(() => {
    const look = () => PANES.forEach((p) => {
      const f = frames.current[p.key];
      try {
        const d = f?.contentDocument;
        if (d && d.readyState === "complete" && f?.contentWindow?.location.href !== "about:blank") setLoaded((l) => (l[p.key] ? l : { ...l, [p.key]: true }));
      } catch { /* not ours to read: its own onLoad will say */ }
    });
    look();
    const t = setInterval(look, 300);
    const done = setTimeout(() => { clearInterval(t); setLoaded({ evidence: true, flow: true }); }, 8000);
    return () => { clearInterval(t); clearTimeout(done); };
  }, []);

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || "null");
      if (s && typeof s.ratio === "number") setRatio(s.ratio);
      if (s && typeof s.swap === "boolean") setSwap(s.swap);
    } catch { /* first time */ }
  }, []);
  const keep = (r: number, sw: boolean) => { try { localStorage.setItem(KEY, JSON.stringify({ ratio: r, swap: sw })); } catch { /* private browsing */ } };

  /** A ratio the window can honour: neither side under MIN pixels. */
  const fit = useCallback((r: number) => {
    const w = box.current?.getBoundingClientRect().width || 1200;
    const lo = Math.min(0.5, MIN / w);
    return Math.min(1 - lo, Math.max(lo, r));
  }, []);

  const grab = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDrag(true);
    const move = (ev: PointerEvent) => {
      const b = box.current?.getBoundingClientRect();
      if (b) setRatio(fit((ev.clientX - b.left) / b.width));
    };
    const up = () => {
      setDrag(false);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setRatio((r) => { keep(r, swap); return r; });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const nudge = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = (e.shiftKey ? 0.1 : 0.02) * (e.key === "ArrowLeft" ? -1 : 1);
    setRatio((r) => { const n = fit(r + step); keep(n, swap); return n; });
  };

  // each tool keeps its width as it changes sides
  const flip = () => { const s = !swap, r = 1 - ratio; setSwap(s); setRatio(r); keep(r, s); };
  const reset = () => { setRatio(0.5); keep(0.5, swap); };

  // the pane on the left is whichever comes first after a swap
  const first = swap ? 1 : 0;

  return (
    <div className={"splitv" + (drag ? " dragging" : "")} ref={box}>
      {PANES.map((p, i) => (
        <div key={p.key} className={"sp-pane" + (loaded[p.key] ? " ready" : "")}
          style={{ order: i === first ? 0 : 2, flexBasis: `calc(${(i === first ? ratio : 1 - ratio) * 100}% - 5px)` }}>
          <iframe ref={(el) => { frames.current[p.key] = el; }} src={p.src} title={p.title} onLoad={() => setLoaded((l) => ({ ...l, [p.key]: true }))} />
          <div className="sp-wait" aria-hidden="true"><span>{p.title}</span></div>
        </div>
      ))}
      <div className="sp-bar" style={{ order: 1 }} role="separator" aria-orientation="vertical" aria-label="Resize Evidence and Flow"
        aria-valuenow={Math.round(ratio * 100)} tabIndex={0}
        onPointerDown={grab} onKeyDown={nudge} onDoubleClick={reset}
        title="Drag to resize · double-click for half and half">
        <i className="sp-grip" />
        <button type="button" className="sp-swap" onClick={flip} title="Swap sides" aria-label="Swap sides">⇄</button>
      </div>
      {drag && <div className="sp-cover" />}
    </div>
  );
}
