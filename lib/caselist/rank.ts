import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRatings, type RatingRow } from "../ratings";
import { CIRCUITS, type Circuit } from "../circuit";

/**
 * Where a caselist team stands in this site's ratings.
 *
 * The two name a team differently. The wiki files a team under its school and
 * the first two letters of each debater's last name — "BASIS Peoria" / "ChKi";
 * Tabroom, and so the ratings, code it by school and initials — "BASIS Peoria
 * CK". So a team is found by its school and the SET of its initials (either
 * order, as `initialsKey` does), and a school name that differs in spacing or a
 * trailing "High School" still meets. A team the ratings do not know is simply
 * unranked, and sorts after the ranked ones.
 */

export interface Standing { rank: number; of: number; rating: number; code: string }

/** Which ratings a wiki's teams are judged against. */
export function circuitOf(wiki: string): Circuit | null {
  if (/^hspf/i.test(wiki)) return "pf";
  if (/^hsld/i.test(wiki)) return "ld";
  if (/^hspolicy/i.test(wiki)) return "policy";
  if (/^ndtceda/i.test(wiki)) return "cx";
  return null;
}

const norm = (s: string) => s.toLowerCase()
  .replace(/&/g, "and")
  .replace(/\b(high school|senior high|hs|school|preparatory|prep)\b/g, "")
  .replace(/[^a-z0-9]/g, "");

/** "ChKi" -> "ck"; "Ch" -> "c"; the letters sorted, so order never matters. */
export function wikiInitials(team: string): string {
  const parts = team.match(/[A-Z][a-z]*/g) || [];
  return parts.map((p) => p[0].toLowerCase()).sort().join("");
}

function codeParts(code: string): { school: string; initials: string } | null {
  const m = code.replace(/\s+/g, " ").trim().match(/^(.+)\s+([A-Za-z]{1,4})$/);
  return m ? { school: m[1], initials: m[2].toLowerCase().split("").sort().join("") } : null;
}

interface Table { at: number; of: number; byKey: Map<string, Standing>; byInit: Map<string, { school: string; s: Standing }[]> }
const tables = new Map<Circuit, Table>();
const LIFE = 30 * 60_000;

async function table(db: SupabaseClient, c: Circuit): Promise<Table> {
  const had = tables.get(c);
  if (had && Date.now() - had.at < LIFE) return had;
  const rows = (await loadRatings(db, CIRCUITS[c].teamKind)).filter((r: RatingRow) => r.games > 0);
  const byKey = new Map<string, Standing>();
  const byInit = new Map<string, { school: string; s: Standing }[]>();
  rows.forEach((r, i) => {
    const p = codeParts(r.display || r.key);
    if (!p) return;
    const s: Standing = { rank: i + 1, of: rows.length, rating: Math.round(r.rating), code: r.display || r.key };
    for (const school of new Set([norm(p.school), r.school ? norm(r.school) : ""])) {
      if (!school) continue;
      const k = school + "|" + p.initials;
      if (!byKey.has(k)) byKey.set(k, s);                 // rows come strongest first: the first claim stands
      const list = byInit.get(p.initials) || [];
      list.push({ school, s });
      byInit.set(p.initials, list);
    }
  });
  const t = { at: Date.now(), of: rows.length, byKey, byInit };
  tables.set(c, t);
  return t;
}

/** Standings for a wiki's teams, by `school|team`. */
export async function standings(db: SupabaseClient, wiki: string, teams: { school: string; schoolName: string; team: string }[]): Promise<Record<string, Standing>> {
  const c = circuitOf(wiki);
  if (!c) return {};
  const t = await table(db, c);
  const out: Record<string, Standing> = {};
  for (const tm of teams) {
    const init = wikiInitials(tm.team);
    if (!init) continue;
    const names = [norm(tm.schoolName), norm(tm.school)].filter(Boolean);
    let s: Standing | undefined;
    for (const n of names) { s = t.byKey.get(n + "|" + init); if (s) break; }
    if (!s) {
      // a school written a little differently: one name starting the other, and only one such team
      const near = (t.byInit.get(init) || []).filter((x) => names.some((n) => n.length >= 4 && x.school.length >= 4 && (x.school.startsWith(n) || n.startsWith(x.school))));
      const distinct = new Set(near.map((x) => x.s.code));
      if (distinct.size === 1) s = near[0].s;
    }
    if (s) out[tm.school + "|" + tm.team] = s;
  }
  return out;
}
