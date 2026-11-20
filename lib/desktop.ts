/**
 * Whether this page is running inside coda's desktop app (src-tauri/).
 *
 * The app's window runs a one-line script before every page that sets
 * window.__CODA_DESKTOP__, so the site can tell — it is the same site, loaded
 * from the same address. Inside it Google will not sign in (Google refuses
 * embedded browsers), so whatever needs Google is left out there, and the
 * "get the desktop app" links are not shown to someone already in it.
 */
export const DESKTOP_RELEASES = "https://github.com/elichen09/bracket/releases";

export function isDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window as unknown as { __CODA_DESKTOP__?: boolean }).__CODA_DESKTOP__ || /codaDesktop/.test(navigator.userAgent);
}
