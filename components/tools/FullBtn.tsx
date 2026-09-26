"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import Ico from "./Ico";

/**
 * Full screen, for any tool: the tool alone on the screen — its own page, or
 * one side of the split screen, whose frames are allowed to. The browser's own
 * full screen, so Esc leaves it as it leaves any other; the button says which
 * way it goes.
 */
export function useFullscreen(target: RefObject<HTMLElement>, onRefused?: () => void) {
  const [full, setFull] = useState(false);
  useEffect(() => {
    const on = () => setFull(!!target.current && document.fullscreenElement === target.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, [target]);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    const el = target.current;
    if (!el?.requestFullscreen) { onRefused?.(); return; }
    el.requestFullscreen().catch(() => onRefused?.());
  }, [target, onRefused]);
  return { full, toggle };
}

/** The button: an icon, its name in its tooltip (finish.css, .icoonly). */
export default function FullBtn({ full, toggle, className, keyHint }: {
  full: boolean; toggle: () => void; className: string; keyHint?: string;
}) {
  const how = keyHint ? ` (${keyHint}; Esc to leave)` : " (Esc to leave)";
  return (
    <button type="button" className={className + " fullbtn icoonly" + (full ? " on" : "")} onClick={toggle} aria-pressed={full}
      aria-label={full ? "Exit full screen" : "Full screen"}
      title={full ? "Leave full screen" + (keyHint ? ` (Esc or ${keyHint})` : " (Esc)") : "Full screen — just this tool" + how}>
      <Ico n={full ? "unfull" : "full"} /><span className="lbl">{full ? "Exit full screen" : "Full screen"}</span>
    </button>
  );
}
