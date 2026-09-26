/**
 * Staying in a room across a page change.
 *
 * Opening Split screen, reloading, following a link from one tool to another:
 * each is a new page, and a new page starts out of every room. But nobody who
 * was flowing with a partner a moment ago meant to leave. So while a tool is in
 * a room it keeps a note — the code, and when it was last there, refreshed
 * every few seconds and as the page goes — and a tool starting up within a few
 * minutes of that note goes straight back in. Leaving the room on purpose tears
 * the note up.
 */

const FRESH = 10 * 60_000;
const BEAT = 15_000;

type Note = { code: string; at: number };

function write(key: string, code: string) {
  try { localStorage.setItem(key, JSON.stringify({ code, at: Date.now() } satisfies Note)); } catch { /* private browsing */ }
}

/** Keep the note fresh while in the room; returns the way to stop (without forgetting). */
export function keepRoom(key: string, code: string): () => void {
  write(key, code);
  const t = setInterval(() => write(key, code), BEAT);
  const going = () => write(key, code);
  window.addEventListener("pagehide", going);
  return () => { clearInterval(t); window.removeEventListener("pagehide", going); };
}

/** The room to go back into, if there was one a moment ago. */
export function roomToResume(key: string): string | null {
  try {
    const n = JSON.parse(localStorage.getItem(key) || "null") as Note | null;
    return n && n.code && Date.now() - n.at < FRESH ? n.code : null;
  } catch { return null; }
}

/** Left on purpose: do not come back. */
export function forgetRoom(key: string) {
  try { localStorage.removeItem(key); } catch { /* private browsing */ }
}
