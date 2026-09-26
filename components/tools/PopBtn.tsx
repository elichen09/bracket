"use client";

import Ico from "./Ico";
import { markHop } from "@/lib/toolsHop";

/**
 * Pop out: the tool moves into a window of its own — onto another screen,
 * beside the round's doc, wherever. It moves rather than copies: two of the
 * same flow open at once would each save over the other. So the page it left
 * goes back to the tools, and a side of the split screen closes, leaving the
 * other tool the window.
 *
 * The new window opens on the same flow or doc (the hop, lib/toolsHop.ts,
 * travels with it: a window opened from this one starts with a copy of its
 * session storage), without the site's nav, and without a Pop out of its own.
 */
export type PopTool = "evidence" | "flow" | "viewer" | "docflow";

export function popOut(tool: PopTool): boolean {
  markHop();
  const w = Math.min(1280, screen.availWidth - 40), h = Math.min(900, screen.availHeight - 40);
  const left = Math.max(0, Math.round((screen.availWidth - w) / 2)), top = Math.max(0, Math.round((screen.availHeight - h) / 2));
  const win = window.open(`/tools/${tool}?embed=1&pop=1`, `break-pop-${tool}`, `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  if (!win) return false;
  if (window.top && window.top !== window) window.top.postMessage({ kind: "tools:popped", tool }, location.origin);
  else location.assign("/tools");
  return true;
}

export default function PopBtn({ tool, className, onBlocked }: { tool: PopTool; className: string; onBlocked?: () => void }) {
  return (
    <button type="button" className={className + " popbtn icoonly"} aria-label="Pop out"
      onClick={() => { if (!popOut(tool)) (onBlocked || (() => alert("The browser blocked the new window — allow pop-ups for this site, then try again.")))(); }}
      title="Pop out — this tool in a window of its own">
      <Ico n="pop" /><span className="lbl">Pop out</span>
    </button>
  );
}
