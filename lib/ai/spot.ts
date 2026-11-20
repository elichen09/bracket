/**
 * A place in a document that stays put while you keep typing. AI work runs
 * in the background, so the cite you asked for has to land where you were
 * when you asked, not wherever the cursor has got to since. A spot is
 * mapped through every edit to its document. A spot made on one document
 * is never used on another one opened in the same view.
 */
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";

export interface Spot { pos: number; lost: boolean; line: object }

const key = new PluginKey<object>("aiSpot");
const SPOTS = new Set<Spot>();

/** Goes in every editor's plugins. Its state is just an identity for "this document". */
export const spotPlugin = () => new Plugin<object>({
  key,
  state: {
    init: () => ({}),
    apply(tr, line) {
      if (tr.docChanged && SPOTS.size) {
        for (const s of SPOTS) {
          if (s.line !== line) continue;
          const r = tr.mapping.mapResult(s.pos, -1);
          s.pos = r.pos;
          if (r.deleted) s.lost = true;
        }
      }
      return line;
    },
  },
});

/** A spot at `pos`, kept up to date until it's let go. Returns null when the editor lacks the plugin. */
export function holdSpot(state: EditorState, pos: number): Spot | null {
  const line = key.getState(state);
  if (!line) return null;
  const s: Spot = { pos, lost: false, line };
  SPOTS.add(s);
  return s;
}

/** Where the spot is now, in this state. Returns null when the document has been swapped for another. The spot is let go either way. */
export function takeSpot(state: EditorState, s: Spot | null): { pos: number; lost: boolean } | null {
  if (!s) return null;
  SPOTS.delete(s);
  if (key.getState(state) !== s.line) return null;
  return { pos: Math.max(0, Math.min(s.pos, state.doc.content.size)), lost: s.lost };
}
