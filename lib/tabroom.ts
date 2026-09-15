import * as cheerio from "cheerio";
import { parseSlot, type Team } from "./bracket";
import type { Result, Results, Tournament } from "./types";

/**
 * Tabroom access for the updater. Results pages require a login, so this keeps
 * a cookie jar for one session and signs in with the account in env.
 *
 * Be a good citizen: the updater runs hourly at most and touches a handful of
 * pages per tournament. Don't point it at more than you need.
 */

const BASE = "https://www.tabroom.com";
const API = "https://api.tabroom.com/v1";

interface ApiRound { id: number; type: string; name: number | string; eventId: number }

/** Published rounds from the public Tabroom API (no login). Null if the API is unavailable. */
export async function fetchApiRounds(tournId: number): Promise<ApiRound[] | null> {
  try {
    const res = await fetch(`${API}/rest/tourns/${tournId}/rounds`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/** The event id that owns a published result set (e.g. the bracket), from the public API. Null if unknown. */
export async function eventIdForResult(tournId: number, resultId: number): Promise<number | null> {
  try {
    const res = await fetch(`${API}/rest/tourns/${tournId}/results`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, { id: number; ResultSets?: { id: number }[] }>;
    for (const ev of Object.values(j || {})) {
      if ((ev.ResultSets || []).some((r) => r.id === resultId)) return ev.id;
    }
    return null;
  } catch {
    return null;
  }
}

export class TabroomSession {
  private cookies = new Map<string, string>();
  private loggedIn = false;
  private loginInFlight: Promise<void> | null = null;

  constructor(private username: string, private password: string) {}

  private cookieHeader(): string {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorb(res: Response) {
    const raw = (res.headers as any).getSetCookie?.() as string[] | undefined;
    const list = raw && raw.length ? raw : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
    for (const line of list) {
      const first = line.split(";")[0];
      const eq = first.indexOf("=");
      if (eq > 0) this.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(path.startsWith("http") ? path : BASE + path, {
      ...init,
      redirect: "manual",
      headers: {
        "user-agent": "TheBreak bracket-pool updater (personal, low volume)",
        cookie: this.cookieHeader(),
        ...(init.headers || {}),
      },
    });
    this.absorb(res);
    return res;
  }

  /** GET with redirects followed by hand so cookies set along the way are kept. */
  async get(path: string): Promise<{ url: string; html: string }> {
    let url = path;
    for (let i = 0; i < 5; i++) {
      const res = await this.raw(url);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        url = loc.startsWith("http") ? loc : BASE + loc;
        continue;
      }
      return { url, html: await res.text() };
    }
    throw new Error("too many redirects: " + path);
  }

  /** Sign in once; concurrent callers share the same attempt instead of racing each other's cookies. */
  async login(): Promise<void> {
    if (this.loggedIn) return;
    if (!this.loginInFlight) {
      this.loginInFlight = this.doLogin().finally(() => { this.loginInFlight = null; });
    }
    return this.loginInFlight;
  }

  private async doLogin(): Promise<void> {
    const page = await this.get("/user/login/login.mhtml");
    const $ = cheerio.load(page.html);
    const form = $('form[action*="login_save"]').first();
    if (!form.length) throw new Error("Tabroom login form not found");
    const body = new URLSearchParams();
    form.find("input[type=hidden]").each((_, el) => {
      const n = $(el).attr("name"), v = $(el).attr("value");
      if (n) body.set(n, v ?? "");
    });
    body.set("username", this.username);
    body.set("password", this.password);
    const action = form.attr("action") || "login_save.mhtml";
    const res = await this.raw("/user/login/" + action.replace(/^\/?user\/login\//, ""), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    // a successful login redirects to the home screen; a failed one back to the login page
    const loc = res.headers.get("location") || "";
    const check = await this.get("/user/home.mhtml");
    if (/login\.mhtml/.test(check.url) || /login\.mhtml\?err/.test(loc)) {
      throw new Error("Tabroom login failed — check TABROOM_USERNAME / TABROOM_PASSWORD");
    }
    this.loggedIn = true;
  }

  /** Fetch a results page, logging in first; throws if Tabroom still wants a login. */
  async page(path: string): Promise<string> {
    await this.login();
    const { url, html } = await this.get(path);
    if (/\/login\//.test(url)) throw new Error("Tabroom redirected to login for " + path);
    return html;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** The opening-round slots from a bracket page: one row per slot, "" for a bye. */
export function parseBracketSlots(html: string): string[] {
  const $ = cheerio.load(html);
  const table = $("table").first();
  if (!table.length) return [];
  const rows = table.find("tr").toArray().slice(1);
  return rows.map((tr) => $(tr).find("td").first().text().replace(/\s+/g, " ").trim());
}

export interface RoundRow { aff: string; neg: string; win: string }

/** Rows of a round_results page: Aff / Neg / Win ("2-1 NEG"), under whatever side labels the event uses. */
export function parseRoundRows(html: string): RoundRow[] {
  const $ = cheerio.load(html);
  const table = $("table").first();
  if (!table.length) return [];
  const head = table.find("tr").first().find("th,td").toArray().map((c) => $(c).text().trim().toLowerCase());
  // Events label sides differently: Aff/Neg, Pro/Con (Public Forum), Gov/Opp (Parli).
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const ai = col("aff", "pro", "gov", "prop"), ni = col("neg", "con", "opp"), wi = col("win", "winner", "decision");
  if (ai < 0 || ni < 0) return [];
  return table.find("tr").toArray().slice(1).map((tr) => {
    const c = $(tr).find("td").toArray().map((x) => $(x).text().replace(/\s+/g, " ").trim());
    return { aff: c[ai] || "", neg: c[ni] || "", win: wi >= 0 ? c[wi] || "" : "" };
  }).filter((r) => r.aff && r.neg);
}

// ---------------------------------------------------------------------------
// Sync — the same algorithm the artifact updater used, now server-side.
// ---------------------------------------------------------------------------

export interface SyncInput {
  tournId: number;
  resultId: number;
  slots: string[];
  results: Results;
  roundIds: Record<string, number>;
}

export interface SyncOutput {
  slots: string[];
  results: Results;
  roundIds: Record<string, number>;
  notes: Record<string, string>;
  log: string[];
  complete: boolean;
  changed: boolean;
}

export async function syncTournament(session: TabroomSession, cfg: SyncInput): Promise<SyncOutput> {
  const out: SyncOutput = {
    slots: (cfg.slots || []).slice(),
    results: JSON.parse(JSON.stringify(cfg.results || {})),
    roundIds: { ...(cfg.roundIds || {}) },
    notes: {}, log: [], complete: false, changed: false,
  };
  const base = `/index/tourn/results/`;

  if (!out.slots.length) {
    const html = await session.page(`${base}bracket.mhtml?tourn_id=${cfg.tournId}&result_id=${cfg.resultId}`);
    const slots = parseBracketSlots(html);
    const n = slots.length;
    if (!n || (n & (n - 1))) { out.log.push(`bracket table is not a power of two (${n} rows) — left pending`); return out; }
    out.slots = slots; out.changed = true;
    out.log.push(`pulled ${n} bracket slots`);
  }

  const entries: (Team | null)[] = out.slots.map(parseSlot);
  const size = entries.length, rounds = Math.round(Math.log(size) / Math.log(2)), first = size / 2;

  const field = (r: number): (Team | null)[] => {
    let f = entries.slice();
    for (let q = 0; q < r; q++) {
      const n = first >> q, next: (Team | null)[] = [], rr = out.results[String(q)] || {};
      for (let m = 0; m < n; m++) {
        const a = f[2 * m] ?? null, c = f[2 * m + 1] ?? null;
        let w: Team | null = null;
        if (q === 0 && !!a !== !!c) w = a || c;
        else if (a && c && rr[String(m)]) w = a.seed === rr[String(m)][0] ? a : c;
        next.push(w);
      }
      f = next;
    }
    return f;
  };

  // Next-round candidates: later elim rounds of the same event per the API, in
  // round order. Falls back to probing ids just above the last known one.
  let apiRounds: ApiRound[] | null | undefined;
  const nextCandidates = async (): Promise<{ ids: number[]; via: string }> => {
    const known = Object.values(out.roundIds).map(Number).filter(Boolean);
    if (apiRounds === undefined) apiRounds = await fetchApiRounds(cfg.tournId);
    const anchor = (apiRounds || [])
      .filter((x) => known.includes(x.id))
      .sort((a, b) => Number(b.name) - Number(a.name))[0];
    if (anchor) {
      const ids = apiRounds!
        .filter((x) => x.eventId === anchor.eventId && (x.type === "elim" || x.type === "final") && Number(x.name) > Number(anchor.name))
        .sort((a, b) => Number(a.name) - Number(b.name))
        .map((x) => x.id);
      return { ids, via: "api" };
    }
    const start = Math.max(...known);
    return { ids: Array.from({ length: 8 }, (_, k) => start + k + 1), via: "probe" };
  };

  // No round ids at all (the first elim round's link was never given): find the
  // event that owns this bracket and try its elim rounds, the one whose depth
  // matches the bracket size first.
  const firstElimCandidates = async (): Promise<number[]> => {
    if (apiRounds === undefined) apiRounds = await fetchApiRounds(cfg.tournId);
    const eventId = await eventIdForResult(cfg.tournId, cfg.resultId);
    if (!eventId || !apiRounds) return [];
    const elims = apiRounds
      .filter((x) => x.eventId === eventId && (x.type === "elim" || x.type === "final"))
      .sort((a, b) => Number(a.name) - Number(b.name));
    if (!elims.length) return [];
    const pref = elims.length >= rounds ? elims.length - rounds : 0;
    return [elims[pref], ...elims.filter((_, i) => i !== pref)].map((x) => x.id);
  };

  const readRound = async (id: number): Promise<RoundRow[]> =>
    parseRoundRows(await session.page(`${base}round_results.mhtml?tourn_id=${cfg.tournId}&round_id=${id}`));

  const matchRows = (r: number, rows: RoundRow[]) => {
    const f = field(r), n = first >> r, byName: Record<string, Team> = {};
    const hits: { idx: number; A: Team; N: Team; row: RoundRow }[] = [];
    f.forEach((e) => { if (e) byName[e.name] = e; });
    for (const row of rows) {
      const A = byName[row.aff], N = byName[row.neg];
      if (!A || !N) continue;
      for (let i = 0; i < n; i++) {
        const a = f[2 * i], c = f[2 * i + 1];
        if (a && c && ((a.seed === A.seed && c.seed === N.seed) || (a.seed === N.seed && c.seed === A.seed))) { hits.push({ idx: i, A, N, row }); break; }
      }
    }
    return hits;
  };

  // A match with no posted decision is settled by the next round's pairings.
  const inferAdvances = (r: number, rows: RoundRow[]) => {
    const names: Record<string, true> = {};
    rows.forEach((row) => { names[row.aff] = true; names[row.neg] = true; });
    const f = field(r), n = first >> r;
    const rr = (out.results[String(r)] = out.results[String(r)] || {});
    let added = 0;
    for (let i = 0; i < n; i++) {
      // ADV results are defaults (inferred or closeout), so the next round's pairings can correct them
      if (rr[String(i)] && rr[String(i)][2] !== "ADV") continue;
      const a = f[2 * i], c = f[2 * i + 1];
      if (!a || !c) continue;
      const w = names[a.name] ? a : names[c.name] ? c : null;
      if (w && rr[String(i)]?.[0] !== w.seed) {
        rr[String(i)] = [w.seed, "adv", "ADV"];
        out.notes[`${r}:${i}`] = `No decision posted for ${a.seed} ${a.name} vs ${c.seed} ${c.name}; ${w.name} is the team that appeared in the next round.`;
        added++;
      }
    }
    return added;
  };

  // Same-school matchups close out with no decision posted: the higher seed advances.
  const school = (t: Team) => t.name.replace(/\s+\S+$/, "").toLowerCase();
  const settleCloseouts = (r: number) => {
    const f = field(r), n = first >> r;
    const rr = (out.results[String(r)] = out.results[String(r)] || {});
    let added = 0;
    for (let i = 0; i < n; i++) {
      const a = f[2 * i], c = f[2 * i + 1];
      if (!a || !c || rr[String(i)] || school(a) !== school(c)) continue;
      const w = a.seed < c.seed ? a : c, l = w === a ? c : a;
      rr[String(i)] = [w.seed, "adv", "ADV"];
      out.notes[`${r}:${i}`] = `${w.seed} ${w.name} vs ${l.seed} ${l.name} is a same-school closeout with no decision posted; the higher seed advances.`;
      added++;
    }
    return added;
  };

  for (let r = 0; r < rounds; r++) {
    const f = field(r);
    if (f.every((x) => !x)) break;
    let id = out.roundIds[String(r)];
    let rows: RoundRow[] | null = null;
    if (id) {
      rows = await readRound(id);
    } else {
      const known = Object.values(out.roundIds).map(Number).filter(Boolean);
      // A closeout default can put the wrong team in round r's field, so also accept a
      // page whose pairings are drawn from teams that played in round r - 1.
      const prevNames = new Set(field(r - 1).filter((x): x is Team => !!x).map((x) => x.name));
      const fromPrevRound = (rows2: RoundRow[]) => rows2.some((row) => prevNames.has(row.aff) && prevNames.has(row.neg));
      let ids: number[], via: string;
      if (!known.length) {
        ids = await firstElimCandidates();
        via = "api, first elim of the bracket's event";
        if (!ids.length) { out.log.push("no elim rounds published on Tabroom for this event yet"); break; }
      } else {
        ({ ids, via } = await nextCandidates());
      }
      for (const cand of ids) {
        const rr2 = await readRound(cand);
        if (!rr2.length) continue;
        if (matchRows(r, rr2).length > 0 || fromPrevRound(rr2)) { id = cand; rows = rr2; out.roundIds[String(r)] = cand; out.changed = true; out.log.push(`round ${r} found at round_id ${cand} (${via})`); break; }
      }
      if (!rows) { out.log.push(`round ${r} not posted yet`); break; }
    }
    if (rows.length && r > 0) {
      const adv = inferAdvances(r - 1, rows);
      if (adv) { out.changed = true; out.log.push(`round ${r - 1}: ${adv} advance(s) inferred from the next round's pairings`); }
    }
    if (rows.length) {
      const hits = matchRows(r, rows);
      const rr = (out.results[String(r)] = out.results[String(r)] || {});
      let fresh = 0;
      for (const h of hits) {
        // "2-1 NEG", "3-0 Pro", "2-1 Con" …; the first side label is the Aff side in our model
        const mm = String(h.row.win).match(/^(\d+-\d+)\s+(AFF|NEG|PRO|CON|GOV|OPP|PROP)\b/i);
        if (!mm) continue;
        const side: "AFF" | "NEG" = /^(AFF|PRO|GOV|PROP)$/i.test(mm[2]) ? "AFF" : "NEG";
        const w = side === "AFF" ? h.A : h.N;
        const next: Result = [w.seed, mm[1], side];
        if (!rr[String(h.idx)]) fresh++;
        if (JSON.stringify(rr[String(h.idx)]) !== JSON.stringify(next)) { rr[String(h.idx)] = next; out.changed = true; }
      }
      out.log.push(`round ${r}: ${hits.length} pairings matched, ${fresh} new decisions`);
      const co = settleCloseouts(r);
      if (co) { out.changed = true; out.log.push(`round ${r}: ${co} closeout(s), higher seed advances`); }
    }
  }
  const last = out.results[String(rounds - 1)];
  out.complete = !!(last && last["0"]);
  return out;
}

export function statusFor(t: Pick<Tournament, "slots">, out: SyncOutput): Tournament["status"] {
  if (out.complete) return "complete";
  const any = Object.values(out.results).some((r) => Object.keys(r).length > 0);
  if (any) return "live";
  return out.slots.length ? "open" : "pending";
}
