import { scoped } from "../owner";

/**
 * Your rhetoric: the things you say every round and would rather not type
 * again mid-speech — a weighing mechanism, the framing, a frontline to a
 * turn you always hear. Each piece is a title and its lines, as text: one
 * line per flow line, and a tab or two spaces in front of a line puts it
 * under the one above.
 *
 * Kept in this browser, apart per account, and shared by every flow the
 * account keeps.
 */

export interface Piece { id: string; title: string; text: string; updated: number }

const key = (owner?: string | null) => scoped("docflow.rhetoric", owner);

export function loadPieces(owner?: string | null): Piece[] {
  try {
    const list = JSON.parse(localStorage.getItem(key(owner)) || "[]");
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function savePieces(owner: string | null | undefined, list: Piece[]) {
  try { localStorage.setItem(key(owner), JSON.stringify(list)); } catch { /* private browsing */ }
}

export const newPieceId = () => "r" + Math.random().toString(36).slice(2, 10);

/** A title for lines that arrived without one: the first line, cut short. */
export const titleFrom = (text: string) => {
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) || "Untitled";
  return first.length > 48 ? first.slice(0, 46).trimEnd() + "…" : first;
};
