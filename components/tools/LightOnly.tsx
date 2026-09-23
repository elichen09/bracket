"use client";

import { useEffect } from "react";

/**
 * The tools run light, whatever the rest of the site is doing.
 *
 * The pools are read across a room on a projector and the dark ground suits
 * them. A tool is read at arm's length for an hour at a time, with a wall of
 * small type in it, and dark grey text on near-black is simply harder work
 * than black on paper. So this pins the page to the light palette and puts
 * the site's own setting back on the way out.
 *
 * The inline script runs as the page parses, before anything is painted,
 * because flipping the theme in an effect means a flash of the dark ground
 * first. The effect is what restores it, and covers the case where the script
 * never ran because the page was reached by a client-side navigation.
 */
const PIN = `(function(){var h=document.documentElement;
if(h.getAttribute('data-theme-prev')===null)h.setAttribute('data-theme-prev',h.getAttribute('data-theme')||'');
h.setAttribute('data-theme','light');})()`;

export default function LightOnly() {
  useEffect(() => {
    const h = document.documentElement;
    if (h.getAttribute("data-theme-prev") === null) h.setAttribute("data-theme-prev", h.getAttribute("data-theme") || "");
    h.setAttribute("data-theme", "light");
    return () => {
      const prev = h.getAttribute("data-theme-prev");
      if (prev) h.setAttribute("data-theme", prev); else h.removeAttribute("data-theme");
      h.removeAttribute("data-theme-prev");
    };
  }, []);
  return <script dangerouslySetInnerHTML={{ __html: PIN }} />;
}
