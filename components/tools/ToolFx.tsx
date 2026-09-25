"use client";

import { useEffect } from "react";

/**
 * The button that did it answers back.
 *
 * Every tool says what an action did in a toast at the bottom of the screen —
 * a long way from the button that was pressed. So when a toast turns up just
 * after a button was pressed, that button gives a short ring, and the eye
 * that is on the button learns it worked without having to go looking.
 *
 * One watcher for all the tools, so none of them has to be told: it notes
 * the last button pressed, and watches for any tool's toast appearing.
 */

/** How each tool shows a toast: an element that gains a class, or one that is added. */
const SHOWN = [
  { sel: ".flw .tst", on: "on" },        // Flow
  { sel: ".evi .toast", on: "on" },      // Evidence (bad: .bad)
];
const ADDED = ".dtoast, .pf-toast, .dv-toast";   // Doc flow, Past flows, Doc viewer

const WINDOW = 1500;

export default function ToolFx() {
  useEffect(() => {
    let last: { el: HTMLElement; t: number; home: string | null; text: string } | null = null;

    const note = (el: EventTarget | null) => {
      const b = el instanceof Element ? (el.closest("button, [role='button'], a[href]") as HTMLElement | null) : null;
      if (b && b.closest(".toolpage") && !b.closest(".tst, .toast, .dtoast, .pf-toast, .dv-toast")) {
        last = { el: b, t: performance.now(), home: b.parentElement?.closest("[id]")?.id || null, text: (b.textContent || "").trim() };
      }
    };
    const onDown = (e: PointerEvent) => note(e.target);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") note(e.target); };

    const ring = (bad: boolean) => {
      if (!last || performance.now() - last.t > WINDOW) return;
      let b: HTMLElement | null = last.el;
      // a strip that is drawn again after every change (Flow's tabs) has
      // replaced the button by now: the one standing in its place answers
      if (!b.isConnected && last.home) {
        const text = last.text;
        const home = document.getElementById(last.home);
        b = home ? (Array.from(home.querySelectorAll("button, [role='button'], a[href]")) as HTMLElement[]).find((x) => (x.textContent || "").trim() === text) || null : null;
      }
      last = null;
      // gone with the dialog it was in, or hidden: nothing to answer
      if (!b || !b.isConnected || !b.getClientRects().length) return;
      b.classList.remove("fx-ok", "fx-bad");
      void b.offsetWidth;
      b.classList.add(bad ? "fx-bad" : "fx-ok");
      setTimeout(() => b.classList.remove("fx-ok", "fx-bad"), 520);
    };

    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") {
          const t = r.target as HTMLElement;
          for (const s of SHOWN) {
            if (t.classList.contains(s.on) && t.matches(s.sel) && !(r.oldValue || "").split(/\s+/).includes(s.on)) { ring(t.classList.contains("bad")); return; }
          }
        } else {
          for (const n of Array.from(r.addedNodes)) {
            if (n instanceof HTMLElement && (n.matches(ADDED) || n.querySelector(ADDED))) { ring(false); return; }
          }
        }
      }
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      mo.disconnect();
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
  return null;
}
