import type { Transaction } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../evidence/docSchema";

/**
 * Did this change touch a heading, or add or take away a paragraph? If not — the usual case, a letter
 * typed in a card — whatever a plugin drew from the doc's headings (a handle beside each, which
 * paragraphs belong to a card) only needs moving along with the text, not drawing again over the
 * whole file.
 */
export function touchesHeadings(tr: Transaction): boolean {
  if (tr.before.childCount !== tr.doc.childCount) return true;
  const H = schema.nodes.heading;
  let hit = false;
  const look = (d: PMNode, a: number, b: number) => {
    const from = Math.max(0, Math.min(a, d.content.size)), to = Math.max(from, Math.min(b, d.content.size));
    d.nodesBetween(from, to, (n) => { if (n.type === H) hit = true; return false; });
  };
  tr.mapping.maps.forEach((m, i) => {
    if (hit) return;
    const before = tr.docs[i], after = i + 1 < tr.docs.length ? tr.docs[i + 1] : tr.doc;
    m.forEach((os, oe, ns, ne) => { if (!hit) { look(before, os, oe); look(after, ns, ne); } });
  });
  return hit;
}
