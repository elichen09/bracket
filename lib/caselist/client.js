/**
 * The caselist index, in the browser — shared by Evidence and Flow.
 *
 * Once a week every disclosed document on this season's wikis is read into an
 * index of its tags (scripts/caselist-index.mjs). This loads a wiki's index —
 * from this browser if it is current, from the server if not — searches every
 * tag in it, orders the teams by this site's ratings, and fetches a card's
 * body when one is wanted. Everything it downloads it keeps in IndexedDB, per
 * account, so a second tool (or a second visit) costs nothing.
 *
 * The tools draw; this knows. It tells whoever is listening when something
 * changed — an index loading ('progress'), ready ('index'), the teams' ranks
 * arriving ('ranks'), or failing ('error') — and they redraw.
 *
 * Offline it searches the indexes it kept, without a word about the network
 * (st.offline says so), and in the desktop app a card opens from the week's
 * archive kept on the computer when there is one (offline.js) — first, even
 * online: it is quicker than asking.
 */

import { stem } from './search';
import { kept, keep } from './kept';
import { createCore } from './core';
import { apiBase, caselistHeaders, caselistSignedOut, isDesktop } from '../desktop';
import * as offline from './offline';

/** Searching from what this computer kept is allowed without a fresh sign-in (lib/desktop's gate reads this). */
const HAVE = 'coda.caselist.kept';
const noteHave = () => { try { localStorage.setItem(HAVE, '1'); } catch { /* private */ } };
export const haveKept = () => { try { return localStorage.getItem(HAVE) === '1'; } catch { return false; } };
/** A fetch that never reached anyone — no network — as against a server that said no. */
const unreachable = (e) => e instanceof TypeError || /failed to fetch|network|load failed/i.test(String(e && e.message));

/** The caselist route: this site's on the web; the live site's from the desktop app, with its openCaselist sign-in. */
const api = () => ({ base: apiBase(), headers: caselistHeaders() });
/** A 401 to the app means its openCaselist sign-in has run out: it asks again. */
function unsigned(r) { if (r.status === 401 && isDesktop()) caselistSignedOut(); }

export const ORDER = ['hspf', 'hsld', 'hspolicy', 'ndtceda'];
export const SHORT = { hspf: 'PF', hsld: 'LD', hspolicy: 'Policy', ndtceda: 'NDT-CEDA' };
export const familyOf = (slug) => ORDER.find((f) => slug.startsWith(f)) || slug;
export const shortOf = (slug) => SHORT[familyOf(slug)] || slug;
export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const DOC_LIFE = 30 * 864e5;

/* ------------------------------------------------------------ the worker that loads and searches */

/**
 * Ask core.js something — in a worker, so the page never waits on an index
 * being unpacked or searched; on the page itself if no worker will start.
 */
function remote(onEvent) {
  let worker = null;
  try { worker = new Worker(new URL('./worker.js', import.meta.url)); } catch { worker = null; }
  if (!worker) {
    const core = createCore(onEvent);
    return { call: (op, args) => Promise.resolve().then(() => core[op](args)) };
  }
  let seq = 0;
  const waiting = new Map();
  let local = null;                  // the worker died: the page does it after all
  worker.onmessage = (e) => {
    const m = e.data || {};
    if (m.ev) { onEvent(m); return; }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.rej(new Error(m.error)); else w.res(m.result);
  };
  worker.onerror = () => {
    if (!local) local = createCore(onEvent);
    for (const [, w] of waiting) Promise.resolve().then(() => local[w.op](w.args)).then(w.res, w.rej);
    waiting.clear();
  };
  return {
    call(op, args) {
      if (local) return Promise.resolve().then(() => local[op](args));
      return new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej, op, args }); worker.postMessage({ id, op, args }); });
    },
  };
}

/** A response's JSON, or an error that says what went wrong rather than a parser's complaint. */
export async function json(r) {
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { throw new Error('the server had a problem (' + r.status + ')' + (r.status === 504 ? ' — it took too long' : '')); }
}

