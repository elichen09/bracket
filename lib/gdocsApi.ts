/**
 * Your partner's flow tab, read and written through the Google Docs API.
 *
 * Signing in is Google's own (Google Identity Services, the token model): a
 * pop-up asks once, and an access token comes back that lasts an hour and is
 * renewed without asking again while you are signed into Google. Nothing goes
 * through The Break's server — the page talks to docs.googleapis.com itself,
 * with your token. The client ID is The Break's registration with Google; it
 * is public by design (it says which app is asking, not who you are).
 *
 * Reading: the Doc with its tabs; the tab called "flow" (or the one in the
 * link); its paragraphs into parts and rows — a numbered paragraph (nesting 0)
 * an argument, the deeper ones under it its responses, a plain line ("C1")
 * a new part, as is a list of a different id.
 *
 * Writing a row: its old responses are deleted and the new ones inserted
 * after the argument as new paragraphs (which take the argument's list and
 * level), then made a lettered list one level in (a leading tab is how the
 * API is told the level), in red. An argument added at the end of a part is
 * inserted after the part's last argument the same way — so it is that list's
 * next number — and that argument's responses are put back after it. Every
 * write names the revision it was worked out against; if the Doc has moved on
 * since (your partner typing), Google refuses it and it is worked out again.
 */

const SCOPE = "https://www.googleapis.com/auth/documents";
export const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "464389816224-eo0sktpgpok4a6c7ndcpd9s7jqc8l1k8.apps.googleusercontent.com";

// ------------------------------------------------------------------ signing in
type TokenClient = { requestAccessToken: (o?: { prompt?: string }) => void };
let tokenClient: TokenClient | null = null;
let token: { value: string; until: number } | null = null;
let waiting: ((t: string | null, err?: string) => void)[] = [];
const KEY = "break.gdocs.token";
const WAS = "break.gdocs.connected";

function loadScript(): Promise<void> {
  if ((window as any).google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((ok, bad) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => ok();
    s.onerror = () => bad(new Error("Couldn't load Google sign-in"));
    document.head.appendChild(s);
  });
}

async function client(): Promise<TokenClient> {
  if (tokenClient) return tokenClient;
  await loadScript();
  tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: (r: { access_token?: string; expires_in?: number; error?: string; error_description?: string }) => {
      if (r.access_token) {
        token = { value: r.access_token, until: Date.now() + ((r.expires_in || 3600) - 120) * 1000 };
        try { sessionStorage.setItem(KEY, JSON.stringify(token)); localStorage.setItem(WAS, "1"); } catch { /* private */ }
      }
      const w = waiting; waiting = [];
      w.forEach((f) => f(r.access_token || null, r.error_description || r.error));
    },
    error_callback: (e: { type?: string; message?: string }) => {
      const w = waiting; waiting = [];
      w.forEach((f) => f(null, e?.type === "popup_closed" ? "Sign-in closed" : e?.type === "popup_failed_to_open" ? "The browser blocked Google's sign-in window — allow pop-ups for this site" : e?.message || e?.type || "Sign-in failed"));
    },
  });
  return tokenClient!;
}

export function hasToken(): boolean {
  if (token && token.until > Date.now()) return true;
  try {
    const t = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (t && t.until > Date.now()) { token = t; return true; }
  } catch { /* none */ }
  return false;
}
/** Signed in here before: try again without asking (a token from Google while you're signed into it, no pop-up). */
export const wasConnected = () => { try { return localStorage.getItem(WAS) === "1"; } catch { return false; } };
/** Load Google's sign-in ahead of the click, so its window opens straight from the click (pop-up blockers allow that). */
export const warmUp = () => { void client().catch(() => { /* tried again on the click */ }); };

/** Sign-in has run out (it lasts an hour) and needs a click to renew: Google's window can't open by itself. */
export class SignInExpired extends Error {}

/** A token: the one held — or, from a click (`ask`), a new one through Google's window. */
export async function getToken(ask: boolean): Promise<string> {
  if (hasToken()) return token!.value;
  if (!ask) throw new SignInExpired("Google sign-in ran out — click Connect Google");
  const c = await client();
  return new Promise((ok, bad) => {
    waiting.push((t, err) => (t ? ok(t) : bad(new Error(err || "Not signed in to Google"))));
    // signed in here before: no consent screen again, just the account
    c.requestAccessToken({ prompt: wasConnected() ? "" : "consent" });
  });
}

