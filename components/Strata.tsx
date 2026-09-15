"use client";

import { useEffect, useRef } from "react";

/**
 * Flat, hard-edged bands of colour sharing one bent diagonal edge — like a
 * contour map or stacked strata. Fills its parent element. The bend drifts very
 * slowly (a full breath takes about half a minute) so the panel is alive without
 * ever being busy. Static under prefers-reduced-motion.
 */
export const PALETTES = {
  shore:   ["#2C5F7E", "#3A7A9A", "#5C9BB5", "#8FC1D2", "#BFE0E8", "#F6E5D6", "#F3C9A6", "#EFA877", "#E98A55", "#DE6E3C", "#C9552A"],
  reef:    ["#7A1F35", "#A12C43", "#C74553", "#DD6970", "#EE9598", "#EFF7DA", "#B9EFC0", "#8FE0A8", "#5FCB92", "#3FA98A", "#2F7F8C", "#2E6684"],
  orchard: ["#0A2417", "#153A25", "#1F5233", "#2C6B44", "#3D8459", "#F6A7B6", "#F0879D", "#E8628A", "#DD4A78", "#C7386A", "#B02C5C"],
  dusk:    ["#0B0E1F", "#1C1F3A", "#2E3153", "#45476B", "#5E5F85", "#F6E0CD", "#F4C8A4", "#EFAE7E", "#E9925A", "#DF7642", "#C95B2E"],
} as const;

export type PaletteName = keyof typeof PALETTES;

// The shared edge: gentle slope, a steep drop past the middle, gentle again.
// x as a fraction of width, y as a fraction of height added to a straight diagonal.
const ANCHORS: [number, number][] = [[0, 0], [0.34, 0.05], [0.58, 0.30], [1, 0.40]];

export default function Strata({ palette = "dusk", className = "", still = false }: { palette?: PaletteName; className?: string; still?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const colors = PALETTES[palette] as readonly string[];
    const reduce = still || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0, H = 0, raf = 0;
    const t0 = performance.now() - Math.random() * 60_000;

    const resize = () => {
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      W = Math.max(1, Math.floor(host.clientWidth * dpr));
      H = Math.max(1, Math.floor(host.clientHeight * dpr));
      canvas.width = W; canvas.height = H;
      draw();
    };

    const edge = (time: number): [number, number][] => {
      // slow breathing: each anchor rises and falls on its own ~30–45s cycle
      const s = time / 1000;
      return ANCHORS.map(([x, y], i) => {
        const wobble = reduce ? 0 : Math.sin(s / (28 + i * 6) * Math.PI * 2 + i * 1.7) * 0.025;
        return [x * W, (y + wobble) * H];
      });
    };

    const draw = () => {
      const time = performance.now() - t0;
      const pts = edge(time);
      const n = colors.length;
      const rise = pts[pts.length - 1][1] - pts[0][1];    // how far the edge falls across the width
      const step = (H + rise) / (n - 1);                   // band thickness
      const top0 = -rise - step * 0.15;                    // the first band starts above the frame
      ctx.fillStyle = colors[0];
      ctx.fillRect(0, 0, W, H);
      for (let i = 1; i < n; i++) {
        const off = top0 + i * step;
        ctx.fillStyle = colors[i];
        ctx.beginPath();
        ctx.moveTo(pts[0][0] - 2, pts[0][1] + off);
        for (const [x, y] of pts) ctx.lineTo(x, y + off);
        ctx.lineTo(W + 2, pts[pts.length - 1][1] + off);
        ctx.lineTo(W + 2, H + 2);
        ctx.lineTo(-2, H + 2);
        ctx.closePath();
        ctx.fill();
      }
      if (!reduce) raf = requestAnimationFrame(() => setTimeout(draw, 40)); // ~25fps is plenty for a drift
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [palette, still]);

  return <canvas ref={ref} className={"strata " + className} aria-hidden="true" />;
}
