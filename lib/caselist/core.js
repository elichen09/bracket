/**
 * The caselist's indexes, loaded and searched — off the page.
 *
 * A wiki's index is tens of megabytes of tags; unpacking one, building its
 * search and running a search over a few hundred thousand cards are each
 * long enough to be felt if the page does them, and the page is where you
 * are typing. So they happen here, in a worker (worker.js), and the page
 * only asks and draws. The same code runs on the page itself in a browser
 * that will not start a worker.
 *
 * `tell` is how it says what is happening: { ev: 'progress', slug, got, total }.
 */

import { buildSearch, searchCards, SEARCH_V, PLACE } from './search';
import { kept, keep } from './kept';

const ORDER = ['hspf', 'hsld', 'hspolicy', 'ndtceda'];
const familyOf = (slug) => ORDER.find((f) => slug.startsWith(f)) || slug;

async function gunzipJson(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}
async function json(r) {
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { throw new Error('the server had a problem (' + r.status + ')' + (r.status === 504 ? ' — it took too long' : '')); }
}

export function createCore(tell) {
  const idx = new Map();           // slug -> { docs, cards, blocks, names, zip, search }
  const pending = new Map();

  /** A wiki's index, from this browser if it is current, from the server if not — and its search, built or read back. */
  function load({ slug, built, bytes, db }) {
    if (idx.has(slug)) return Promise.resolve(summary(slug));
    if (pending.has(slug)) return pending.get(slug);
    const p = (async () => {
      let rec = await kept(db, 'indexes', slug);
      if (!rec || rec.built !== built) {
        tell({ ev: 'progress', slug, got: 0, total: bytes || 0 });
        const r = await fetch('/api/tools/caselist?op=index&wiki=' + encodeURIComponent(slug), { cache: 'no-store', credentials: 'same-origin' });
        const j = await json(r);
        if (!r.ok) throw new Error(j.error || 'the server said ' + r.status);
        const res = await fetch(j.url);
        if (!res.ok || !res.body) throw new Error('the index would not download (' + res.status + ')');
        const reader = res.body.getReader();
        const parts = [];
        let got = 0, said = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value); got += value.length;
          if (got - said > 262144) { said = got; tell({ ev: 'progress', slug, got, total: bytes || got }); }
        }
        const buf = await new Blob(parts).arrayBuffer();
        rec = { wiki: slug, built, at: Date.now(), gz: buf };
        keep(db, 'indexes', rec);
      }
      const data = await gunzipJson(rec.gz);
      const names = new Map();
      const teams = [];
      data.docs.forEach((d) => {
        const [, school, team] = d[0].split('/');
        const k = school + '|' + team;
        if (names.has(k)) return;
        const schoolName = data.schools[school] || school;
        names.set(k, (data.schools[school] || school.replace(/([a-z])([A-Z])/g, '$1 $2')) + ' ' + team);
        teams.push([school, team, schoolName]);
      });
      // the search: read back if this index's was kept, built (and kept) if not
      let search = null;
      const was = await kept(db, 'search', slug);
      if (was && was.built === built && was.s && was.s.v === SEARCH_V && was.s.n === data.cards.length) search = was.s;
      if (!search) {
        search = buildSearch(data.cards, data.blocks || []);
        keep(db, 'search', { wiki: slug, built, s: search });
      }
      idx.set(slug, { docs: data.docs, cards: data.cards, blocks: data.blocks || [], names, teams, zip: data.zip, search });
      return summary(slug);
    })().finally(() => pending.delete(slug));
    pending.set(slug, p);
    return p;
  }
  const summary = (slug) => { const ix = idx.get(slug); return { slug, count: ix.cards.length, zip: ix.zip, teams: ix.teams }; };

  /**
   * The cards that answer `q` in these families' loaded indexes, grouped by
   * team — best answers first within a team. Each card carries what is needed
   * to show it and to fetch its body, and says where it matched, so a card
   * found by its block or its text rather than its tag can show why.
   */
  function find({ q, families, limit = 1500 }) {
    if (String(q || '').trim().length < 2) return { groups: [], total: 0, terms: [], most: 0, of: 0, opposite: 0 };
    const fams = new Set(families);
    const found = [];
    let terms = [], most = 0, of = 0, negated = false;
    for (const [slug, ix] of idx) {
      if (!fams.has(familyOf(slug))) continue;
      const r = searchCards(ix.search, q, (i) => ix.cards[i][1], (i) => (typeof ix.cards[i][4] === 'number' ? ix.blocks[ix.cards[i][4]] : ''), limit);
      terms = r.terms; of = r.of || 0; negated = !!r.negated;
      if ((r.most || 0) > most) most = r.most;
      found.push([slug, ix, r]);
    }
    // the best answers across every wiki searched: a wiki whose best card answers
    // fewer of the words than another's does not get its partial matches shown
    let all = [], total = 0, opposite = 0;
    // a wiki with cards that say it outranks one with only cards that say the opposite
    const anySays = found.some(([, , r]) => (r.most || 0) >= most && !r.flipped && r.hits.length);
    for (const [slug, ix, r] of found) {
      if ((r.most || 0) < most) continue;
      opposite += r.opposite || 0;
      if (r.flipped && anySays) continue;
      total += r.total || 0;
      for (const h of r.hits) all.push([slug, ix, h]);
    }
    const flipped = !anySays && found.some(([, , r]) => r.flipped);
    if (found.length > 1) all.sort((a, b) => b[2].score - a[2].score);
    if (all.length > limit) all = all.slice(0, limit);
    const byTeam = new Map();
    for (const [slug, ix, h] of all) {
      const c = ix.cards[h.i];
      const d = ix.docs[c[0]];
      const [, school, team] = d[0].split('/');
      const tk = slug + '|' + school + '|' + team;
      let g = byTeam.get(tk);
      if (!g) { g = { slug, school, team, name: ix.names.get(school + '|' + team) || school + ' ' + team, cards: [], best: 0 }; byTeam.set(tk, g); }
      if (h.score > g.best) g.best = h.score;
      g.cards.push({
        id: slug + ':' + h.i, slug, ci: h.i, path: d[0], d, tag: c[1], cite: c[2], rounds: c[3] || 1, score: h.score, pol: h.pol,
        block: typeof c[4] === 'number' ? ix.blocks[c[4]] || '' : '',
        // where it matched, when not in the tag: so the list can say why it is there
        via: h.places & PLACE.TAG ? '' : h.places & PLACE.BLOCK ? 'block' : h.places & PLACE.READ ? 'text' : h.places & PLACE.CITE ? 'cite' : '',
      });
    }
    const groups = [...byTeam.values()];
    groups.forEach((g) => g.cards.sort((x, y) => y.score - x.score || y.rounds - x.rounds));
    return { groups, total: Math.max(total, all.length), shown: all.length, terms, most, of, opposite, flipped, negated };
  }

  return { load, find };
}