/** "Pro · UKSO Round 1", out of a disclosed file's name. */
export function roundOf(path) {
  const [, school, team, file] = path.split('/');
  const base = (file || '').replace(/\.[a-z]+$/i, '');
  const rest = base.replace(new RegExp('^' + (school || '').replace(/\W/g, '\\W?') + '-' + (team || '') + '-?', 'i'), '');
  const words = rest.split(/-+/).filter(Boolean);
  const si = words.findIndex((w) => /^(aff|neg|pro|con)$/i.test(w));
  const side = si >= 0 ? words[si] : '';
  const after = words.slice(si + 1);
  if (after.length && /^\d{1,2}\.?$/.test(after[0])) after.shift();   // the file's own order, not the round
  return [side, (si >= 0 ? after : words).join(' ')].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------ the client */

const clients = new Map();

/** One per account per page: the indexes it has loaded are shared by whatever asks. */
export function caselistClient(owner, scoped) {
  const DBNAME = scoped('caselist', owner);
  if (clients.has(DBNAME)) return clients.get(DBNAME);

  const st = {
    metas: null,               // what the server has: [{ wiki, built, cards, docs, bytes, zip }]
    idx: new Map(),            // slug -> { meta, count, zip, ranks } — the cards themselves stay in the worker
    loading: new Map(),        // slug -> { got, total }
    offline: false,            // the server could not be reached: searching what is kept
  };
  const subs = new Set();
  const tell = (what, detail) => subs.forEach((f) => { try { f(what, detail); } catch { /* a listener's own problem */ } });
  const core = remote((m) => {
    if (m.ev === 'progress' && st.loading.has(m.slug)) { st.loading.set(m.slug, { got: m.got, total: m.total }); tell('progress', m.slug); }
  });

  let metasP = null;
  function metas() {
    if (!metasP) {
      metasP = (async () => {
        // what was there last time, at once: the indexes open from this browser while the server is asked what is new
        const was = await kept(DBNAME, 'indexes', '~metas');
        if (was && Array.isArray(was.metas) && !st.metas) { st.metas = was.metas; tell('metas'); }
        const fresh = (async () => {
          try {
            const a = api();
            const r = await fetch(a.base + '/api/tools/caselist?op=indexes', { cache: 'no-store', headers: a.headers });
            unsigned(r);
            const j = await json(r);
            if (!r.ok) throw new Error(j.error || 'the server said ' + r.status);
            const moved = JSON.stringify(j.indexes) !== JSON.stringify(st.metas);
            if (st.offline) { st.offline = false; tell('metas'); }
            st.metas = j.indexes;
            // archives kept on this computer: a newer week's replaces the old one, in the background
            offline.keptList().then((have) => {
              for (const m of j.indexes) { const k = have.get(m.wiki); if (k && m.zip && m.zip.url && k.url !== m.zip.url) offline.keep(m.wiki, m.zip.url).catch(() => { /* next time */ }); }
            });
            keep(DBNAME, 'indexes', { wiki: '~metas', metas: j.indexes });
            if (moved) {
              // an index rebuilt since: the one in hand is last week's
              for (const m of j.indexes) { const ix = st.idx.get(m.wiki); if (ix && ix.meta.built !== m.built) { st.idx.delete(m.wiki); loadIndex(m.wiki); } }
              tell('metas');
            }
          } catch (e) {
            // no network, and indexes kept: search those, and say so quietly (the bar), not as an error
            if (unreachable(e) && st.metas && st.metas.length) { st.offline = true; metasP = null; tell('metas'); return st.metas; }
            if (!st.metas) { st.metas = []; metasP = null; }
            tell('error', unreachable(e) ? 'No internet — the caselist needs it the first time' : e.message);
            tell('metas');
          }
          return st.metas;
        })();
        return st.metas || fresh;
      })();
    }
    return metasP;
  }

  const pending = new Map();
  function loadIndex(slug) {
    if (st.idx.has(slug)) return Promise.resolve(st.idx.get(slug));
    if (pending.has(slug)) return pending.get(slug);
    const meta = (st.metas || []).find((m) => m.wiki === slug);
    if (!meta) return Promise.resolve(null);
    st.loading.set(slug, { got: 0, total: 0 });
    tell('progress', slug);
    const p = core.call('load', { slug, built: meta.built, bytes: meta.bytes, db: DBNAME, api: api() }).then((r) => {
      const ix = { meta, count: r.count, zip: r.zip, ranks: {}, teams: r.teams || [] };
      st.idx.set(slug, ix);
      noteHave();
      st.loading.delete(slug);
      // where every team in it stands — one question for the whole wiki, asked once a day
      const RK = '~ranks:' + slug;
      kept(DBNAME, 'indexes', RK).then((was) => {
        if (was && was.ranks) { ix.ranks = was.ranks; tell('ranks', slug); if (was.built === meta.built && Date.now() - was.at < 864e5) return; }
        fetch(api().base + '/api/tools/caselist?op=ranks', {
          method: 'POST', headers: { 'content-type': 'application/json', ...api().headers },
          body: JSON.stringify({ wiki: slug, teams: r.teams }),
        }).then(json).then((j) => { ix.ranks = j.ranks || {}; keep(DBNAME, 'indexes', { wiki: RK, built: meta.built, at: Date.now(), ranks: ix.ranks }); tell('ranks', slug); }).catch(() => { /* unranked, not broken */ });
      });
      tell('index', slug);
      return ix;
    }).catch((e) => {
      st.loading.delete(slug);
      tell('error', 'Caselist ' + shortOf(slug) + ': ' + e.message);
      return null;
    }).finally(() => pending.delete(slug));
    pending.set(slug, p);
    return p;
  }

  /** Load every index in these families. */
  async function warm(families) {
    await metas();
    for (const m of st.metas || []) if (families.has(familyOf(m.wiki))) loadIndex(m.wiki);
  }

  /**
   * The cards that answer `q` in these families' loaded indexes (search.js:
   * the tag, the block it sits under, its read text and its cite, by roots
   * and debate synonyms, and by which way it argues), grouped by team — the
   * teams with the best answers first, strongest team first among them;
   * within a team, the best answers first, then the ones read in the most
   * rounds. A promise: the search runs in the worker.
   */
  const EMPTY = () => ({ groups: [], total: 0, terms: [], roots: [], most: 0, of: 0, opposite: 0 });
  // one search at a time, and only the latest waits its turn: typing ahead of the worker never queues up
  // a search for every letter — the ones overtaken come back empty and marked stale
  let busy = false, next = null;
  function ask(q, families, opts) {
    return new Promise((res, rej) => {
      const job = { q, families: [...families], answer: !!(opts && opts.answer), res, rej };
      if (busy) { if (next) next.res({ ...EMPTY(), stale: true }); next = job; return; }
      run(job);
    });
  }
  function run(job) {
    busy = true;
    core.call('find', { q: job.q, families: job.families, answer: job.answer }).then(job.res, job.rej).finally(() => {
      busy = false;
      if (next) { const j = next; next = null; run(j); }
    });
  }
  async function find(q, families, opts) {
    if (String(q || '').trim().length < 2) return EMPTY();
    const r = await ask(q, families, opts);
    if (r.stale) return r;
    r.groups.forEach((g) => { const ix = st.idx.get(g.slug); g.rank = (ix && ix.ranks[g.school + '|' + g.team]) || null; });
    // the teams whose cards answer it best, strongest team first; then the rest, the same way
    const top = r.groups.reduce((m, g) => Math.max(m, g.best), 0);
    r.groups.forEach((g) => { g.tier = g.best >= top * 0.7 ? 0 : 1; });
    r.groups.sort((a, b) => a.tier - b.tier || (a.rank ? a.rank.rank : 1e6) - (b.rank ? b.rank.rank : 1e6) || b.best - a.best || a.team.localeCompare(b.team));
    r.roots = (r.terms || []).map(stem);
    return r;
  }

  /** A card's body as HTML — its block heading, its tag, its paragraphs — kept once fetched. */
  async function cardHtml(card) {
    const ix = st.idx.get(card.slug);
    const d = card.d;
    const key = d[0] + '#' + norm(card.tag).slice(0, 80);
    const rec = await kept(DBNAME, 'docs', key);
    if (rec && rec.html && Date.now() - rec.at < DOC_LIFE) return rec.html;
    // the week's archive kept on this computer: the card from there, no network needed
    if (ix && ix.zip && (await offline.keptFor(card.slug, ix.zip.url))) {
      try {
        const html = await offline.localCard(card.slug, d, card.tag);
        if (html) { keep(DBNAME, 'docs', { path: key, at: Date.now(), html }, 2000); return html; }
      } catch { /* from the site, then */ }
    }
    const u = '/api/tools/caselist?op=card&path=' + encodeURIComponent(d[0]) + '&zip=' + encodeURIComponent((ix && ix.zip && ix.zip.url) || '') +
      '&off=' + d[1] + '&len=' + d[2] + '&m=' + d[3] + '&nl=' + d[4] + '&tag=' + encodeURIComponent(card.tag);
    let r;
    try { r = await fetch(api().base + u, { headers: api().headers }); }
    catch (e) {
      if (!unreachable(e)) throw e;
      throw new Error(offline.canKeep() ? 'No internet — Keep offline (in the caselist bar) keeps the cards on this computer' : 'No internet — the card needs it');
    }
    unsigned(r);
    if (!r.ok) { const j = await json(r).catch((e) => ({ error: e.message })); throw new Error(j.error || 'the card would not open'); }
    const html = await r.text();
    keep(DBNAME, 'docs', { path: key, at: Date.now(), html }, 2000);
    return html;
  }

  /** Every team in these families' loaded indexes: { slug, school, team, name, rank }. */
  function teams(families) {
    const out = [];
    for (const [slug, ix] of st.idx) {
      if (!families.has(familyOf(slug))) continue;
      for (const [school, team, schoolName] of ix.teams || []) {
        out.push({ slug, school, team, name: (schoolName || school) + ' ' + team, rank: (ix.ranks && ix.ranks[school + '|' + team]) || null });
      }
    }
    return out;
  }

  /** One team's documents and cards, from its loaded index (the worker). */
  const team = (slug, school, tm) => core.call('team', { slug, school, team: tm });

  /**
   * One team's rounds on openCaselist — when, where, which side, against whom,
   * the report of what they went for — and the positions each round lists.
   * Kept, so it shows offline as it was last seen.
   */
  async function rounds(slug, school, tm) {
    const KEY = '~team:' + slug + '/' + school + '/' + tm;
    try {
      const a = api();
      const r = await fetch(a.base + '/api/tools/caselist?op=team&wiki=' + encodeURIComponent(slug) + '&school=' + encodeURIComponent(school) + '&team=' + encodeURIComponent(tm), { cache: 'no-store', headers: a.headers });
      unsigned(r);
      const j = await json(r);
      if (!r.ok) throw new Error(j.error || 'the server said ' + r.status);
      const rec = { wiki: KEY, at: Date.now(), rounds: j.rounds || [], cites: j.cites || [] };
      keep(DBNAME, 'indexes', rec);
      return { ...rec, kept: false };
    } catch (e) {
      const was = await kept(DBNAME, 'indexes', KEY);
      if (was) return { ...was, kept: true };
      throw e;
    }
  }

  const client = { st, metas, loadIndex, warm, find, cardHtml, offline, teams, team, rounds, on: (f) => { subs.add(f); return () => subs.delete(f); } };
  clients.set(DBNAME, client);
  return client;
}
