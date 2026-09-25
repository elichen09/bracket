"use client";

import { useEffect, type RefObject } from "react";

/**
 * A toolbar that turns to icons only when its words no longer fit.
 *
 * "Fit" is measured, not guessed at a breakpoint: the bar is laid out once
 * with nothing allowed to shrink — every button at its natural width — and
 * if that is wider than the bar, it goes `compact` (see finish.css: labels
 * and key hints give way to icons). Checked again whenever the bar changes
 * size or its words change — a label the engine rewrites, a count going up.
 * Both measurements happen before the browser paints, so nothing flickers.
 */
export function useFitBar(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    let raf = 0;
    const fit = () => {
      bar.classList.add("fitm");
      bar.classList.remove("compact");
      const over = bar.scrollWidth > bar.clientWidth + 1;
      bar.classList.remove("fitm");
      bar.classList.toggle("compact", over);
    };
    const soon = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fit); };
    fit();
    const ro = new ResizeObserver(soon);
    ro.observe(bar);
    // words the engine writes into the bar (not the class this sets, or it would chase itself)
    const mo = new MutationObserver(soon);
    mo.observe(bar, { subtree: true, childList: true, characterData: true });
    // the fonts arriving changes every width
    document.fonts?.ready.then(soon).catch(() => {});
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect(); };
  }, [ref]);
}
