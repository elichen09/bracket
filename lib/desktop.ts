/**
 * Whether this page is running inside coda's desktop app (src-tauri/).
 *
 * The app carries coda inside it (desktop/ builds it), so it runs offline and
 * with no account: everything is kept on the computer. Its window sets
 * window.__CODA_DESKTOP__ before the page runs, and the page leaves out what
 * needs a server or an account — sharing a file by link, a partner's Google
 * Doc, pop-outs (marked web-only in RoundMagic) — and the "get the desktop
 * app" links. Rooms with a partner work in the app by code (lib/realtime.ts).
 */
/** Where the app's pages come from: tauri://localhost on a Mac, http://tauri.localhost on Windows. */
export const APP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

export const DESKTOP_RELEASES = "https://github.com/elichen09/bracket/releases";

export function isDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window as unknown as { __CODA_DESKTOP__?: boolean }).__CODA_DESKTOP__ || /codaDesktop/.test(navigator.userAgent);
}

/*
 * Online, the app reaches two of coda's server routes — SpeechDrop and the
 * caselist — at the live site (lib/appRequests.ts on the server). On the web
 * they are the page's own.
 */
export const CODA_WEB = "https://bracket-ashy.vercel.app";

/** Where /api/tools/… is: the page's own server on the web, the live site from the app. */
export function apiBase(): string {
  return isDesktop() ? CODA_WEB : "";
}

/** The app's openCaselist sign-in: the token openCaselist gave the user's own Tabroom account, kept on this computer. */
export interface CaselistLogin { token: string; until: number; user: string }
const CL_KEY = "coda.caselist.login";

export function caselistLogin(): CaselistLogin | null {
  if (typeof window === "undefined") return null;
  try {
    const v = JSON.parse(localStorage.getItem(CL_KEY) || "null") as CaselistLogin | null;
    return v && v.token && v.until > Date.now() + 60_000 ? v : null;
  } catch {
    return null;
  }
}

export function setCaselistLogin(v: CaselistLogin | null) {
  try { if (v) localStorage.setItem(CL_KEY, JSON.stringify(v)); else localStorage.removeItem(CL_KEY); } catch { /* private */ }
}

/** The headers the caselist routes want from the app: its openCaselist sign-in. Nothing on the web. */
export function caselistHeaders(): Record<string, string> {
  const l = isDesktop() ? caselistLogin() : null;
  return l ? { "x-caselist-token": l.token } : {};
}

/** The app's caselist request came back unsigned (expired, or signed out at openCaselist): ask again. */
export function caselistSignedOut() {
  setCaselistLogin(null);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("coda:caselist-login"));
}