export function signOut() {
  try { if (token) (window as any).google?.accounts?.oauth2?.revoke?.(token.value, () => {}); } catch { /* gone anyway */ }
  token = null;
  try { sessionStorage.removeItem(KEY); localStorage.removeItem(WAS); } catch { /* private */ }
}

async function api(path: string, init: RequestInit = {}, retry = true): Promise<any> {
  const t = await getToken(false);
  const r = await fetch("https://docs.googleapis.com/v1/" + path, { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + t, "Content-Type": "application/json" } });
  if (r.status === 401 && retry) { token = null; try { sessionStorage.removeItem(KEY); } catch { /* */ } return api(path, init, false); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.error?.message || `Google said ${r.status}`;
    const e = new Error(r.status === 403 ? "Your Google account can't edit that Doc — ask your partner to share it with you as an editor" : r.status === 404 ? "There's no Google Doc at that link" : msg);
    (e as any).status = r.status; (e as any).raw = msg;
    throw e;
  }
  return j;
}

// ------------------------------------------------------------------ reading
export interface ApiRow {
  n: number; arg: string; color: string; responses: string[];
  /** the argument's paragraph, and the run of response paragraphs after it */
  start: number; end: number; respStart: number | null; respEnd: number | null;
}
export interface ApiSection { title: string; rows: ApiRow[] }
export interface ApiFlow { revision: string; tabId: string; tabTitle: string; bodyEnd: number; sections: ApiSection[] }

const clean = (s: string) => s.replace(/ /g, " ").replace(/[\u000b\n]/g, " ").replace(/\s+/g, " ").trim();
const hex = (c?: { red?: number; green?: number; blue?: number }) =>
  c ? "#" + [c.red || 0, c.green || 0, c.blue || 0].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("") : "";

function findTab(tabs: any[], want: (t: any) => boolean): any {
  for (const t of tabs || []) {
    if (want(t)) return t;
    const k = findTab(t.childTabs || [], want);
    if (k) return k;
  }
  return null;
}

export async function readFlow(docId: string, tabFromLink: string): Promise<ApiFlow> {
  const doc = await api(`documents/${docId}?includeTabsContent=true`);
  const tabs = doc.tabs || [];
  const tab = findTab(tabs, (t) => (t.tabProperties?.title || "").trim().toLowerCase() === "flow")
    || (tabFromLink ? findTab(tabs, (t) => t.tabProperties?.tabId === tabFromLink) : null)
    || tabs[0];
  if (!tab) throw new Error("That Doc has nothing in it");
  const content = tab.documentTab?.body?.content || [];
  const sections: ApiSection[] = [{ title: "", rows: [] }];
  const cur = () => sections[sections.length - 1];
  const counter = new Map<string, number>();
  let partList = "";
  let bodyEnd = 0;
  for (const el of content) {
    bodyEnd = Math.max(bodyEnd, el.endIndex || 0);
    const p = el.paragraph;
    if (!p) continue;
    const runs = (p.elements || []).filter((e: any) => e.textRun);
    const text = clean(runs.map((e: any) => e.textRun.content).join(""));
    if (p.bullet) {
      const level = p.bullet.nestingLevel || 0;
      if (!text) continue;
      if (level === 0) {
        const id = p.bullet.listId;
        if (partList && id !== partList && cur().rows.length) sections.push({ title: "", rows: [] });
        partList = id;
        const n = (counter.get(id) || 0) + 1;
        counter.set(id, n);
        const first = runs.find((e: any) => clean(e.textRun.content));
        cur().rows.push({ n, arg: text, color: hex(first?.textRun?.textStyle?.foregroundColor?.color?.rgbColor), responses: [], start: el.startIndex, end: el.endIndex, respStart: null, respEnd: null });
      } else {
        const rows = cur().rows, last = rows[rows.length - 1];
        if (!last) continue;
        last.responses.push(text);
        if (last.respStart === null) last.respStart = el.startIndex;
        last.respEnd = el.endIndex;
      }
    } else if (text) {
      if (cur().rows.length || cur().title) sections.push({ title: text, rows: [] });
      else cur().title = text;
      partList = "";
    }
  }
  return { revision: doc.revisionId, tabId: tab.tabProperties?.tabId || "", tabTitle: tab.tabProperties?.title || "", bodyEnd, sections: sections.filter((s) => s.rows.length || s.title) };
}

// ------------------------------------------------------------------ writing
export interface RowWrite { row: ApiRow; responses: string[]; add: { arg: string; responses: string[] }[] }

