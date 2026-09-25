"use client";

import { useEffect } from "react";

/**
 * A tool running inside the split view (/tools/split), in a frame.
 *
 * Two things change. The page says so — `html.embedded` — so a tool can drop
 * what makes no sense beside the other one, like its own "Split" button. And
 * a link out of the tool (the ← back, Past flows) goes to the whole window,
 * not into the frame: leaving a tool leaves the split, rather than nesting a
 * second page of the site inside half of it.
 */
export default function Embedded() {
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("embedded");
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      e.preventDefault();
      e.stopPropagation();
      (window.top || window).location.assign(url.href);
    };
    document.addEventListener("click", onClick, true);
    return () => { document.removeEventListener("click", onClick, true); html.classList.remove("embedded"); };
  }, []);
  return null;
}
