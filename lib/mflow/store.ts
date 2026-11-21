/**
 * Where your flows live: in this browser (or the desktop app), per account.
 * A list for the start screen, and each round on its own. Kept with every
 * edit, so closing the tab loses nothing.
 */
import { scoped } from "@/lib/owner";
import { title, type Round } from "./model";

export interface RoundRow { id: string; title: string; updated: number; order: Round["order"] }

const LIST = "coda.flows";
const ONE = (id: string) => "coda.flow." + id;

function read<T>(k: string, fallback: T): T {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function write(k: string, v: unknown) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or private: the round stays in memory */ }
}

export const listRounds = (owner?: string | null): RoundRow[] =>
  read<RoundRow[]>(scoped(LIST, owner), []).sort((a, b) => b.updated - a.updated);

export const getRound = (owner: string | null | undefined, id: string): Round | null => read<Round | null>(scoped(ONE(id), owner), null);

export function putRound(owner: string | null | undefined, r: Round) {
  write(scoped(ONE(r.id), owner), r);
  const list = listRounds(owner).filter((x) => x.id !== r.id);
  list.unshift({ id: r.id, title: title(r), updated: r.updated, order: r.order });
  write(scoped(LIST, owner), list.slice(0, 200));
}

export function dropRound(owner: string | null | undefined, id: string) {
  try { localStorage.removeItem(scoped(ONE(id), owner)); } catch { /* gone already */ }
  write(scoped(LIST, owner), listRounds(owner).filter((x) => x.id !== id));
}
