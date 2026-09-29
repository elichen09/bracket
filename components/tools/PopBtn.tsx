"use client";

import Ico from "./Ico";
import type { PeekView } from "./Peek";

/**
 * Pop out: the one thing in this tool worth keeping an eye on — the doc, the
 * send doc, the grid — in a small window of its own (Peek.tsx), live and
 * read-only. The tool stays where it is.
 *
 * The window stays on top. An ordinary browser window falls behind as soon as
 * you click the other one, so where the browser has one (Chrome and Edge), the
 * pop-out is a floating always-on-top window — Document Picture-in-Picture,
 * the kind that keeps a video above everything — with the pop-out page loaded
 * inside it. A tab can float one such window at a time: with one already up, a
 * second pop-out opens as an ordinary window beside it (the other team's two
 * docs, one floating). Elsewhere it is an ordinary window throughout.
 *
 * From a side of the split screen, the floating window belongs to the split
 * page itself (window.top), so changing the tool on that side keeps it.
 */
const SIZE: Record<PeekView, [number, number]> = { doc: [780, 940], send: [780, 940], docflow: [780, 940], flow: [1180, 760] };
const WHAT: Record<PeekView, string> = { doc: "this doc", send: "the send doc", docflow: "this doc flow", flow: "the flow's grid" };
const TITLE: Record<PeekView, string> = { doc: "Doc", send: "Send doc", docflow: "Doc flow", flow: "Flow" };

interface DocPip { window: Window | null; requestWindow: (o: { width: number; height: number }) => Promise<Window> }

/** The page that owns floating windows here: the top one, if it is ours to reach. */
function pipHost(): DocPip | null {
  for (const w of [window.top, window]) {
    try { const d = (w as unknown as { documentPictureInPicture?: DocPip } | null)?.documentPictureInPicture; if (d) return d; } catch { /* another origin */ }
  }
  return null;
}

function float(pip: DocPip, url: string, view: PeekView, w: number, h: number) {
  pip.requestWindow({ width: w, height: h }).then((win) => {
    const d = win.document;
    d.title = TITLE[view] + " · pop-out";
    const st = d.createElement("style");
    st.textContent = "html,body{margin:0;height:100%;background:#1F2C24;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}";
    d.head.append(st);
    const f = d.createElement("iframe");
    f.src = location.origin + url;
    f.title = TITLE[view];
    f.allow = "clipboard-read; clipboard-write";
    d.body.append(f);
  }).catch(() => {
    // refused (no user gesture left, or not allowed here): the ordinary window after all
    window.open(url, `break-peek-${view}`, `popup=yes,width=${w},height=${h}`);
  });
}

export function popOut(view: PeekView, params: Record<string, string> = {}): boolean {
  const [w0, h0] = SIZE[view];
  const w = Math.min(w0, screen.availWidth - 40), h = Math.min(h0, screen.availHeight - 40);
  const q = new URLSearchParams({ v: view, ...params }).toString();
  const url = `/tools/peek?${q}`;
  // on top, if this browser can, and nothing is floating yet
  const pip = pipHost();
  if (pip && !pip.window) { float(pip, url, view, w, h); return true; }
  const left = Math.max(0, screen.availWidth - w - 24), top = Math.max(0, Math.round((screen.availHeight - h) / 2));
  const name = view === "doc" ? `break-peek-doc-${params.doc || Date.now()}` : `break-peek-${view}`;
  const win = window.open(url, name, `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
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
      title={`Pop out — ${WHAT[view]} in a small window that stays on top, live, to keep an eye on`}>
      <Ico n="pop" /><span className="lbl">Pop out</span>
    </button>
  );
}
