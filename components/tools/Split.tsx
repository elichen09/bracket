"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { markHop } from "@/lib/toolsHop";
import "./finish.css";

/**
 * Split screen: any two of the tools in one window.
 *
 * Each tool runs whole, in its own frame (`?embed=1` drops the site nav from
 * it): they keep their own keys, so typing in one never sets off the other's
 * shortcuts, and they still talk to each other the way two tabs do — a card
 * sent from Evidence turns up ready to flow on the other side.
 *
 * A strip above says what is on each side, and changes it. The line between
 * them drags (arrow keys nudge it, a double-click halves it), and the two
 * swap sides. Sides are swapped with CSS order, never by moving the frames,
 * because moving a frame reloads it — nobody wants their flow to blink out
 * mid-round to change sides. Choosing for one side the tool the other side
 * has swaps them, for the same reason. Each side's × closes it, and the
 * other tool carries on across the whole window.
 */

const TOOLS = {
  evidence: { title: "Evidence", src: "/tools/evidence?embed=1" },
  flow: { title: "Flow", src: "/tools/flow?embed=1" },
  viewer: { title: "Doc viewer", src: "/tools/viewer?embed=1" },
  docflow: { title: "Doc flow", src: "/tools/docflow?embed=1" },
} as const;
type ToolKey = keyof typeof TOOLS;
const KEYS = Object.keys(TOOLS) as ToolKey[];
const isTool = (k: unknown): k is ToolKey => typeof k === "string" && k in TOOLS;

const KEY = "tools.split";
const MIN = 360;          // narrower than this and no tool is usable

