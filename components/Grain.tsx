"use client";

import { useEffect, useRef } from "react";

/**
 * The landing page's static: sparse light specks, thicker toward the middle,
 * redrawn fourteen times a second. Drawn at a fraction of the screen's pixels
 * so each speck is a soft grain, not a hard dot. Still when the reader asks
 * for less motion.
 */
export default function Grain({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let seed = ((Math.random() * 4294967295) >>> 0) || 1;
    let W = 0, H = 0, ctx: CanvasRenderingContext2D | null = null, img: ImageData | null = null, buf: Uint32Array | null = null;
    let raf = 0, last = 0;

    const draw = () => {
      if (!c.clientWidth) return;
      const k = 1.6, w = Math.round(c.clientWidth / k), h = Math.round(c.clientHeight / k);
      if (w !== W || h !== H || !ctx) {
        c.width = W = w; c.height = H = h;
        ctx = c.getContext("2d");
        if (!ctx) return;
        img = ctx.createImageData(W, H);
        buf = new Uint32Array(img.data.buffer);
      }
      const b = buf!;
      let s = seed;
      const cx = W / 2, cy = H * 0.46, rr = (Math.min(W, H) * 0.55) ** 2;
      for (let y = 0; y < H; y++) {
        const dy = (y - cy) ** 2;
        for (let x = 0; x < W; x++) {
          s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
          const r = (s >>> 0) / 4294967296;
          const p = 0.06 + 0.16 * Math.exp(-((x - cx) ** 2 + dy) / rr);
          b[y * W + x] = r < p ? ((((14 + (r / p) * 70) | 0) << 24) | 0xefeded) >>> 0 : 0;
        }
      }
      seed = (s >>> 0) || 1;
      ctx.putImageData(img!, 0, 0);
    };

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (still) {
      draw();
      const onResize = () => draw();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 1000 / 14) return;
      last = t;
      draw();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
