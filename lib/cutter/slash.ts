import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { schema } from "../evidence/docSchema";

/**
 * "/" at the start of an empty line, then words: a search, there in the document. The plugin only
 * says what is typed and where (so a menu can sit under it) and hands over the keys while the menu
 * is up; what is searched, and what is put in, is the host's.
 *
 * Only a line that is nothing but "/words" — a slash inside a sentence ("and/or") is just a slash.
 * Esc shuts the menu for that line until what's on it changes.
 */

export interface SlashAt { q: string; from: number; to: number; left: number; top: number; bottom: number }
export interface SlashHooks {
  /** The "/words" line under the cursor, or null when there isn't one (or the menu was shut). */
  onChange: (at: SlashAt | null, view: EditorView) => void;
  /** A key while the menu is up: true when the menu took it. */
  onKey: (e: KeyboardEvent, view: EditorView) => boolean;
}

export function slashPlugin(h: SlashHooks) {
  let open = false;
  let shut: string | null = null;
  const read = (v: EditorView) => {
    const { $from, empty } = v.state.selection;
    const p = $from.parent;
    if (!empty || !v.editable || $from.depth !== 1 || p.type !== schema.nodes.paragraph) return null;
    const text = p.textContent;
    if (!text.startsWith("/") || text.startsWith("//") || $from.parentOffset !== text.length || text.length > 80) return null;
    return { text, from: $from.start(), to: $from.end() };
  };
  const close = (v: EditorView) => { if (open) { open = false; h.onChange(null, v); } };
  const check = (v: EditorView) => {
    const r = read(v);
    const key = r ? r.from + ":" + r.text : null;
    if (shut && key !== shut) shut = null;
    if (!r || key === shut || !v.hasFocus()) { close(v); return; }
    const c = v.coordsAtPos(r.to);
    open = true;
    h.onChange({ q: r.text.slice(1), from: r.from, to: r.to, left: c.left, top: c.top, bottom: c.bottom }, v);
  };
  return new Plugin({
    view: (v0) => ({
      update(v, prev) { if (open || v.state.doc !== prev.doc || !v.state.selection.eq(prev.selection)) check(v); },
      destroy() { close(v0); },
    }),
    props: {
      handleKeyDown(v, e) {
        if (!open) return false;
        if (e.key === "Escape") { const r = read(v); shut = r ? r.from + ":" + r.text : null; close(v); return true; }
        return h.onKey(e, v);
      },
      handleDOMEvents: {
        focus(v) { setTimeout(() => check(v), 0); return false; },
        blur(v) { close(v); return false; },
      },
    },
  });
}
