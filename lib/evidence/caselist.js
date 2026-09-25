/**
 * Evidence's second source: this season's openCaselist wikis, searched by tag.
 *
 * The caselist's own search is full text over whole disclosed documents, and
 * it allows four searches a minute. So it is used for what it is good at —
 * finding which documents mention the words — and the cards are found here:
 * each .docx it names is read the way the library reads a paste, and the
 * cards kept are the ones whose TAG (Heading 4) says what was searched for.
 * A document that only mentions the words in a card's text is left out.
 *
 * Teams come in the order this site rates them, strongest first, and a team's
 * cards stay together under its name. Documents are read strongest team
 * first too, so the top of the list fills in before the bottom.
 *
 * The API rations both halves: four searches a minute, and ten downloads.
 * Both budgets are shown, not discovered — a meter of four marks that empty as
 * searches go out and refill a minute later, and a count of documents still to
 * read with when the next ten can come — and whatever has run out waits its
 * turn instead of failing. Asking a question already asked costs nothing (the
 * answer is kept here and on the server), and a document read once is kept in
 * this browser for a month: a disclosed round does not change.
 *
 * Ten documents a minute makes the order they are read in matter. Teams
 * disclose the same case round after round, so each team's first document on
 * each side is read first, strongest team first; the rest follow, and their
 * repeats of cards already found fold into the ones on screen.
 *
 * The engine hands this module what it needs (the parser, the sender, a
 * toast) and routes the search box to it while it is on.
 */

import { docxToHtml } from '../caselist/docx';

const PER_MINUTE = 4;
const MINUTE = 60_000;
const SEARCH_LIFE = 15 * 60_000;
const DOC_LIFE = 30 * 864e5;
const DL_PER_MINUTE = 10;
const ORDER = ['hspf', 'hsld', 'hspolicy', 'ndtceda'];
const SHORT = { hspf: 'PF', hsld: 'LD', hspolicy: 'Policy', ndtceda: 'NDT-CEDA' };
const familyOf = (slug) => ORDER.find((f) => slug.startsWith(f)) || slug;
const shortOf = (slug) => SHORT[familyOf(slug)] || slug;

/* ------------------------------------------------------------ documents, kept */

