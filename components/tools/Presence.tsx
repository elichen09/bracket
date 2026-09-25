"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Lets something React would simply drop leave instead: a dialog, a popover,
 * a toast. While `show` is false it keeps drawing what it last drew, marked
 * `fx-leave` and inert, for as long as the leaving animation takes — then it
 * lets go.
 *
 * The wrapper is always there (display: contents, so layout never sees it),
 * which keeps React from remounting the content at the moment it starts to
 * leave. What is drawn while leaving is the last thing drawn while shown, so
 * content that reads state which has just gone to null does not have to
 * survive that.
 */
export default function Presence({ show, ms = 150, children }: { show: boolean; ms?: number; children: ReactNode }) {
  const last = useRef<ReactNode>(null);
  const [, redraw] = useState(0);
  if (show) last.current = children;

  useEffect(() => {
    if (show || !last.current) return;
    const quick = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => { last.current = null; redraw((n) => n + 1); }, quick ? 0 : ms);
    return () => clearTimeout(t);
  }, [show, ms]);

  const leaving = !show && !!last.current;
  // React 18 does not know inert, so it is set on the element itself
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.toggleAttribute("inert", leaving); }, [leaving]);
  return (
    <div ref={box} className={leaving ? "fx-leave" : undefined} style={{ display: "contents" }}>
      {show ? children : last.current}
    </div>
  );
}