/** Responses are written in red. */
export const RESPONSE_COLOUR = "#ff0000";
const RED = { color: { rgbColor: { red: 1, green: 0, blue: 0 } } };
/**
 * The list a row's responses are made into. Not the argument's preset (1. a. i.): Google adds lines to the
 * list right above them when its preset matches — at the top level, as more arguments. This one's second
 * level is lettered just the same (A. a. i.), and the lines go in at that second level.
 */
const RESPONSE_PRESET = "NUMBERED_UPPERALPHA_ALPHA_ROMAN";

export function rowRequests(w: RowWrite, tabId: string, bodyEnd: number): any[] {
  const reqs: any[] = [];
  const { row } = w;
  const range = (a: number, b: number) => ({ startIndex: a, endIndex: b, tabId });
  let leftover = false;
  if (row.respStart !== null && row.respEnd !== null) {
    // the last newline of the tab can't be deleted: leave that paragraph, empty, and take its bullet off after
    if (row.respEnd >= bodyEnd) { reqs.push({ deleteContentRange: { range: range(row.respStart, row.respEnd - 1) } }); leftover = true; }
    else reqs.push({ deleteContentRange: { range: range(row.respStart, row.respEnd) } });
  }
  const P = row.end - 1;
  let text = "";
  const groups: { from: number; to: number }[] = [];
  const responses = (lines: string[]) => {
    const ls = lines.map((x) => x.trim()).filter(Boolean);
    if (!ls.length) return;
    const g = { from: text.length + 1, to: 0 };
    ls.forEach((l) => { text += "\n\t" + l; });
    g.to = text.length;
    groups.push(g);
  };
  responses(w.responses);
  for (const a of w.add) {
    if (!a.arg.trim()) continue;
    text += "\n" + a.arg.trim();
    responses(a.responses);
  }
  if (text) {
    reqs.push({ insertText: { location: { index: P, tabId }, text } });
    // From the last group back, so a tab taken out of one doesn't move the next. The new lines come in
    // as items of the argument's numbered list (they take the paragraph they were typed into after) —
    // and Google won't re-bullet a line that's already in a list, so: out of the list first, then a
    // lettered list one level in (the leading tab says the level, and is taken out), then the indent
    // a second level has, set outright so nothing left over from the first list pushes it about.
    for (const g of [...groups].reverse()) {
      const lines = (text.slice(g.from, g.to).match(/\t/g) || []).length;
      reqs.push({ updateTextStyle: { range: range(P + g.from, P + g.to), textStyle: { foregroundColor: RED }, fields: "foregroundColor" } });
      reqs.push({ deleteParagraphBullets: { range: range(P + g.from, P + g.to) } });
      reqs.push({ createParagraphBullets: { range: range(P + g.from, P + g.to), bulletPreset: RESPONSE_PRESET } });
      reqs.push({ updateParagraphStyle: {
        range: range(P + g.from, P + g.to - lines),
        paragraphStyle: { indentStart: { magnitude: 72, unit: "PT" }, indentFirstLine: { magnitude: 54, unit: "PT" } },
        fields: "indentStart,indentFirstLine",
      } });
    }
  }
  if (leftover) {
    // the emptied last paragraph: plain, not a bullet with nothing after it
    const removed = (row.respEnd! - 1) - row.respStart!;
    const tabs = groups.length ? groups.reduce((t, g) => t + (text.slice(g.from, g.to).match(/\t/g) || []).length, 0) : 0;
    const end = bodyEnd - removed + text.length - tabs;
    reqs.push({ deleteParagraphBullets: { range: range(end - 1, end) } });
  }
  return reqs;
}

/** Write rows, worked out against `flow` — refused by Google if the Doc has moved on since (see isStale). */
export async function writeRows(docId: string, flow: ApiFlow, writes: RowWrite[]): Promise<void> {
  // from the bottom of the tab up, so nothing written moves what is still to be written
  const ordered = [...writes].sort((a, b) => b.row.end - a.row.end);
  const requests = ordered.flatMap((w) => rowRequests(w, flow.tabId, flow.bodyEnd));
  if (!requests.length) return;
  await api(`documents/${docId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests, writeControl: { requiredRevisionId: flow.revision } }),
  });
}

export const isStale = (e: unknown) => {
  const raw = String((e as any)?.raw || (e as Error)?.message || "");
  return (e as any)?.status === 400 && /revision/i.test(raw);
};
