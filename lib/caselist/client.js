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
 */

export const ORDER = ['hspf', 'hsld', 'hspolicy', 'ndtceda'];
export const SHORT = { hspf: 'PF', hsld: 'LD', hspolicy: 'Policy', ndtceda: 'NDT-CEDA' };
export const familyOf = (slug) => ORDER.find((f) => slug.startsWith(f)) || slug;
export const shortOf = (slug) => SHORT[familyOf(slug)] || slug;
export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const DOC_LIFE = 30 * 864e5;

/* ------------------------------------------------------------ kept in this browser */

const dbs = new Map();
function db(name) {
  if (!dbs.has(name)) {
    dbs.set(name, new Promise((res, rej) => {
      const r = indexedDB.open(name, 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'path' });
        if (!d.objectStoreNames.contains('indexes')) d.createObjectStore('indexes', { keyPath: 'wiki' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  }
  return dbs.get(name);
}
async function kept(name, store, key) {
  try {
    const d = await db(name);
    return await new Promise((res) => {
      const q = d.transaction(store).objectStore(store).get(key);
      q.onsuccess = () => res(q.result || null); q.onerror = () => res(null);
    });
  } catch { return null; }
}
async function keep(name, store, rec, cap) {
  try {
    const d = await db(name);
    const s = d.transaction(store, 'readwrite').objectStore(store);
    s.put(rec);
    if (cap) {
      const all = s.getAll();
      all.onsuccess = () => {
        const list = all.result || [];
        if (list.length > cap) list.sort((a, b) => a.at - b.at).slice(0, list.length - cap).forEach((x) => s.delete(x.path));
      };
    }
  } catch { /* not kept; fetched again next time */ }
}

async function gunzipJson(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
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
    idx: new Map(),            // slug -> { meta, docs, cards, low, teams, ranks, zip }
    loading: new Map(),        // slug -> { got, total }
  };
  const subs = new Set();
  const tell = (what, detail) => subs.forEach((f) => { try { f(what, detail); } catch { /* a listener's own problem */ } });

  let metasP = null;
  function metas() {
    if (!metasP) {
      metasP = (async () => {
        try {
          const r = await fetch('/api/tools/caselist?op=indexes', { cache: 'no-store' });
          const j = await json(r);
          if (!r.ok) throw new Error(j.error || 'the server said ' + r.status);
          st.metas = j.indexes;
        } catch (e) { st.metas = []; metasP = null; tell('error', e.message); }
        tell('metas');
        return st.metas;
      })();
    }
    return metasP;
  }

  const pending = new Map();
  function loadIndex(slug) {
    if (st.idx.has(slug)) return Promise.resolve(st.idx.get(slug));
    if (pending.has(slug)) return pending.get(slug);
    const p = (async () => {
      const meta = (st.metas || []).find((m) => m.wiki === slug);
      if (!meta) return null;
      let rec = await kept(DBNAME, 'indexes', slug);
      if (!rec || rec.built !== meta.built) {
        st.loading.set(slug, { got: 0, total: meta.bytes || 0 });
        tell('progress', slug);
        const r = await fetch('/api/tools/caselist?op=index&wiki=' + encodeURIComponent(slug), { cache: 'no-store' });
        const j = await json(r);
        if (!r.ok) throw new Error(j.error || 'the server said ' + r.status);
        const res = await fetch(j.url);
        if (!res.ok || !res.body) throw new Error('the index would not download (' + res.status + ')');
        const reader = res.body.getReader();
        const parts = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value); got += value.length;
          st.loading.set(slug, { got, total: meta.bytes || got });
          tell('progress', slug);
        }
        const buf = await new Blob(parts).arrayBuffer();
        rec = { wiki: slug, built: meta.built, at: Date.now(), gz: buf };
        keep(DBNAME, 'indexes', rec);
      }
      const data = await gunzipJson(rec.gz);
      const teams = new Map();
      data.docs.forEach((d) => {
        const [, school, team] = d[0].split('/');
        const k = school + '|' + team;
        if (!teams.has(k)) teams.set(k, { school, team, name: (data.schools[school] || school.replace(/([a-z])([A-Z])/g, '$1 $2')) + ' ' + team });
      });
      const ix = { meta, docs: data.docs, cards: data.cards, low: data.cards.map((c) => c[1].toLowerCase()), teams, ranks: {}, zip: data.zip };
      st.idx.set(slug, ix);
      st.loading.delete(slug);
      // where every team in it stands — one question for the whole wiki
      fetch('/api/tools/caselist?op=ranks', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wiki: slug, teams: [...teams.values()].map((t) => [t.school, t.team, data.schools[t.school] || t.school]) }),
      }).then(json).then((j) => { ix.ranks = j.ranks || {}; tell('ranks', slug); }).catch(() => { /* unranked, not broken */ });
      tell('index', slug);
      return ix;
    })().catch((e) => {
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

  const teamName = (slug, school, team) => ((st.idx.get(slug) && st.idx.get(slug).teams.get(school + '|' + team)) || {}).name || school + ' ' + team;

  /**
   * Every tag in these families' loaded indexes that has every word of `q`,
   * grouped by team, strongest team first; within a team, the tags that say it
   * most plainly, then the ones read in the most rounds.
   */
  function find(q, families) {
    const ts = String(q || '').toLowerCase().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const phrase = ts.join(' ');
    if (phrase.length < 2) return { groups: [], total: 0 };
    const byTeam = new Map();
    let total = 0;
    for (const [slug, ix] of st.idx) {
      if (!families.has(familyOf(slug))) continue;
      const { low, cards, docs } = ix;
      for (let i = 0; i < low.length; i++) {
        const t = low[i];
        let ok = true;
        for (let k = 0; k < ts.length; k++) if (t.indexOf(ts[k]) < 0) { ok = false; break; }
        if (!ok) continue;
        const c = cards[i];
        const path = docs[c[0]][0];
        const [, school, team] = path.split('/');
        const tk = slug + '|' + school + '|' + team;
        const score = 1 + (t.includes(phrase) ? 2 : 0) + (t.startsWith(phrase) ? 1 : 0) - Math.min(t.length, 300) / 1000;
        let g = byTeam.get(tk);
        if (!g) { g = { slug, school, team, cards: [] }; byTeam.set(tk, g); }
        g.cards.push({ id: slug + ':' + i, slug, ci: i, path, tag: c[1], cite: c[2], rounds: c[3] || 1, score });
        total++;
      }
    }
    const groups = [...byTeam.values()];
    groups.forEach((g) => { g.rank = st.idx.get(g.slug).ranks[g.school + '|' + g.team] || null; g.name = teamName(g.slug, g.school, g.team); });
    groups.sort((a, b) => (a.rank ? a.rank.rank : 1e6) - (b.rank ? b.rank.rank : 1e6) || b.cards.length - a.cards.length || a.team.localeCompare(b.team));
    groups.forEach((g) => g.cards.sort((x, y) => y.score - x.score || y.rounds - x.rounds));
    return { groups, total, terms: ts };
  }

  /** A card's body as HTML — its block heading, its tag, its paragraphs — kept once fetched. */
  async function cardHtml(card) {
    const ix = st.idx.get(card.slug);
    const d = ix.docs[ix.cards[card.ci][0]];
    const key = d[0] + '#' + norm(card.tag).slice(0, 80);
    const rec = await kept(DBNAME, 'docs', key);
    if (rec && rec.html && Date.now() - rec.at < DOC_LIFE) return rec.html;
    const u = '/api/tools/caselist?op=card&path=' + encodeURIComponent(d[0]) + '&zip=' + encodeURIComponent(ix.zip.url) +
      '&off=' + d[1] + '&len=' + d[2] + '&m=' + d[3] + '&nl=' + d[4] + '&tag=' + encodeURIComponent(card.tag);
    const r = await fetch(u);
    if (!r.ok) { const j = await json(r).catch((e) => ({ error: e.message })); throw new Error(j.error || 'the card would not open'); }
    const html = await r.text();
    keep(DBNAME, 'docs', { path: key, at: Date.now(), html }, 2000);
    return html;
  }

  const client = { st, metas, loadIndex, warm, find, cardHtml, teamName, on: (f) => { subs.add(f); return () => subs.delete(f); } };
  clients.set(DBNAME, client);
  return client;
}
