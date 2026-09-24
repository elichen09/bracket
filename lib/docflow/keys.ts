import { scoped } from "../owner";

/**
 * Doc flow's keys, and the ones you have changed.
 *
 * Every shortcut is an action with a default key, and an account can move
 * any of them. The table is the one place a key is named: the sidebar hints,
 * the command panel and the key handler all read it, so a changed key is
 * changed everywhere at once. Keys are written as specs — 'mod+shift+D' —
 * from the physical key, so Caps Lock or a layout never changes what fires.
 *
 * Plain typing keys (Enter, Backspace, Ctrl+C/V/X/Z/Y and the formatting
 * keys Ctrl+B/I/U) are not in the table: they do what they do in any
 * document, and moving them would only break that.
 */

/** Where an action works: in the flow itself, or anywhere on the page. */
export type Scope = "doc" | "any";

export interface Action { id: string; group: string; label: string; key: string | null; scope: Scope }

export const ACTIONS: Action[] = [
  { id: "tab", group: "Flowing", label: "Answer this line (or indent)", key: "Tab", scope: "doc" },
  { id: "outdent", group: "Flowing", label: "Back out a level", key: "shift+Tab", scope: "doc" },
  { id: "next", group: "Flowing", label: "Their next point", key: "mod+Enter", scope: "doc" },
  { id: "answer", group: "Flowing", label: "Answer, straight under this line", key: "shift+Enter", scope: "doc" },
  { id: "who", group: "Flowing", label: "Swap who said it", key: "alt+T", scope: "doc" },
  { id: "up", group: "Flowing", label: "Move the line up", key: "alt+↑", scope: "doc" },
  { id: "down", group: "Flowing", label: "Move the line down", key: "alt+↓", scope: "doc" },
  { id: "hl-yellow", group: "Highlight", label: "Highlight yellow", key: "alt+Y", scope: "doc" },
  { id: "hl-green", group: "Highlight", label: "Highlight green", key: "alt+G", scope: "doc" },
  { id: "hl-cyan", group: "Highlight", label: "Highlight blue", key: "alt+B", scope: "doc" },
  { id: "hl-pink", group: "Highlight", label: "Highlight pink", key: "alt+P", scope: "doc" },
  { id: "box-neg", group: "Insert", label: "Box — NEG", key: null, scope: "doc" },
  { id: "box-aff", group: "Insert", label: "Box — AFF", key: null, scope: "doc" },
  { id: "box-weigh", group: "Insert", label: "Box — Weighing", key: null, scope: "doc" },
  { id: "head", group: "Insert", label: "Heading", key: null, scope: "doc" },
  { id: "keep", group: "Rhetoric", label: "Keep the selected lines as rhetoric", key: "alt+S", scope: "doc" },
  { id: "rhetoric", group: "Rhetoric", label: "Show or hide your rhetoric", key: "alt+R", scope: "any" },
  { id: "commands", group: "Page", label: "Command panel", key: "mod+K", scope: "any" },
  { id: "evidence", group: "Page", label: "Answer from your evidence", key: "mod+/", scope: "any" },
  { id: "share", group: "Page", label: "Flow with your partner", key: null, scope: "any" },
  { id: "keys", group: "Page", label: "Change the keys", key: null, scope: "any" },
  { id: "copy", group: "Page", label: "Copy for Google Docs", key: null, scope: "any" },
  { id: "docx", group: "Page", label: "Save as .docx", key: null, scope: "any" },
];
export const ACTION = new Map(ACTIONS.map((a) => [a.id, a]));

const KEYNAME: Record<string, string> = {
  Slash: "/", Period: ".", Comma: ",", Backslash: "\\", Quote: "'", BracketLeft: "[", BracketRight: "]",
  Semicolon: ";", Minus: "-", Equal: "=", Backquote: "`", Space: "Space",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
};

/** A key press as a spec — 'mod+shift+D' — whatever the layout or Caps Lock. */
export function comboOf(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "CapsLock", "AltGraph"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  let k: string;
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) k = e.code.slice(6);
  else if (KEYNAME[e.code]) k = KEYNAME[e.code];
  else k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(k);
  return parts.join("+");
}

