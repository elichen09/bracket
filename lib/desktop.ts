/**
 * Whether this page is running inside coda's desktop app (src-tauri/).
 *
 * The app carries coda inside it (desktop/ builds it), so it runs offline and
 * with no account: everything is kept on the computer. Its window sets
 * window.__CODA_DESKTOP__ before the page runs, and the page leaves out what
 * needs a server or an account — the caselist, SpeechDrop, rooms, sharing, a
 * partner's Google Doc, pop-outs (marked web-only in RoundMagic) — and the
 * "get the desktop app" links.
 */
export const DESKTOP_RELEASES = "https://github.com/elichen09/bracket/releases";

export function isDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window as unknown as { __CODA_DESKTOP__?: boolean }).__CODA_DESKTOP__ || /codaDesktop/.test(navigator.userAgent);
}
