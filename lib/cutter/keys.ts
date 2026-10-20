import { scoped } from "../owner";
import { keyLabel, refuse as docRefuse } from "../docflow/keys";

export { comboOf, keyLabel } from "../docflow/keys";

/**
 * The card cutter's keys, and the ones you have changed.
 *
 * The defaults are Verbatim's, because that is where a debater's hands
 * already are: F4–F7 the four heading levels, F8 cite, F9 underline, F10
 * emphasis, F11 highlight, F12 clear, F3 condense, F2 paste as plain text.
 * Every one can be moved (Keys, in the banner), and a laptop that needs Fn
 * for its F-keys is the usual reason to.
 */

export interface Action { id: string; group: string; label: string; key: string | null; hint: string }

export const ACTIONS: Action[] = [
  { id: "pocket", group: "Headings", label: "Pocket", key: "F4", hint: "The biggest heading, in a box — a whole file's subject" },
  { id: "hat", group: "Headings", label: "Hat", key: "F5", hint: "A group of blocks" },
  { id: "block", group: "Headings", label: "Block", key: "F6", hint: "A block — “AT: Econ”" },
  { id: "tag", group: "Headings", label: "Tag", key: "F7", hint: "A card's tag" },
  { id: "cite", group: "Cutting", label: "Cite", key: "F8", hint: "Author and date, 13pt bold" },
  { id: "underline", group: "Cutting", label: "Underline", key: "F9", hint: "Underline, back to full size" },
  { id: "emphasis", group: "Cutting", label: "Emphasis", key: "F10", hint: "Bold and underlined" },
  { id: "highlight", group: "Cutting", label: "Highlight", key: "F11", hint: "In the highlighter's colour" },
  { id: "clear", group: "Cutting", label: "Clear", key: "F12", hint: "Back to plain text" },
  { id: "shrink", group: "Cutting", label: "Shrink", key: "alt+F3", hint: "What is not underlined goes small (again: back)" },
  { id: "condense", group: "Cutting", label: "Condense", key: "F3", hint: "The card's paragraphs into one" },
  { id: "paste", group: "Cutting", label: "Paste as text", key: "F2", hint: "Without the source's formatting" },
  { id: "hl-next", group: "Cutting", label: "Next highlighter colour", key: "alt+F11", hint: "Yellow, green, blue, pink, grey" },
  { id: "new-card", group: "Files", label: "New card", key: "alt+N", hint: "A tag, a cite and room for the card, after this one" },
  { id: "save", group: "Files", label: "Save", key: "mod+S", hint: "It also saves by itself as you go" },
  { id: "find", group: "Files", label: "Search every file", key: "mod+shift+F", hint: "Tags, cites, blocks and what is read" },
  { id: "new-file", group: "Files", label: "New file", key: "alt+shift+N", hint: "" },
];
export const ACTION = new Map(ACTIONS.map((a) => [a.id, a]));

/**
 * Why a key cannot be used, or null if it can. Doc flow's rule, except that
 * F5, F11 and F12 are allowed here: a page can keep them, and they are where
 * Verbatim puts hat, highlight and clear.
 */
const MINE = new Set(["F5", "F11", "F12"]);
export function refuse(spec: string): string | null {
  if (MINE.has(spec)) return null;
  return docRefuse(spec);
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
