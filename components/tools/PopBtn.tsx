"use client";

import Ico from "./Ico";
import type { PeekView } from "./Peek";

/**
 * Pop out: the one thing in this tool worth keeping an eye on — the doc, the
 * send doc, the grid — in a small window of its own (Peek.tsx), live and
 * read-only. The tool stays where it is. A doc can be popped out more than
 * once (the other team's two docs side by side); the others reuse their one
 * window, brought back to the front.
 */
const SIZE: Record<PeekView, [number, number]> = { doc: [780, 940], send: [780, 940], docflow: [780, 940], flow: [1180, 760] };
const WHAT: Record<PeekView, string> = { doc: "this doc", send: "the send doc", docflow: "this doc flow", flow: "the flow's grid" };

export function popOut(view: PeekView, params: Record<string, string> = {}): boolean {
  const [w0, h0] = SIZE[view];
  const w = Math.min(w0, screen.availWidth - 40), h = Math.min(h0, screen.availHeight - 40);
  const left = Math.max(0, screen.availWidth - w - 24), top = Math.max(0, Math.round((screen.availHeight - h) / 2));
  const q = new URLSearchParams({ v: view, ...params }).toString();
  const name = view === "doc" ? `break-peek-doc-${params.doc || Date.now()}` : `break-peek-${view}`;
  const win = window.open(`/tools/peek?${q}`, name, `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  if (!win) return false;
  try { win.focus(); } catch { /* another window's business */ }
  return true;
}

export default function PopBtn({ view, className, params, onBlocked }: {
  view: PeekView; className: string; params?: () => Record<string, string>; onBlocked?: () => void;
}) {
  return (
    <button type="button" className={className + " popbtn icoonly"} aria-label="Pop out"
      onClick={() => { if (!popOut(view, params?.())) (onBlocked || (() => alert("The browser blocked the new window — allow pop-ups for this site, then try again.")))(); }}
      title={`Pop out — ${WHAT[view]} in a small window of its own, live, to keep an eye on`}>
      <Ico n="pop" /><span className="lbl">Pop out</span>
    </button>
  );
}
