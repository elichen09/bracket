import { scoped } from "../owner";
import { keyLabel, refuse as docRefuse } from "../docflow/keys";

export { comboOf, keyLabel } from "../docflow/keys";

/**
 * The card cutter's keys, and the ones you have changed.
 *
 * The defaults are the ones Eli cuts with: Ctrl+Alt cuts (underline, at
 * 11pt — the two keys alone, see watchChords), Ctrl+N shrinks, Alt+Z
 * highlights green; the rest sit next to them on Ctrl and Alt. No F-keys.
 * Every one can be moved (Keys, in the banner).
 */

export interface Action { id: string; group: string; label: string; key: string | null; hint: string }

export const ACTIONS: Action[] = [
  { id: "underline", group: "Cutting", label: "Cut", key: "mod+alt", hint: "Underline, at 11pt — Ctrl and Alt together, then let go. Twice, quickly: emphasis" },
  { id: "shrink", group: "Cutting", label: "Shrink", key: "mod+N", hint: "What is neither underlined nor bold goes to 8pt (again: back)" },
  { id: "highlight", group: "Cutting", label: "Highlight", key: "alt+Z", hint: "In the highlighter's colour — green to start with" },
  { id: "emphasis", group: "Cutting", label: "Emphasis", key: "mod+shift+Space", hint: "Bold, underlined, and boxed — or Cut twice, quickly" },
  { id: "cite", group: "Cutting", label: "Cite", key: "alt+C", hint: "Author and date, 13pt bold" },
  { id: "clear", group: "Cutting", label: "Clear", key: "mod+\\", hint: "Back to plain text" },
  { id: "condense", group: "Cutting", label: "Condense", key: "alt+Q", hint: "The card's paragraphs into one" },
  { id: "hl-next", group: "Cutting", label: "Next highlighter colour", key: "alt+shift+Z", hint: "Green, yellow, blue, pink, grey" },
  { id: "paste", group: "Cutting", label: "Paste as text", key: null, hint: "Without the source's formatting (Ctrl+Shift+V does it too)" },
  { id: "tag", group: "Headings", label: "Tag", key: "alt+4", hint: "A card's tag" },
  { id: "block", group: "Headings", label: "Block", key: "alt+3", hint: "A block — “AT: Econ”" },
  { id: "hat", group: "Headings", label: "Hat", key: "alt+2", hint: "A group of blocks" },
  { id: "pocket", group: "Headings", label: "Pocket", key: "alt+1", hint: "The biggest heading, in a box — a whole file's subject" },
  { id: "new-card", group: "Files", label: "New card", key: "alt+N", hint: "A tag, a cite and room for the card, after this one" },
  { id: "save", group: "Files", label: "Save", key: "mod+S", hint: "It also saves by itself as you go" },
  { id: "find", group: "Files", label: "Search every file", key: "mod+shift+F", hint: "Tags, cites, blocks and what is read" },
  { id: "new-file", group: "Files", label: "New file", key: "alt+shift+N", hint: "" },
];
export const ACTION = new Map(ACTIONS.map((a) => [a.id, a]));

/**
 * Why a key cannot be used, or null if it can: Doc flow's rule, with two
 * exceptions. F-keys are allowed (a page can keep them). And Ctrl+N, which
 * Chrome keeps for a new window — except while the cutter is full screen,
 * when it locks the key for itself (see `caveat`).
 */
const MINE = new Set(["mod+N", "F5", "F11", "F12"]);
export function refuse(spec: string): string | null {
  if (MINE.has(spec)) return null;
  return docRefuse(spec);
}

/** What to know about a key that works, but not everywhere. */
export function caveat(spec: string | null): string | null {
  if (spec === "mod+N") return "Chrome keeps Ctrl+N for a new window, so it works while the cutter is full screen";
  return null;
}

export type Overrides = Record<string, string | null>;
const storeKey = (owner?: string | null) => scoped("cutter.keys", owner);

export function loadKeys(owner?: string | null): Overrides {
  try { const o = JSON.parse(localStorage.getItem(storeKey(owner)) || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; }
}
export function saveKeys(owner: string | null | undefined, o: Overrides) {
  try { localStorage.setItem(storeKey(owner), JSON.stringify(o)); } catch { /* private browsing */ }
}

export const keyFor = (o: Overrides, id: string) => (id in o ? o[id] : ACTION.get(id)?.key ?? null);

export function actionFor(o: Overrides, spec: string): string | null {
  for (const a of ACTIONS) if (keyFor(o, a.id) === spec) return a.id;
  return null;
}

/** Give an action a key; whatever had it before loses it, and is named. */
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

export const label = (o: Overrides, id: string) => keyLabel(keyFor(o, id));

/**
 * Shortcuts made of modifiers alone — Ctrl+Alt, pressed and let go with
 * nothing else in between. A keydown can't say that (the press is only a
 * modifier), so it is the release that counts: two or more modifiers went
 * down, no other key and no click came while they were held, and the first
 * of them has come up. The spec is the same shape as any other: 'mod+alt'.
 */
export function watchChords(onChord: (spec: string, e: KeyboardEvent) => void): () => void {
  const held = new Set<string>(), peak = new Set<string>();
  let spoiled = false;
  const name = (k: string) => (k === "Control" || k === "Meta" ? "mod" : k === "Alt" || k === "AltGraph" ? "alt" : k === "Shift" ? "shift" : null);
  const down = (e: KeyboardEvent) => {
    const n = name(e.key);
    if (!n) { if (held.size) spoiled = true; return; }
    if (!held.size) { spoiled = false; peak.clear(); }
    held.add(n); peak.add(n);
  };
  const up = (e: KeyboardEvent) => {
    const n = name(e.key);
    if (!n || !held.has(n)) return;
    if (!spoiled && peak.size >= 2) {
      spoiled = true;
      onChord(["mod", "alt", "shift"].filter((m) => peak.has(m)).join("+"), e);
    }
    held.delete(n);
  };
  const spoil = () => { if (held.size) spoiled = true; };
  const reset = () => { held.clear(); peak.clear(); spoiled = false; };
  window.addEventListener("keydown", down, true);
  window.addEventListener("keyup", up, true);
  window.addEventListener("mousedown", spoil, true);
  window.addEventListener("blur", reset);
  return () => {
    window.removeEventListener("keydown", down, true);
    window.removeEventListener("keyup", up, true);
    window.removeEventListener("mousedown", spoil, true);
    window.removeEventListener("blur", reset);
  };
}