const dbs = new Map();
function docDb(name) {
  if (!dbs.has(name)) {
    dbs.set(name, new Promise((res, rej) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'path' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  }
  return dbs.get(name);
}
async function keptDoc(name, path) {
  try {
    const db = await docDb(name);
    const rec = await new Promise((res) => {
      const q = db.transaction('docs').objectStore('docs').get(path);
      q.onsuccess = () => res(q.result || null); q.onerror = () => res(null);
    });
    return rec && Date.now() - rec.at < DOC_LIFE ? rec.blocks : null;
  } catch { return null; }
}
async function keepDoc(name, path, blocks) {
  try {
    const db = await docDb(name);
    const t = db.transaction('docs', 'readwrite');
    const s = t.objectStore('docs');
    s.put({ path, at: Date.now(), blocks });
    // a few hundred documents is plenty; the oldest go first
    const all = s.getAll();
    all.onsuccess = () => {
      const list = all.result || [];
      if (list.length > 250) list.sort((a, b) => a.at - b.at).slice(0, list.length - 250).forEach((x) => s.delete(x.path));
    };
  } catch { /* not kept; read again next time */ }
}

/* ------------------------------------------------------------ the module */

export function mountCaselist(ctx) {
  const { $, esc, toast, scoped, owner } = ctx;
  const KEY_ON = scoped('evidence.src', owner);
  const KEY_WIKIS = scoped('caselist.wikis', owner);
  const KEY_USED = scoped('caselist.used', owner);
  const KEY_DL = scoped('caselist.dl', owner);
  const DBNAME = scoped('caselist', owner);

  const st = {
    on: false,
    wikis: [],                 // this season's, from the server
    chosen: new Set(),         // families switched on: 'hspf', …
    q: '',                     // what the box says
    ran: '',                   // what was last searched
    runs: new Map(),           // slug -> { state, hits, ranks, err, eta }
    docs: new Map(),           // path -> { state, cards }
    teams: new Map(),          // school|team -> { hit, rank }
    list: [],                  // the cards, in order, with team rows between
    sel: 0,
    open: new Set(),           // cards shown in full
    seen: new Set(),           // cards already drawn once, so only new ones arrive
    blocked: 0,                // the API said wait until then (searches)
    dlBlocked: 0,              // likewise, downloads
    moved: false,              // the selection was put somewhere by hand
  };
  const memo = new Map();      // slug|q -> { at, hits, ranks }
  let queue = [];              // slugs waiting for a search
  let reading = [];            // docs waiting to be read
  let busyRead = 0;
  let tick = null, drawSoon = null, readTick = null, generation = 0;

  try { st.on = localStorage.getItem(KEY_ON) === 'cl'; } catch { /* private browsing */ }
  try { JSON.parse(localStorage.getItem(KEY_WIKIS) || '["hspf"]').forEach((f) => st.chosen.add(f)); } catch { st.chosen.add('hspf'); }

  /* ---------------- the budgets: so many a minute, shared by every tab */
  const stamps = (key) => {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(key) || '[]'); } catch { /* none */ }
    return list.filter((t) => Date.now() - t < MINUTE);
  };
  const stamp = (key) => { const u = stamps(key); u.push(Date.now()); try { localStorage.setItem(key, JSON.stringify(u)); } catch { /* fine */ } return u[u.length - 1]; };
  const unstamp = (key, t) => { try { localStorage.setItem(key, JSON.stringify(stamps(key).filter((x) => x !== t))); } catch { /* fine */ } };
  const room = (key, per, blocked) => (Date.now() < blocked ? 0 : Math.max(0, per - stamps(key).length));
  const freesAt = (key, per, blocked) => {
    if (Date.now() < blocked) return blocked;
    const u = stamps(key).sort((a, b) => a - b);
    return u.length >= per ? u[u.length - per] + MINUTE : Date.now();
  };
  const used = () => stamps(KEY_USED);
  const spend = () => stamp(KEY_USED);
  const refund = (t) => unstamp(KEY_USED, t);
  const left = () => room(KEY_USED, PER_MINUTE, st.blocked);
  const nextAt = () => freesAt(KEY_USED, PER_MINUTE, st.blocked);
  const dlLeft = () => room(KEY_DL, DL_PER_MINUTE, st.dlBlocked);
  const dlNextAt = () => freesAt(KEY_DL, DL_PER_MINUTE, st.dlBlocked);

  /* ---------------- chrome: the switch, the wiki chips, the meter */
  const bar = document.createElement('div');
  bar.className = 'clbar mono';
  bar.hidden = true;
  $('#results').before(bar);

  function paintSwitch() {
    ctx.root.classList.toggle('cl', st.on);
    ctx.root.querySelectorAll('#srcsw [data-src]').forEach((b) => {
      const on = (b.dataset.src === 'cl') === st.on;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    bar.hidden = !st.on;
    const q = $('#q');
    if (q) q.placeholder = st.on ? 'search caselist tags' : 'search evidence';
  }

  function paintBar() {
    if (!st.on) return;
    const fams = st.wikis.length ? st.wikis.map((w) => w.slug) : ORDER.map((f) => f);
    const chips = fams.map((slug) => {
      const fam = familyOf(slug);
      const run = st.runs.get(slug);
      let state = '';
      if (run) {
        if (run.state === 'queued') state = '<i class="clst wait">' + Math.max(1, Math.ceil((nextAt() - Date.now()) / 1000)) + 's</i>';
        else if (run.state === 'searching') state = '<i class="clst spin"></i>';
        else if (run.state === 'done') state = '<i class="clst n">' + run.files + '</i>';
        else if (run.state === 'error') state = '<i class="clst err">!</i>';
      }
      return '<button type="button" class="clw' + (st.chosen.has(fam) ? ' on' : '') + '" data-clwiki="' + esc(fam) + '" title="' +
        esc((st.wikis.find((w) => w.slug === slug) || {}).name || slug) + '">' + esc(shortOf(slug)) + state + '</button>';
    }).join('');
    const u = used(), now = Date.now();
    const pips = [];
    for (let i = 0; i < PER_MINUTE; i++) {
      const t = u[i];
      if (now < st.blocked) pips.push('<i class="pip used" style="--d:' + (st.blocked - now) + 'ms;--e:0ms"></i>');
      else if (t) pips.push('<i class="pip used" style="--d:' + MINUTE + 'ms;--e:-' + (now - t) + 'ms"></i>');
      else pips.push('<i class="pip"></i>');
    }
    const meter = '<span class="clmeter" title="openCaselist allows four searches a minute. Each wiki is one search; a search asked before is free.">' +
      pips.join('') + '<b>' + left() + '</b></span>';
    bar.innerHTML = '<span class="clws">' + chips + '</span>' + meter;
  }

  /* ---------------- searching */
  function hint() {
    const m = $('#searchmeta');
    if (!m || !st.on) return;
    const dirty = st.q.trim() && st.q.trim().toLowerCase() !== st.ran.toLowerCase();
    m.innerHTML = dirty ? '<kbd class="clkbd">Enter</kbd> search' : (st.list.some((x) => x.card) ? '<kbd class="clkbd">Enter</kbd> send' : '');
  }

  function wanted() {
    const fams = [...st.chosen];
    const known = st.wikis.map((w) => w.slug);
    return fams.map((f) => known.find((s) => s.startsWith(f))).filter(Boolean)
      .sort((a, b) => ORDER.indexOf(familyOf(a)) - ORDER.indexOf(familyOf(b)));
  }

  async function loadWikis() {
    if (st.wikis.length) return;
    try {
      const r = await fetch('/api/tools/caselist?op=wikis', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'openCaselist said ' + r.status);
      st.wikis = j.wikis.sort((a, b) => ORDER.indexOf(familyOf(a.slug)) - ORDER.indexOf(familyOf(b.slug)));
    } catch (e) { toast('Caselist: ' + e.message, true); }
    paintBar();
  }

  async function run() {
    const q = st.q.replace(/\s+/g, ' ').trim();
    if (q.length < 2) return toast('Search for at least two letters');
    await loadWikis();
    const slugs = wanted();
    if (!slugs.length) return toast('Switch a wiki on first');
    generation++;
    st.ran = q;
    st.runs = new Map(); st.docs = new Map(); st.teams = new Map();
    st.list = []; st.sel = 0; st.open = new Set(); st.seen = new Set(); st.moved = false;
    queue = []; reading = []; clearTimeout(readTick);
    slugs.forEach((s) => { st.runs.set(s, { state: 'queued' }); queue.push(s); });
    draw(); pump();
  }

  /** Add a wiki to the search already on screen. */
  function runOne(slug) {
    if (!st.ran || st.runs.has(slug)) return;
    st.runs.set(slug, { state: 'queued' });
    queue.push(slug);
    pump();
  }

  function pump() {
    clearTimeout(tick);
    if (!queue.length) { paintBar(); return; }
    const slug = queue[0];
    const key = slug + '|' + st.ran.toLowerCase();
    const m = memo.get(key);
    if (m && Date.now() - m.at < SEARCH_LIFE) { queue.shift(); arrive(slug, m.hits, m.ranks); return pump(); }
    if (left() <= 0) {
      paintBar();
      tick = setTimeout(pump, Math.min(1000, Math.max(120, nextAt() - Date.now())));
      return;
    }
    queue.shift();
    search(slug, key, generation);
    pump();
  }

  async function search(slug, key, gen) {
    const run = st.runs.get(slug);
    run.state = 'searching'; paintBar();
    const spent = spend();
    try {
      const r = await fetch('/api/tools/caselist?op=search&wiki=' + encodeURIComponent(slug) + '&q=' + encodeURIComponent(st.ran), { cache: 'no-store' });
      const j = await r.json();
      if (gen !== generation) return;
      if (r.status === 429) {
        // someone else spent the minute (another tab, the caselist site itself): wait it out
        st.blocked = Date.now() + MINUTE;
        run.state = 'queued'; queue.unshift(slug);
        return pump();
      }
      if (!r.ok) throw new Error(j.error || 'openCaselist said ' + r.status);
      if (j.cached) refund(spent);
      memo.set(key, { at: Date.now(), hits: j.hits, ranks: j.ranks || {} });
      arrive(slug, j.hits, j.ranks || {});
    } catch (e) {
      if (gen !== generation) return;
      run.state = 'error'; run.err = e.message;
      toast('Caselist ' + shortOf(slug) + ': ' + e.message, true);
      draw();
    }
    paintBar();
  }

  /** A wiki's answer: its teams placed, its documents queued, strongest team first. */
  function arrive(slug, hits, ranks) {
    const run = st.runs.get(slug);
    if (!run) return;
    const files = hits.filter((h) => h.type === 'file' && h.file && /\.docx$/i.test(h.file));
    run.state = 'done'; run.hits = hits; run.files = files.length;
    const firsts = new Set();
    files.forEach((h, order) => {
      const tk = h.school + '|' + h.team;
      if (!st.teams.has(tk)) st.teams.set(tk, { hit: h, wiki: slug, rank: ranks[tk] || null });
      if (st.docs.has(h.file)) return;
      // a team's first document on each side is the one worth a download first
      const side = tk + '|' + (sideOf(h) || '?');
      const first = !firsts.has(side);
      firsts.add(side);
      st.docs.set(h.file, { state: 'wait', hit: h, order, first });
    });
    draw();
    const gen = generation;
    // what this browser has read before costs nothing and comes straight in
    Promise.all(files.map(async (h) => {
      const d = st.docs.get(h.file);
      if (!d || d.state !== 'wait' || d.checked) return;
      d.checked = true;
      const blocks = await keptDoc(DBNAME, h.file);
      if (gen !== generation) return;
      if (blocks) { d.blocks = blocks; d.state = 'done'; d.kept = true; }
      else reading.push(h.file);
    })).then(() => {
      if (gen !== generation) return;
      const w = (p) => { const d = st.docs.get(p); return (d.first ? 0 : 1e7) + teamWeight(d.hit) * 100 + d.order; };
      reading.sort((a, b) => w(a) - w(b));
      draw();
      read();
    });
  }

  const sideOf = (h) => ((h.title || h.file || '').match(/-(aff|neg|pro|con)-/i) || [])[1]?.toLowerCase() || '';

  const teamWeight = (h) => {
    const t = st.teams.get(h.school + '|' + h.team);
    return t && t.rank ? t.rank.rank : 1e6;
  };

  /* ---------------- reading documents into cards */
  function read() {
    clearTimeout(readTick);
    while (busyRead < 2 && reading.length) {
      if (dlLeft() <= 0) {
        // out of downloads for this minute: come back when one frees up
        readTick = setTimeout(read, Math.max(250, dlNextAt() - Date.now()));
        drawLater();
        return;
      }
      const path = reading.shift();
      stamp(KEY_DL);               // claimed now, before the next turn of the loop looks
      busyRead++;
      readDoc(path, generation).finally(() => { busyRead--; read(); });
    }
  }

  async function readDoc(path, gen) {
    const d = st.docs.get(path);
    if (!d) return;
    d.state = 'reading';
    drawLater();
    try {
      let blocks = await keptDoc(DBNAME, path);
      if (!blocks) {
        const r = await fetch('/api/tools/caselist?op=file&path=' + encodeURIComponent(path));
        if (r.status === 429) {
          // spent elsewhere — another tab, or the caselist site itself: back in line, after the minute
          st.dlBlocked = Date.now() + MINUTE;
          if (gen === generation) { d.state = 'wait'; reading.unshift(path); }
          return;
        }
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'download failed'); }
        const blob = await r.blob();
        // laid out one at a time, and after a breath, so typing never stutters
        await new Promise((res) => setTimeout(res, 0));
        const html = await docxToHtml(blob);
        blocks = ctx.parseHtml(html).blocks.map((b) => ({ id: b.id, title: b.title, trigger: b.trigger, head: b.head, pre: [], args: b.args }));
        keepDoc(DBNAME, path, blocks);
      }
      if (gen !== generation) return;
      d.blocks = blocks;
      d.state = 'done';
    } catch (e) {
      if (gen !== generation) return;
      d.state = 'error'; d.err = e.message;
    }
    drawLater();
  }

  /* ---------------- which cards, in what order */
  const terms = () => st.ran.toLowerCase().split(/\s+/).filter(Boolean);

  function match(tag) {
    const t = tag.toLowerCase();
    const ts = terms();
    if (!ts.length || !ts.every((x) => t.includes(x))) return 0;
    const phrase = st.ran.toLowerCase();
    return 1 + (t.includes(phrase) ? 2 : 0) + (t.startsWith(phrase) ? 1 : 0) - Math.min(t.length, 300) / 1000;
  }

  function build() {
    const byTeam = new Map();
    for (const [path, d] of st.docs) {
      if (d.state !== 'done') continue;
      d.blocks.forEach((b, bi) => (b.args || []).forEach((a, ai) => {
        const score = match(a.title || '');
        if (!score) return;
        const tk = d.hit.school + '|' + d.hit.team;
        const list = byTeam.get(tk) || [];
        list.push({ id: path + '#' + bi + '.' + ai, path, bi, ai, block: b, arg: a, score, order: d.order, hit: d.hit });
        byTeam.set(tk, list);
      }));
    }
    const teams = [...byTeam.keys()].sort((a, b) => {
      const ra = st.teams.get(a)?.rank?.rank || 1e6, rb = st.teams.get(b)?.rank?.rank || 1e6;
      return ra - rb || byTeam.get(b).length - byTeam.get(a).length || a.localeCompare(b);
    });
    const list = [];
    teams.forEach((tk) => {
      const t = st.teams.get(tk);
      list.push({ team: tk, t, n: byTeam.get(tk).length });
      // the same card disclosed in several rounds is one card
      const seen = new Set();
      byTeam.get(tk).sort((x, y) => y.score - x.score || x.order - y.order || x.bi - y.bi || x.ai - y.ai).forEach((c) => {
        const sig = (c.arg.title || '').toLowerCase().replace(/\W+/g, '') + '|' + citeOf(c.arg).slice(0, 60);
        if (seen.has(sig)) return;
        seen.add(sig);
        list.push({ card: c });
      });
    });
    const keep = st.moved ? st.list.find((x, i) => i === st.sel && x.card)?.card.id : null;
    st.list = list;
    // the top card until one is chosen by hand, so a better team arriving takes the lead
    const at = keep ? list.findIndex((x) => x.card && x.card.id === keep) : -1;
    st.sel = at >= 0 ? at : Math.max(0, list.findIndex((x) => x.card));
  }

  /* ---------------- drawing */
  const runsText = (e) => (e && e.runs ? e.runs.map((r) => r.t).join('') : '');
  function citeOf(arg) {
    const first = (arg.body || []).find((e) => runsText(e).trim());
    return first ? runsText(first).replace(/\s+/g, ' ').trim() : '';
  }
  function roundOf(h) {
    const base = (h.title || h.file || '').replace(/\.[a-z]+$/i, '').split('/').pop();
    const rest = base.replace(new RegExp('^' + (h.school || '').replace(/\W/g, '\\W?') + '-' + (h.team || '') + '-?', 'i'), '');
    const words = rest.split(/-+/).filter(Boolean);
    const si = words.findIndex((w) => /^(aff|neg|pro|con)$/i.test(w));
    const side = si >= 0 ? words[si] : '';
    // "Pro-01---Opener-Round-1": the number straight after the side is only the file's order
    const after = words.slice(si + 1);
    if (after.length && /^\d{1,2}\.?$/.test(after[0])) after.shift();
    const what = (si >= 0 ? after : words).join(' ');
    return [side, what].filter(Boolean).join(' · ');
  }
  function marked(text) {
    let html = esc(text);
    const ts = terms().map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
    if (ts.length) html = html.replace(new RegExp('(' + ts.join('|') + ')', 'gi'), '<mark>$1</mark>');
    return html;
  }
  const wikiUrl = (h) => 'https://opencaselist.com/' + h.path.split('#')[0];

  function drawLater() {
    if (drawSoon) return;
    drawSoon = setTimeout(() => { drawSoon = null; draw(); }, 90);
  }

  function draw() {
    if (!st.on) return;
    paintBar(); hint();
    const box = $('#results');
    if (!st.ran) {
      box.innerHTML = '<div class="blank clblank"><strong>Search the caselist</strong>' +
        '<p>Type what a tag says and press <b>Enter</b>. Cards come out of this season’s disclosed docs, ' +
        'strongest teams first, ready to send.</p>' +
        '<p class="clsmall">openCaselist allows four searches a minute. Each wiki switched on is one — the meter above shows what is left.</p></div>';
      return;
    }
    build();
    const docs = [...st.docs.values()];
    const read = docs.filter((d) => d.state === 'done').length;
    const failed = docs.filter((d) => d.state === 'error').length;
    const settled = read + failed;
    const searching = [...st.runs.values()].some((r) => r.state === 'queued' || r.state === 'searching');
    const cards = st.list.filter((x) => x.card).length;
    const teams = st.list.filter((x) => x.team).length;
    const busy = searching || settled < docs.length;
    const pct = docs.length ? Math.round((settled / docs.length) * 100) : (searching ? 4 : 100);
    const waiting = !searching && settled < docs.length && !docs.some((d) => d.state === 'reading') && dlLeft() <= 0;
    const secs = Math.max(1, Math.ceil((dlNextAt() - Date.now()) / 1000));
    let now;
    if (searching) now = 'searching…';
    else if (waiting) now = read + ' of ' + docs.length + ' docs · next in <b class="clsec">' + secs + 's</b>';
    else if (settled < docs.length) now = 'reading ' + read + ' of ' + docs.length + ' docs';
    else now = read + ' docs read' + (failed ? ' · ' + failed + ' would not open' : '');

    let head = '<div class="clhead' + (busy ? ' busy' : '') + (waiting ? ' waiting' : '') + '"><span class="clprog" style="--p:' + pct + '%"></span>' +
      '<span class="clcount"><b>' + cards + '</b> card' + (cards === 1 ? '' : 's') + (teams ? ' · ' + teams + ' team' + (teams === 1 ? '' : 's') : '') + '</span>' +
      '<span class="clnow" title="openCaselist allows ten downloads a minute; a doc read before opens from this browser">' + now + '</span></div>';

    if (!cards && !busy) {
      const mention = docs.length;
      box.innerHTML = head + '<div class="blank clblank"><strong>No tag says “' + esc(st.ran) + '”</strong>' +
        '<p>' + (mention ? mention + ' disclosed doc' + (mention === 1 ? '' : 's') + ' mention it in card text, but no Heading 4 does. Try the words a tag would use.' : 'Nothing on these wikis mentions it yet.') + '</p></div>';
      return;
    }

    const rows = st.list.map((x, i) => {
      if (x.team) {
        const h = x.t.hit, rk = x.t.rank;
        const chip = rk
          ? '<span class="clrk' + (rk.rank <= 25 ? ' top' : '') + '" title="' + esc(rk.code) + ' — ' + ordinal(rk.rank) + ' of ' + rk.of.toLocaleString() + ' in this site’s ' + esc(shortOf(x.t.wiki)) + ' ratings · ' + rk.rating + '">#' + rk.rank + '</span>'
          : '<span class="clrk none" title="Not in this site’s ratings yet">—</span>';
        return '<div class="clteam">' + chip + '<b>' + esc(h.teamName || h.schoolName + ' ' + h.team) + '</b>' +
          '<span class="clwk">' + esc(shortOf(x.t.wiki)) + '</span><span class="cln">' + x.n + '</span>' +
          '<a class="clwiki" href="' + esc(wikiUrl(h)) + '" target="_blank" rel="noopener" title="Their page on openCaselist">wiki ↗</a></div>';
      }
      const c = x.card;
      const born = !st.seen.has(c.id);
      st.seen.add(c.id);
      const open = st.open.has(c.id);
      const cite = citeOf(c.arg);
      return '<div class="clcard' + (i === st.sel ? ' sel' : '') + (born ? ' born' : '') + (open ? ' open' : '') + '" data-clcard="' + i + '">' +
        '<span class="chev"></span>' +
        '<span class="clmain"><span class="cltag">' + marked(c.arg.title || '(untitled)') + '</span>' +
        (cite ? '<span class="clcite">' + esc(cite.slice(0, 160)) + '</span>' : '') +
        '<span class="clsrc">' + esc(roundOf(c.hit)) + '</span></span>' +
        (open ? '<div class="clbody">' + ctx.toHtml(c.arg.body || []) + '</div>' +
          '<div class="clacts"><button type="button" class="btn key" data-clsend="' + i + '">Send <kbd>Enter</kbd></button>' +
          '<a class="btn" href="' + esc(wikiUrl(c.hit)) + '" target="_blank" rel="noopener">On the wiki ↗</a></div>' : '') +
        '</div>';
    }).join('');
    box.innerHTML = head + rows;
    const s = box.querySelector('.clcard.sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
  }

  const ordinal = (n) => {
    const v = n % 100;
    return n + (v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  };

  /* ---------------- acting */
  function move(d) {
    if (!st.list.length) return;
    let i = st.sel;
    do { i += d; } while (i >= 0 && i < st.list.length && !st.list[i].card);
    if (i < 0 || i >= st.list.length) return;
    st.sel = i; st.moved = true;
    draw();
  }
  function toggle(i, want) {
    const x = st.list[i];
    if (!x || !x.card) return;
    const id = x.card.id;
    st.moved = true;
    const open = want === undefined ? !st.open.has(id) : want;
    if (open) st.open.add(id); else st.open.delete(id);
    draw();
  }
  async function send(i) {
    const x = st.list[i];
    if (!x || !x.card) return;
    const c = x.card;
    // one card, under its block's heading, as the library would send it
    const block = { ...c.block, id: 'cl_' + c.id, args: [c.arg] };
    await ctx.send(block, 0, 'from ' + (c.hit.teamName || c.hit.team));
  }

  function key(ev) {
    if (!st.on) return false;
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); move(1); return true;
      case 'ArrowUp': ev.preventDefault(); move(-1); return true;
      case 'ArrowRight': if (ev.target.selectionStart === ev.target.value.length) { ev.preventDefault(); toggle(st.sel, true); } return true;
      case 'ArrowLeft': if (ev.target.selectionStart === 0) { ev.preventDefault(); toggle(st.sel, false); } return true;
      case 'Tab': ev.preventDefault(); toggle(st.sel); return true;
      case 'Enter': {
        ev.preventDefault();
        const dirty = st.q.trim().toLowerCase() !== st.ran.toLowerCase();
        if (dirty || !st.list.some((x) => x.card)) run(); else send(st.sel);
        return true;
      }
      case 'Escape':
        ev.preventDefault();
        ev.target.value = ''; st.q = ''; st.ran = ''; generation++; queue = []; reading = []; clearTimeout(readTick);
        st.runs = new Map(); st.docs = new Map(); st.list = [];
        draw(); return true;
      default: return false;
    }
  }

  function input(v) { st.q = v; hint(); }

  function onClick(ev) {
    const src = ev.target.closest('#srcsw [data-src]');
    if (src) { const want = src.dataset.src === 'cl'; if (want !== st.on) setOn(want); return; }
    if (!st.on) return;
    const w = ev.target.closest('[data-clwiki]');
    if (w) {
      const fam = w.dataset.clwiki;
      if (st.chosen.has(fam)) st.chosen.delete(fam); else st.chosen.add(fam);
      try { localStorage.setItem(KEY_WIKIS, JSON.stringify([...st.chosen])); } catch { /* fine */ }
      if (st.chosen.has(fam)) { const slug = wanted().find((s) => familyOf(s) === fam); if (slug) runOne(slug); }
      paintBar();
      return;
    }
    const sb = ev.target.closest('[data-clsend]');
    if (sb) { send(+sb.dataset.clsend); return; }
    if (ev.target.closest('a')) return;
    const card = ev.target.closest('[data-clcard]');
    if (card) {
      const i = +card.dataset.clcard;
      if (ev.target.closest('.clbody')) return;         // reading, or selecting text
      if (st.sel === i) toggle(i); else { st.sel = i; st.moved = true; draw(); }
      $('#q').focus({ preventScroll: true });
    }
  }
  ctx.root.addEventListener('click', onClick);   // the bar is inside root: one listener sees both
  const meterTick = setInterval(() => {
    if (!st.on) return;
    if (queue.length || used().length) paintBar();
    if (reading.length && dlLeft() <= 0) draw();
  }, 1000);

  function setOn(on) {
    st.on = on;
    try { localStorage.setItem(KEY_ON, on ? 'cl' : 'lib'); } catch { /* fine */ }
    paintSwitch();
    const q = $('#q');
    if (on) { ctx.caselist(); st.q = q.value; loadWikis(); draw(); }
    else ctx.library();
    q.focus();
  }

  paintSwitch();
  if (st.on) { loadWikis(); draw(); }

  return {
    get on() { return st.on; },
    state: st,                 // for the console and the tests, as EV.caselist
    setOn, key, input, draw,
    destroy() {
      clearTimeout(tick); clearTimeout(drawSoon); clearTimeout(readTick); clearInterval(meterTick);
      ctx.root.removeEventListener('click', onClick);
      bar.remove();
    },
  };
}