export default function Split({ first: want }: { first?: string }) {
  const box = useRef<HTMLDivElement>(null);
  // two frames, each showing one tool; `left` says which frame is on the left
  const [tools, setTools] = useState<[ToolKey, ToolKey]>(["evidence", "flow"]);
  const [left, setLeft] = useState<0 | 1>(0);
  const [ratio, setRatio] = useState(0.5);
  const [drag, setDrag] = useState(false);
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const frames = useRef<(HTMLIFrameElement | null)[]>([null, null]);

  const keep = (t: [ToolKey, ToolKey], l: 0 | 1, r: number) => {
    try { localStorage.setItem(KEY, JSON.stringify({ tools: t, left: l, ratio: r })); } catch { /* private browsing */ }
  };

  // how it was left — and, from a tool's own Split button, that tool on the left
  useEffect(() => {
    let t: [ToolKey, ToolKey] = ["evidence", "flow"], l: 0 | 1 = 0, r = 0.5;
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || "null");
      if (s && Array.isArray(s.tools) && isTool(s.tools[0]) && isTool(s.tools[1]) && s.tools[0] !== s.tools[1]) t = [s.tools[0], s.tools[1]];
      if (s && (s.left === 0 || s.left === 1)) l = s.left;
      else if (s && typeof s.swap === "boolean") l = s.swap ? 1 : 0;       // the split's first version
      if (s && typeof s.ratio === "number") r = s.ratio;
    } catch { /* first time */ }
    if (isTool(want)) {
      const at = t.indexOf(want);
      if (at >= 0) { if (at !== l) { l = at as 0 | 1; r = 1 - r; } }
      else t[l] = want;
    }
    setTools(t); setLeft(l); setRatio(r);
    keep(t, l, r);
  }, [want]);

  // A frame can finish loading before React is listening for it, and then
  // onLoad never comes: so look for yourself too, and never cover a tool for
  // more than a few seconds whatever happens.
  useEffect(() => {
    const look = () => frames.current.forEach((f, i) => {
      try {
        const d = f?.contentDocument;
        const id = i + ":" + (f?.getAttribute("data-tool") || "");
        if (d && d.readyState === "complete" && f?.contentWindow?.location.href !== "about:blank") setLoaded((m) => (m[id] ? m : { ...m, [id]: true }));
      } catch { /* its own onLoad will say */ }
    });
    look();
    const t = setInterval(look, 300);
    const done = setTimeout(() => {
      clearInterval(t);
      setLoaded((m) => ({ ...m, ["0:" + tools[0]]: true, ["1:" + tools[1]]: true }));
    }, 10000);
    return () => { clearInterval(t); clearTimeout(done); };
  }, [tools]);

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
      setRatio((r) => { keep(tools, left, r); return r; });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const nudge = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = (e.shiftKey ? 0.1 : 0.02) * (e.key === "ArrowLeft" ? -1 : 1);
    setRatio((r) => { const n = fit(r + step); keep(tools, left, n); return n; });
  };

  // each tool keeps its width as it changes sides
  const flip = () => { const l = (1 - left) as 0 | 1, r = 1 - ratio; setLeft(l); setRatio(r); keep(tools, l, r); };
  const reset = () => { setRatio(0.5); keep(tools, left, 0.5); };

  /** Put a tool on one side. The one the other side already shows swaps over instead of loading twice. */
  const choose = (side: "left" | "right", k: ToolKey) => {
    const slot = side === "left" ? left : ((1 - left) as 0 | 1);
    if (tools[slot] === k) return;
    if (tools[1 - slot] === k) { flip(); return; }
    const t: [ToolKey, ToolKey] = [...tools] as [ToolKey, ToolKey];
    t[slot] = k;
    setTools(t);
    keep(t, left, ratio);
  };

  /** Close one side: the other tool gets the window, on its own page. */
  const close = (slot: 0 | 1) => {
    const rest = tools[1 - slot];
    markHop();
    window.location.href = TOOLS[rest].src.replace(/\?embed=1$/, "");
  };

  // a tool popped out of one side (PopBtn.tsx) is in its own window now: that side closes
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== location.origin || !e.data || e.data.kind !== "tools:popped") return;
      const slot = tools.indexOf(e.data.tool);
      if (slot >= 0) close(slot as 0 | 1);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  });

  const widthOf = (slot: number) => `calc(${(slot === left ? ratio : 1 - ratio) * 100}% - 5px)`;
  const orderOf = (slot: number) => (slot === left ? 0 : 2);

  return (
    <div className={"splitv" + (drag ? " dragging" : "")}>
      {/* what is on each side, lined up over it */}
      <div className="sp-strip">
        {[0, 1].map((slot) => {
          const side = slot === left ? "left" : "right";
          return (
            <div key={slot} className="sp-pick" role="group" aria-label={`The ${side} side`} style={{ order: orderOf(slot), flexBasis: widthOf(slot) }}>
              {KEYS.map((k) => {
                const here = tools[slot] === k, there = tools[1 - slot] === k;
                return (
                  <button key={k} type="button" className={"sp-tool" + (here ? " on" : "") + (there ? " there" : "")}
                    aria-pressed={here} onClick={() => choose(side, k)}
                    title={here ? TOOLS[k].title + " is here" : there ? `${TOOLS[k].title} is on the other side — swap them` : `Put ${TOOLS[k].title} on the ${side}`}>
                    {TOOLS[k].title}{there && <i aria-hidden="true"> ⇄</i>}
                  </button>
                );
              })}
              <button type="button" className="sp-close" onClick={() => close(slot as 0 | 1)}
                title={`Close this side — ${TOOLS[tools[1 - slot]].title} full screen`} aria-label={`Close the ${side} side`}>×</button>
            </div>
          );
        })}
        <div className="sp-gap" style={{ order: 1 }} />
      </div>

      <div className="sp-row" ref={box}>
        {[0, 1].map((slot) => {
          const k = tools[slot];
          const id = slot + ":" + k;
          return (
            <div key={slot} className={"sp-pane" + (loaded[id] ? " ready" : "")} style={{ order: orderOf(slot), flexBasis: widthOf(slot) }}>
              {/* the clipboard, by permission: a frame has none unless it is given it, and
                  without it Evidence could not copy a card — nor, then, send it */}
              <iframe ref={(el) => { frames.current[slot] = el; }} data-tool={k} src={TOOLS[k].src} title={TOOLS[k].title}
                allow="clipboard-read; clipboard-write; fullscreen"
                onLoad={() => setLoaded((m) => ({ ...m, [id]: true }))} />
              <div className="sp-wait" aria-hidden="true"><span>{TOOLS[k].title}</span></div>
            </div>
          );
        })}
        <div className="sp-bar" style={{ order: 1 }} role="separator" aria-orientation="vertical" aria-label="Resize the two sides"
          aria-valuenow={Math.round(ratio * 100)} tabIndex={0}
          onPointerDown={grab} onKeyDown={nudge} onDoubleClick={reset}
          title="Drag to resize · double-click for half and half">
          <i className="sp-grip" />
          <button type="button" className="sp-swap" onClick={flip} title="Swap sides" aria-label="Swap sides">⇄</button>
        </div>
        {drag && <div className="sp-cover" />}
      </div>
    </div>
  );
}
