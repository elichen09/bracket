/**
 * Evidence's second source: this season's openCaselist wikis, searched by tag.
 *
 * Instant, because nothing is fetched while you search. Once a week every
 * disclosed document in a wiki is read into an index of its tags — Heading 4s
 * — with each card's cite and where its document sits in openCaselist's
 * weekly archive (scripts/caselist-index.mjs; the approach Logos takes). The
 * page downloads a wiki's index once, keeps it in this browser, and searches
 * it as you type. A card's body is fetched only when it is opened or sent —
 * the server reads its document out of the archive with one ranged request
 * and hands back just that card — and the card under the cursor is fetched
 * before it is asked for.
 *
 * Loading, searching and fetching are lib/caselist/client.js, which Flow's
 * command panel uses too; this is the drawing and the keys.
 *
 * The engine hands this module what it needs (the parser, the sender, a
 * toast) and routes the search box to it while it is on.
 */

import { caselistClient, ORDER, SHORT, familyOf, shortOf, norm, roundOf } from '../caselist/client';

const PAGE = 120;              // cards drawn at a time; "more" draws the next

export function mountCaselist(ctx) {
  const { $, esc, toast, scoped, owner } = ctx;
  const KEY_ON = scoped('evidence.src', owner);
  const KEY_WIKIS = scoped('caselist.wikis', owner);
  const CL = caselistClient(owner, scoped);

  const st = {
    on: false,
    get metas() { return CL.st.metas; },
    get idx() { return CL.st.idx; },
    get loading() { return CL.st.loading; },
    chosen: new Set(),         // families switched on: 'hspf', …
    q: '',
    list: [],                  // team rows and card rows, in order
    total: 0, teams: 0,
    shown: PAGE,
    sel: 0, moved: false,
    open: new Set(),
    bodies: new Map(),         // card id -> { block, arg } | { err }
    seen: new Set(),
  };
  let drawSoon = null, searchSoon = null, preSoon = null;

  try { st.on = localStorage.getItem(KEY_ON) === 'cl'; } catch { /* private browsing */ }
  try { JSON.parse(localStorage.getItem(KEY_WIKIS) || '["hspf"]').forEach((f) => st.chosen.add(f)); } catch { st.chosen.add('hspf'); }

  const bar = document.createElement('div');
  bar.className = 'clbar mono';
  bar.hidden = true;
  $('#results').before(bar);

  // the client says when an index moves; this redraws
  const unlisten = CL.on((what, detail) => {
    if (what === 'error') { if (st.on) toast(detail, true); paintBar(); return; }
    if (what === 'progress' || what === 'metas') { paintBar(); drawLater(); return; }
    search();
  });

  /* ---------------- chrome */
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

  // the day openCaselist made the archive the index was read from: "hspf26-all-2026-09-22.zip"
  const asOf = (m) => {
    const d = ((m.zip && m.zip.name) || '').match(/\d{4}-\d{2}-\d{2}/);
    return d ? d[0] + 'T12:00:00' : m.built;
  };
  const fmtN = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : n.toLocaleString());
  const day = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

  function paintBar() {
    if (!st.on) return;
    const metas = st.metas || [];
    const chips = ORDER.map((fam) => {
      const meta = metas.find((m) => familyOf(m.wiki) === fam);
      const slug = meta && meta.wiki;
      const ld = slug && st.loading.get(slug);
      let state = '';
      if (!meta) state = st.metas ? '<i class="clst none">—</i>' : '';
      else if (ld) state = '<i class="clst wait">' + (ld.total ? Math.round((ld.got / ld.total) * 100) + '%' : '…') + '</i>';
      else if (st.idx.has(slug)) state = '<i class="clst n">' + fmtN(meta.cards) + '</i>';
      const title = meta ? SHORT[fam] + ' — ' + meta.cards.toLocaleString() + ' tags from ' + meta.docs.toLocaleString() + ' docs, as of ' + day(asOf(meta)) : SHORT[fam] + ' — no index yet';
      return '<button type="button" class="clw' + (st.chosen.has(fam) ? ' on' : '') + (meta ? '' : ' off') + '" data-clwiki="' + fam + '" title="' + esc(title) + '">' + SHORT[fam] + state + '</button>';
    }).join('');
    const fresh = metas.filter((m) => st.chosen.has(familyOf(m.wiki))).map(asOf).sort()[0];
    bar.innerHTML = '<span class="clws">' + chips + '</span>' +
      (fresh ? '<span class="clfresh" title="Rebuilt every week from openCaselist\'s archive of every open-source doc">as of ' + day(fresh) + '</span>' : '');
  }

  function hint() {
    const m = $('#searchmeta');
    if (!m || !st.on) return;
    m.innerHTML = st.list.some((x) => x.card) ? '<kbd class="clkbd">Enter</kbd> send' : '';
  }

  /* ---------------- searching: every tag, in memory */
  const terms = () => st.q.toLowerCase().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

  function search() {
    if (!st.on) return;
    const keepId = st.moved ? st.list[st.sel]?.card?.id : null;
    st.shown = PAGE;
    const { groups, total } = CL.find(st.q, st.chosen);
    const list = [];
    groups.forEach((g) => {
      list.push({ team: g });
      g.cards.forEach((c) => list.push({ card: c, g }));
    });
    st.list = list; st.total = total; st.teams = groups.length;
    const at = keepId ? list.findIndex((x) => x.card && x.card.id === keepId) : -1;
    st.sel = at >= 0 ? at : Math.max(0, list.findIndex((x) => x.card));
    if (at < 0) st.moved = false;
    draw();
    prefetchSoon();
  }

  /* ---------------- a card's body, on demand */
  const waiting = new Map();
  function body(card) {
    const had = st.bodies.get(card.id);
    if (had) return Promise.resolve(had);
    if (waiting.has(card.id)) return waiting.get(card.id);
    const p = CL.cardHtml(card).then((html) => {
      const block = ctx.parseHtml(html).blocks.find((b) => (b.args || []).length);
      if (!block) throw new Error('that card came back empty');
      return { block: { id: block.id, title: block.title, trigger: block.trigger, head: block.head, pre: [], args: block.args }, arg: block.args[0] };
    }).catch((e) => ({ err: e.message }))
      .then((b) => { st.bodies.set(card.id, b); waiting.delete(card.id); drawLater(); return b; });
    waiting.set(card.id, p);
    return p;
  }

  /** The card under the cursor, and the ones either side of it, fetched before they are asked for. */
  function prefetchSoon() {
    clearTimeout(preSoon);
    preSoon = setTimeout(() => {
      const near = [];
      for (let i = st.sel; i < st.list.length && near.length < 3; i++) if (st.list[i].card) near.push(st.list[i].card);
      for (let i = st.sel - 1; i >= 0 && near.length < 4; i--) if (st.list[i].card) { near.push(st.list[i].card); break; }
      near.forEach((c) => body(c));
    }, 160);
  }

  /* ---------------- drawing */
  function marked(text) {
    let html = esc(text);
    const ts = terms().map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
    if (ts.length) html = html.replace(new RegExp('(' + ts.join('|') + ')', 'gi'), '<mark>$1</mark>');
    return html;
  }
  const ordinal = (n) => { const v = n % 100; return n + (v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'); };

  function drawLater() {
    if (drawSoon) return;
    drawSoon = setTimeout(() => { drawSoon = null; draw(); }, 60);
  }

  function draw() {
    if (!st.on) return;
    paintBar(); hint();
    const box = $('#results');
    const loadingAny = [...st.loading.values()];
    const phrase = terms().join(' ');

    if (!phrase || phrase.length < 2) {
      const ready = [...st.idx.keys()].filter((s) => st.chosen.has(familyOf(s)));
      const tags = ready.reduce((n, s) => n + st.idx.get(s).cards.length, 0);
      box.innerHTML = '<div class="blank clblank"><strong>Search the caselist</strong>' +
        '<p>Type what a tag says. Every Heading 4 disclosed on the wikis switched on above is searched as you type, strongest teams first.</p>' +
        (loadingAny.length ? '<p class="clsmall">Getting the index ready…</p>'
          : tags ? '<p class="clsmall">' + tags.toLocaleString() + ' tags ready.</p>' : '') + '</div>';
      return;
    }

    const cards = st.total;
    const head = '<div class="clhead' + (loadingAny.length ? ' busy' : '') + '">' +
      (loadingAny.length ? '<span class="clprog" style="--p:' + Math.round(100 * loadingAny.reduce((a, l) => a + (l.total ? l.got / l.total : 0), 0) / loadingAny.length) + '%"></span>' : '') +
      '<span class="clcount"><b>' + cards.toLocaleString() + '</b> tag' + (cards === 1 ? '' : 's') + (st.teams ? ' · ' + st.teams.toLocaleString() + ' team' + (st.teams === 1 ? '' : 's') : '') + '</span>' +
      (loadingAny.length ? '<span class="clnow">loading the index…</span>' : '') + '</div>';

    if (!cards) {
      box.innerHTML = head + (loadingAny.length ? '' : '<div class="blank clblank"><strong>No tag says “' + esc(phrase) + '”</strong><p>Try fewer words, or the words a tag would use.</p></div>');
      return;
    }

    let drawn = 0, cut = -1;
    const rows = [];
    for (let i = 0; i < st.list.length; i++) {
      const x = st.list[i];
      if (x.card && drawn >= st.shown && i > st.sel) { cut = i; break; }
      if (x.team) {
        const g = x.team, rk = g.rank;
        const chip = rk
          ? '<span class="clrk' + (rk.rank <= 25 ? ' top' : '') + '" title="' + esc(rk.code) + ' — ' + ordinal(rk.rank) + ' of ' + rk.of.toLocaleString() + ' in this site’s ' + esc(shortOf(g.slug)) + ' ratings · ' + rk.rating + '">#' + rk.rank + '</span>'
          : '<span class="clrk none" title="Not in this site’s ratings yet">—</span>';
        rows.push('<div class="clteam">' + chip + '<b>' + esc(g.name) + '</b>' +
          '<span class="clwk">' + esc(shortOf(g.slug)) + '</span><span class="cln">' + g.cards.length + '</span>' +
          '<a class="clwiki" href="https://opencaselist.com/' + esc(g.slug + '/' + g.school + '/' + g.team) + '" target="_blank" rel="noopener" title="Their page on openCaselist">wiki ↗</a></div>');
        continue;
      }
      drawn++;
      const c = x.card;
      const born = !st.seen.has(c.id);
      st.seen.add(c.id);
      const open = st.open.has(c.id);
      const b = st.bodies.get(c.id);
      let inner = '';
      if (open) {
        if (!b) inner = '<div class="clbody clwait"><i></i><i></i><i></i></div>';
        else if (b.err) inner = '<div class="clbody clerr">' + esc(b.err) + '</div>';
        else inner = '<div class="clbody">' + ctx.toHtml(b.arg.body || []) + '</div>';
        inner += '<div class="clacts"><button type="button" class="btn key" data-clsend="' + i + '">Send <kbd>Enter</kbd></button>' +
          '<a class="btn" href="https://opencaselist.com/' + esc(c.path.split('/').slice(0, 3).join('/')) + '" target="_blank" rel="noopener">On the wiki ↗</a></div>';
      }
      rows.push('<div class="clcard' + (i === st.sel ? ' sel' : '') + (born ? ' born' : '') + (open ? ' open' : '') + '" data-clcard="' + i + '">' +
        '<span class="chev"></span>' +
        '<span class="clmain"><span class="cltag">' + marked(c.tag) + '</span>' +
        (c.cite ? '<span class="clcite">' + esc(c.cite.slice(0, 180)) + '</span>' : '') +
        '<span class="clsrc">' + esc(roundOf(c.path)) + (c.rounds > 1 ? '<em class="clrounds" title="Read in ' + c.rounds + ' disclosed rounds">' + c.rounds + ' rounds</em>' : '') + '</span></span>' +
        inner + '</div>');
    }
    if (cut >= 0) {
      const left = st.list.slice(cut).filter((x) => x.card).length;
      rows.push('<button type="button" class="clmore" data-clmore>Show ' + Math.min(left, PAGE) + ' more of ' + left.toLocaleString() + '</button>');
    }
    box.innerHTML = head + rows.join('');
    const s = box.querySelector('.clcard.sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------- acting */
  function move(d) {
    let i = st.sel;
    do { i += d; } while (i >= 0 && i < st.list.length && !st.list[i].card);
    if (i < 0 || i >= st.list.length) return;
    st.sel = i; st.moved = true;
    const drawnCards = st.list.slice(0, i + 1).filter((x) => x.card).length;
    if (drawnCards > st.shown) st.shown += PAGE;
    draw(); prefetchSoon();
  }
  function toggle(i, want) {
    const x = st.list[i];
    if (!x || !x.card) return;
    st.moved = true;
    const open = want === undefined ? !st.open.has(x.card.id) : want;
    if (open) { st.open.add(x.card.id); body(x.card); } else st.open.delete(x.card.id);
    draw();
  }
  async function send(i) {
    const x = st.list[i];
    if (!x || !x.card) return;
    const c = x.card;
    const b = await body(c);
    if (b.err) return toast(b.err, true);
    const [, school, team] = c.path.split('/');
    // one card, under its block's heading, as the library would send it;
    // the block's id is its document and heading, so a second card from it joins the first
    await ctx.send({ ...b.block, id: 'cl_' + c.path + '#' + norm(b.block.title), args: [b.arg] }, 0, 'from ' + CL.teamName(c.slug, school, team));
  }

  function key(ev) {
    if (!st.on) return false;
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); move(1); return true;
      case 'ArrowUp': ev.preventDefault(); move(-1); return true;
      case 'ArrowRight': if (ev.target.selectionStart === ev.target.value.length) { ev.preventDefault(); toggle(st.sel, true); } return true;
      case 'ArrowLeft': if (ev.target.selectionStart === 0) { ev.preventDefault(); toggle(st.sel, false); } return true;
      case 'Tab': ev.preventDefault(); toggle(st.sel); return true;
      case 'Enter': ev.preventDefault(); send(st.sel); return true;
      case 'Escape': ev.preventDefault(); ev.target.value = ''; input(''); return true;
      default: return false;
    }
  }

  function input(v) {
    st.q = v;
    clearTimeout(searchSoon);
    searchSoon = setTimeout(search, 40);
  }

  function onClick(ev) {
    const src = ev.target.closest('#srcsw [data-src]');
    if (src) { const want = src.dataset.src === 'cl'; if (want !== st.on) setOn(want); return; }
    if (!st.on) return;
    const w = ev.target.closest('[data-clwiki]');
    if (w) {
      const fam = w.dataset.clwiki;
      if (st.chosen.has(fam)) st.chosen.delete(fam); else st.chosen.add(fam);
      try { localStorage.setItem(KEY_WIKIS, JSON.stringify([...st.chosen])); } catch { /* fine */ }
      const meta = (st.metas || []).find((m) => familyOf(m.wiki) === fam);
      if (st.chosen.has(fam) && meta) CL.loadIndex(meta.wiki);
      search();
      return;
    }
    if (ev.target.closest('[data-clmore]')) { st.shown += PAGE; draw(); return; }
    const sb = ev.target.closest('[data-clsend]');
    if (sb) { send(+sb.dataset.clsend); return; }
    if (ev.target.closest('a')) return;
    const card = ev.target.closest('[data-clcard]');
    if (card) {
      const i = +card.dataset.clcard;
      if (ev.target.closest('.clbody')) return;
      if (st.sel === i) toggle(i); else { st.sel = i; st.moved = true; draw(); prefetchSoon(); }
      $('#q').focus({ preventScroll: true });
    }
  }
  ctx.root.addEventListener('click', onClick);   // the bar is inside root: one listener sees both

  function setOn(on) {
    st.on = on;
    try { localStorage.setItem(KEY_ON, on ? 'cl' : 'lib'); } catch { /* fine */ }
    paintSwitch();
    const q = $('#q');
    if (on) { ctx.caselist(); st.q = q.value; CL.warm(st.chosen); search(); }
    else ctx.library();
    q.focus();
  }

  paintSwitch();
  if (st.on) { CL.warm(st.chosen); st.q = ($('#q') || {}).value || ''; draw(); }

  return {
    get on() { return st.on; },
    state: st,                 // for the console and the tests, as EV.caselist
    setOn, key, input, draw,
    destroy() {
      clearTimeout(drawSoon); clearTimeout(searchSoon); clearTimeout(preSoon);
      unlisten();
      ctx.root.removeEventListener('click', onClick);
      bar.remove();
    },
  };
}