/** A spec the way Windows writes it: 'Ctrl+Shift+D'. */
export const keyLabel = (spec: string | null) =>
  !spec ? "" : spec.split("+").map((p) => (p === "mod" ? "Ctrl" : p === "alt" ? "Alt" : p === "shift" ? "Shift" : p)).join("+");

/** Keys Chrome or Windows takes before a page ever sees them. */
export const RESERVED = new Map<string, string>([
  ["mod+T", "opens a new tab"], ["mod+W", "closes the tab"], ["mod+N", "opens a new window"],
  ["mod+shift+T", "reopens a closed tab"], ["mod+shift+W", "closes the window"], ["mod+shift+N", "opens an incognito window"],
  ["mod+Tab", "switches tabs"], ["mod+shift+Tab", "switches tabs"], ["mod+PageUp", "switches tabs"], ["mod+PageDown", "switches tabs"],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ["mod+" + n, "switches browser tabs"] as [string, string]),
  ["alt+←", "goes Back"], ["alt+→", "goes Forward"], ["alt+D", "jumps to the address bar"],
  ["alt+E", "opens the Chrome menu"], ["alt+F", "opens the Chrome menu"], ["alt+F4", "closes the window"],
  ["F5", "reloads the page"], ["mod+R", "reloads the page"], ["mod+shift+R", "reloads the page"], ["F11", "goes full screen"],
  ["F12", "opens DevTools"], ["mod+shift+I", "opens DevTools"], ["mod+shift+J", "opens DevTools"], ["mod+shift+C", "opens DevTools"],
  ["mod+L", "jumps to the address bar"], ["alt+Tab", "switches windows"],
]);

/** Keys a document already means something by. */
const NATIVE = new Set(["Enter", "Backspace", "Delete", "Escape", "shift+Backspace", "mod+Z", "mod+Y", "mod+shift+Z",
  "mod+C", "mod+V", "mod+X", "mod+A", "mod+B", "mod+I", "mod+U", "mod+Backspace", "mod+Delete",
  "↑", "↓", "←", "→", "shift+↑", "shift+↓", "shift+←", "shift+→", "mod+←", "mod+→", "mod+shift+←", "mod+shift+→",
  "Home", "End", "PageUp", "PageDown", "Space", "shift+Space"]);

/** Why a key cannot be used, or null if it can. */
export function refuse(spec: string): string | null {
  if (RESERVED.has(spec)) return `${keyLabel(spec)} ${RESERVED.get(spec)} — Chrome keeps it`;
  if (NATIVE.has(spec)) return `${keyLabel(spec)} already does something in a document`;
  const bare = spec.replace(/^shift\+/, "");
  if (!spec.includes("mod") && !spec.includes("alt") && bare.length === 1) return `${keyLabel(spec)} types a letter — add Ctrl or Alt`;
  return null;
}

/* ------------------------------------------------------------------ one account's keys */

const storeKey = (owner?: string | null) => scoped("docflow.keys", owner);

/** What this account has changed: action id → its key, or null for none. */
export type Overrides = Record<string, string | null>;

export function loadKeys(owner?: string | null): Overrides {
  try { const o = JSON.parse(localStorage.getItem(storeKey(owner)) || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; }
}
export function saveKeys(owner: string | null | undefined, o: Overrides) {
  try { localStorage.setItem(storeKey(owner), JSON.stringify(o)); } catch { /* private browsing */ }
}

/** The key an action has now. */
export const keyFor = (o: Overrides, id: string) => (id in o ? o[id] : ACTION.get(id)?.key ?? null);

/** Which action a key runs now. */
export function actionFor(o: Overrides, spec: string): string | null {
  for (const a of ACTIONS) if (keyFor(o, a.id) === spec) return a.id;
  return null;
}

/**
 * Give an action a key. Whatever had that key before loses it, and is named
 * so it can be said out loud.
 */
export function bind(o: Overrides, id: string, spec: string | null): { next: Overrides; moved: string | null } {
  const next = { ...o };
  let moved: string | null = null;
  if (spec) {
    const had = actionFor(o, spec);
    if (had && had !== id) { next[had] = null; moved = had; }
  }
  if (spec === (ACTION.get(id)?.key ?? null)) delete next[id]; else next[id] = spec;
  if (moved && next[moved] === (ACTION.get(moved)?.key ?? null)) delete next[moved];
  return { next, moved };
}
