/**
 * Moving between the split screen and a tool on its own.
 *
 * Flow and Doc flow ask "Which flow?" when they open — right for a new
 * session, wrong when you are only going into or out of the split screen with
 * the flow you are already on. The hop is noted for the tab (sessionStorage is
 * shared with the split's same-origin frames), and a flow opening within a few
 * seconds of it keeps going without asking.
 */
const KEY = "tools.hop";
const FRESH = 20000;

export function markHop(): void {
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* private browsing */ }
}

export function justHopped(): boolean {
  try { return Date.now() - Number(sessionStorage.getItem(KEY) || 0) < FRESH; } catch { return false; }
}
