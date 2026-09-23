/**
 * Evidence — the engine.
 *
 * This began as a single HTML file kept on a laptop and opened from the
 * desktop at tournaments. That is still exactly what it does; what changed is
 * where it lives. It now mounts inside a page of the site, so every lookup is
 * scoped to the element it was given rather than to the document, every
 * listener it adds can be taken back when the page unmounts, and the theme is
 * the site's rather than its own.
 *
 * Nothing here talks to a server. The library is IndexedDB in the browser
 * being used, the clipboard is the transport, and a tournament with no wifi
 * changes nothing.
 */

/** The element this instance owns. Every selector is relative to it. */
let root = null;

/** A first-run prompt that must not arrive after the page has gone. */
let openTimer = null;

/* ====================================================================
   0. Tiny helpers
   ==================================================================== */

const $ = (s, r) => (r || root).querySelector(s);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function hash(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

const uid = (p) => (p || 'id') + '_' + Math.random().toString(36).slice(2, 10);

function toHex(c) {
  if (!c) return null;
  const s = String(c).trim().toLowerCase();
  if (s === 'transparent' || s === 'inherit' || s === 'initial') return null;
  let m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    if (p.length > 3 && p[3] === 0) return null;
    const f = (v) => ('0' + Math.round(v).toString(16)).slice(-2);
    return '#' + f(p[0]) + f(p[1]) + f(p[2]);
  }
  if (s[0] === '#') {
    if (s.length === 4) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return s.slice(0, 7);
  }
  const named = { white: '#ffffff', black: '#000000', yellow: '#ffff00' };
  return named[s] || null;
}

const isHighlight = (hex) => !!hex && hex !== '#ffffff' && hex !== '#fff';

function makeTrigger(title, o) {
  o = o || {};
  let t = String(title || '').trim();
  if (o.stripAT !== false) {
    t = t.replace(/^\s*(a\s*[\/-]?\s*t|at|a2|ans|answers?\s+to|vs\.?)\s*[:.\-–—]\s*/i, '');
    t = t.replace(/^\s*(a\s*[\/-]?\s*t|at|a2|answers?\s+to)\s+/i, '');
  }
  t = t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return t || 'block';
}

function dedupe(blocks) {
  const seen = {};
  blocks.forEach((b) => {
    let t = b.trigger || 'block', n = 2;
    while (seen[t]) t = (b.trigger || 'block') + ' ' + n++;
    seen[t] = true;
    b.trigger = t;
  });
  return blocks;
}

/* ====================================================================
   1. Fuzzy search — fzf-style subsequence scoring
   ==================================================================== */

const SC = { MATCH: 16, RUN: 12, WORD: 10, FIRST: 14, GAP: -5, EXT: -2 };

function boundary(s, i) {
  if (i === 0) return true;
  const c = s.charCodeAt(i - 1);
  return c === 32 || c === 45 || c === 47 || c === 58 || c === 95;
}

function scoreTerm(term, str) {
  if (!term) return { score: 0, pos: [] };
  if (!str || term.length > str.length) return null;

  const at = str.indexOf(term);
  if (at !== -1) {
    let base = term.length * (SC.MATCH + SC.RUN);
    if (at === 0) base += SC.FIRST * 2;
    else if (boundary(str, at)) base += SC.WORD * 2;
    base -= at * 0.4;
    const pos = [];
    for (let k = 0; k < term.length; k++) pos.push(at + k);
    return { score: base, pos };
  }

  let score = 0, prev = -2, ti = 0, gap = false;
  const pos = [];
  for (let i = 0; i < str.length && ti < term.length; i++) {
    if (str[i] !== term[ti]) continue;
    score += SC.MATCH;
    if (i === prev + 1) { score += SC.RUN; gap = false; }
    else {
      if (!gap) { score += SC.GAP; gap = true; }
      score += SC.EXT * Math.min(6, i - prev - 1);
    }
    if (i === 0) score += SC.FIRST;
    else if (boundary(str, i)) score += SC.WORD;
    pos.push(i);
    prev = i; ti++;
  }
  if (ti < term.length) return null;
  score -= Math.min(20, str.length - term.length) * 0.3;
  return { score, pos };
}

const W = { g: 1, t: 0.92, a: 0.72, c: 0.55 };

function scoreEntry(terms, e, opts) {
  let total = 0, trigPos = null, ttlPos = null;
  const argHits = {};

  for (const term of terms) {
    let best = null, field = null, bp = null, ba = -1, r;

    r = scoreTerm(term, e._g);
    if (r) { best = r.score * W.g; field = 'g'; bp = r.pos; }

    r = scoreTerm(term, e._t);
    if (r && r.score * W.t > (best === null ? -1e9 : best)) { best = r.score * W.t; field = 't'; bp = r.pos; }

    if (opts.args !== false && e._a) {
      for (let i = 0; i < e._a.length; i++) {
        r = scoreTerm(term, e._a[i]);
        if (r && r.score * W.a > (best === null ? -1e9 : best)) {
          best = r.score * W.a; field = 'a'; bp = r.pos; ba = i;
        }
      }
    }

    if (e._c) {
      r = scoreTerm(term, e._c);
      if (r && r.score * W.c > (best === null ? -1e9 : best)) { best = r.score * W.c; field = 'c'; bp = r.pos; }
    }

    if (best === null) return null;
    total += best;
    if (field === 'g' && !trigPos) trigPos = bp;
    if (field === 't' && !ttlPos) ttlPos = bp;
    if (field === 'a' && ba >= 0) argHits[ba] = true;
  }

  const avg = terms.join('').length / terms.length;
  const max = avg * (SC.MATCH + SC.RUN) + SC.FIRST * 2;
  return {
    entry: e, score: total, norm: total / (terms.length * Math.max(max, 1)),
    trigPos, ttlPos, argHits: Object.keys(argHits).map(Number)
  };
}

function search(query, entries, opts) {
  opts = opts || {};
  const max = opts.max || 200;
  const q = String(query || '').toLowerCase().replace(/^\/+/, '').trim();
  const terms = q ? q.split(/\s+/) : [];

  // Browsing with no query is not a search — it is the whole library, and
  // capping it silently hid blocks below the cut. Folding by category is what
  // keeps this readable, not truncation.
  if (!terms.length) {
    const all = entries.map((e) => ({
      entry: e, score: 0, norm: 1, trigPos: null, ttlPos: null, argHits: []
    }));
    all.total = all.length;
    return all;
  }

  const sens = opts.sens == null ? 0.45 : opts.sens;
  const floor = (1 - sens) * 0.55;
  const out = [];
  for (const e of entries) {
    const r = scoreEntry(terms, e, opts);
    if (r && r.norm >= floor) out.push(r);
  }
  out.sort((a, b) => b.score - a.score);

  // Searches stay capped for speed, but say so rather than quietly dropping
  // matches off the end.
  const shown = out.slice(0, max);
  shown.total = out.length;
  return shown;
}

function prepare(list) {
  return list.map((e) => {
    e._g = (e.g || '').toLowerCase();
    e._t = (e.t || '').toLowerCase();
    e._c = [e.c1, e.c2].filter(Boolean).join(' ').toLowerCase();
    e._a = (e.a || []).map((x) => String(x || '').toLowerCase());
    return e;
  });
}

/* ====================================================================
   2. Parser — Google Docs clipboard HTML -> evidence blocks
   --------------------------------------------------------------------
   Copying from Docs puts real HTML on the clipboard: headings become
   <h1>..<h6>, formatting becomes inline styles, highlights become
   background-color. That is a complete description of the document, so no
   API and no account access are needed to build the library.
   ==================================================================== */

const LEVEL = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };
const BLOCKISH = /^(P|DIV|H1|H2|H3|H4|H5|H6|LI|BLOCKQUOTE|PRE|TD|TH)$/;

function styleOf(node, inherited) {
  const s = Object.assign({}, inherited);
  const tag = node.tagName;

  if (tag === 'B' || tag === 'STRONG') s.b = true;
  if (tag === 'I' || tag === 'EM') s.i = true;
  if (tag === 'U') s.u = true;
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') s.s = true;
  if (tag === 'A' && node.getAttribute('href')) s.lk = node.getAttribute('href');

  // The style attribute wins over the tag. Docs wraps whole pastes in
  // <b style="font-weight:normal">, which must not bold the document.
  const st = node.style;
  if (st) {
    if (st.fontWeight) s.b = (st.fontWeight === 'bold' || parseInt(st.fontWeight, 10) >= 600);
    if (st.fontStyle) s.i = (st.fontStyle === 'italic' || st.fontStyle === 'oblique');
    if (st.textDecoration || st.textDecorationLine) {
      const d = (st.textDecoration || '') + ' ' + (st.textDecorationLine || '');
      s.u = /underline/.test(d);
      s.s = /line-through/.test(d);
    }
    if (st.fontSize) {
      const m = String(st.fontSize).match(/([\d.]+)\s*(pt|px)/);
      if (m) s.fs = Math.round(m[2] === 'px' ? parseFloat(m[1]) * 0.75 : parseFloat(m[1]));
    }
    if (st.fontFamily) s.ff = st.fontFamily.split(',')[0].replace(/["']/g, '').trim() || null;
    if (st.color) { const c = toHex(st.color); if (c) s.fg = c; }
    if (st.backgroundColor) {
      const bg = toHex(st.backgroundColor);
      s.bg = isHighlight(bg) ? bg : null;
    }
    if (st.verticalAlign === 'super') s.sup = true;
    if (st.verticalAlign === 'sub') s.sub = true;
  }
  return s;
}

function collectRuns(node, inherited, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      const t = child.nodeValue.replace(/ /g, ' ');
      if (!t) continue;
      const last = out[out.length - 1];
      const r = Object.assign({}, inherited, { t });
      if (last && sameStyle(last, r)) last.t += t;
      else out.push(r);
    } else if (child.nodeType === 1) {
      if (child.tagName === 'BR') { out.push(Object.assign({}, inherited, { t: ' ' })); continue; }
      if (BLOCKISH.test(child.tagName)) continue;   // handled by the block walker
      collectRuns(child, styleOf(child, inherited), out);
    }
  }
}

function sameStyle(a, b) {
  return !!a.b === !!b.b && !!a.i === !!b.i && !!a.u === !!b.u && !!a.s === !!b.s &&
         a.ff === b.ff && a.fs === b.fs && a.fg === b.fg && a.bg === b.bg && a.lk === b.lk;
}

function elementFor(node, listCtx) {
  const runs = [];
  collectRuns(node, {}, runs);
  runs.forEach((r) => { delete r.sup; delete r.sub; });
  const text = runs.map((r) => r.t).join('');
  if (!text.trim() && node.tagName !== 'P') return null;

  const e = { k: listCtx ? 'li' : 'p', h: node.tagName, runs };
  if (listCtx) { e.ol = listCtx.ol; e.nl = listCtx.depth; }

  const st = node.style;
  if (st && st.marginLeft) {
    const m = String(st.marginLeft).match(/([\d.]+)\s*(pt|px)/);
    if (m) e.ml = Math.round(m[2] === 'px' ? parseFloat(m[1]) * 0.75 : parseFloat(m[1]));
  }
  if (st && st.textAlign && st.textAlign !== 'start' && st.textAlign !== 'left') e.al = st.textAlign;
  return e;
}

/** Walk block-level nodes in document order. */
function walkBlocks(root, cb) {
  const rec = (node, listCtx) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;

      if (tag === 'UL' || tag === 'OL') {
        rec(child, { ol: tag === 'OL', depth: (listCtx ? listCtx.depth + 1 : 0) });
        continue;
      }
      if (tag === 'LI') { cb(child, listCtx || { ol: false, depth: 0 }); rec(child, listCtx); continue; }
      if (tag === 'TABLE' || tag === 'TBODY' || tag === 'TR') { rec(child, listCtx); continue; }
      if (BLOCKISH.test(tag)) {
        const nested = child.querySelector('p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,table');
        if (nested) { rec(child, listCtx); continue; }
        cb(child, listCtx);
        continue;
      }
      rec(child, listCtx);
    }
  };
  rec(root, null);
}

function parseHtml(html, opts) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style,script,meta,link').forEach((n) => n.remove());

  const blocks = [];
  const stats = { paragraphs: 0, headings: 0, orphans: 0 };
  let cat1 = null, cat2 = null, block = null, arg = null;

  const newBlock = (title, head) => ({
    id: uid('blk'),
    title: title || 'Untitled block',
    cat1, cat2,
    trigger: makeTrigger(title, opts),
    locked: false,
    head: head || null,
    pre: [],
    args: []
  });

  walkBlocks(doc.body, (node, listCtx) => {
    const e = elementFor(node, listCtx);
    if (!e) return;
    stats.paragraphs++;

    const lvl = LEVEL[e.h] || 0;
    const text = e.runs.map((r) => r.t).join('').trim();
    if (lvl) stats.headings++;

    if (lvl === 1) { cat1 = text || cat1; cat2 = null; block = null; arg = null; return; }
    if (lvl === 2) { cat2 = text || cat2; block = null; arg = null; return; }

    if (lvl === 3) {
      block = newBlock(text, e);
      blocks.push(block);
      arg = null;
      return;
    }
    if (lvl === 4) {
      if (!block) { block = newBlock(text || 'Untitled', null); blocks.push(block); stats.orphans++; }
      arg = { title: text, head: e, body: [] };
      block.args.push(arg);
      return;
    }
    if (!block) return;
    if (arg) arg.body.push(e);
    else block.pre.push(e);
  });

  dedupe(blocks);
  return { blocks, stats };
}

function blockToElements(block, o) {
  o = o || {};
  let out = [];
  if (o.head !== false && block.head) out.push(block.head);
  if (o.argIndex != null && o.argIndex >= 0) {
    const a = block.args[o.argIndex];
    if (a) { if (a.head) out.push(a.head); out = out.concat(a.body); }
    return out;
  }
  if (block.pre.length) out = out.concat(block.pre);
  block.args.forEach((a) => { if (a.head) out.push(a.head); out = out.concat(a.body); });
  return out;
}

/* ====================================================================
   3. Read generation — highlights only
   ==================================================================== */

const runsText = (e) => (e.runs || []).map((r) => r.t || '').join('');
const clone = (x) => JSON.parse(JSON.stringify(x));
const hasHl = (e) => (e.runs || []).some((r) => isHighlight(r.bg));
const blank = (e) => runsText(e).trim() === '';

function forceRuns(e, o) {
  const c = clone(e);
  (c.runs || []).forEach((r) => {
    if (o.bold !== undefined) r.b = o.bold;
    if (o.size !== undefined) r.fs = o.size;
    if (o.stripBg) r.bg = null;
  });
  if (o.h) c.h = o.h;
  return c;
}

/**
 * Keep only the runs `keep()` accepts and rejoin what survives.
 *
 * Fragments separated by cut-out words get a single space; a cut landing
 * inside a word — "goal|s" — joins directly, so the result reads "goals" and
 * not "goal s". Shared by highlight extraction and short-cite extraction.
 */
function keepRuns(runs, keep, tweak) {
  const out = [];
  let cut = '';
  (runs || []).forEach((r) => {
    if (!keep(r)) { cut += (r.t || ''); return; }
    const c = clone(r);
    if (tweak) tweak(c);
    if (cut && out.length) {
      const prev = out[out.length - 1].t;
      if (/\s/.test(cut) && !/\s$/.test(prev) && !/^\s/.test(c.t)) c.t = ' ' + c.t;
    }
    cut = '';
    out.push(c);
  });
  if (!out.length) return [];
  out[0].t = out[0].t.replace(/^\s+/, '');
  out[out.length - 1].t = out[out.length - 1].t.replace(/\s+$/, '');
  out.forEach((r) => { r.t = r.t.replace(/\s{2,}/g, ' '); });
  return out.filter((r) => r.t.length);
}

function highlightOnly(e, stripBg) {
  const runs = keepRuns(e.runs, (r) => isHighlight(r.bg), (c) => { if (stripBg) c.bg = null; });
  if (!runs.length) return null;
  const out = clone(e);
  out.runs = runs;
  out.h = 'P';
  return out;
}

/**
 * Separate the cite from the card text.
 *
 * Two rules that both had to be learned the hard way:
 *
 *  - Highlighting is not the boundary. Debaters often highlight the author's
 *    name so they read it aloud, and keying off highlighting made those cites
 *    vanish entirely.
 *  - Length is not the boundary either. A cite carrying a full citation, a DOI
 *    and a retrieval URL runs past 400 characters, so a tight length cap threw
 *    exactly those cites away — which is why it broke on some cards and not
 *    others.
 *
 * So: the first paragraph after the tagline is the cite unless it is plainly
 * card text (highlighted *and* long). Paragraphs after it join the cite only
 * while they stay short and unhighlighted — those are qualifications.
 */
const CITE_MAX_CHARS = 600;   // a first cite line can carry a whole citation
const QUAL_MAX_CHARS = 140;   // a qualification line is a phrase, not a paragraph

function splitCite(body, s) {
  const anyHighlight = body.some(hasHl);
  const cap = anyHighlight ? 3 : Math.max(1, s.citeLines || 2);
  const cite = [];
  let citeSize = null;
  let i = 0;

  for (; i < body.length; i++) {
    const e = body[i];
    if (blank(e)) continue;
    const len = runsText(e).length;

    if (!cite.length) {
      // The first paragraph after the tagline is the cite, unless it is
      // plainly card text: highlighted and long.
      if (hasHl(e) && len > CITE_MAX_CHARS) break;
      cite.push(e);
      citeSize = baseSize(e.runs || []) || null;
      continue;
    }

    // Later paragraphs only join the cite if they look like qualifications.
    // Card text that happens to carry no highlighting was being swept up here
    // and printed at 13pt bold, which put whole unread paragraphs into the
    // speech. Two things separate a qual from card text: quals are short, and
    // card text is set smaller than the cite in every Verbatim-style file.
    if (hasHl(e)) break;
    if (len > QUAL_MAX_CHARS) break;
    const size = baseSize(e.runs || []);
    if (citeSize && size && size < citeSize) break;

    cite.push(e);
    if (cite.length >= cap) { i++; break; }
  }

  return [cite, body.slice(i)];
}

/** Split a run list at a character offset, keeping formatting on both halves. */
function splitRunsAt(runs, at) {
  const before = [], after = [];
  let seen = 0;
  runs.forEach((r) => {
    const len = (r.t || '').length;
    if (seen + len <= at) before.push(clone(r));
    else if (seen >= at) after.push(clone(r));
    else {
      const a = clone(r), b = clone(r);
      a.t = r.t.slice(0, at - seen);
      b.t = r.t.slice(at - seen);
      if (a.t) before.push(a);
      if (b.t) after.push(b);
    }
    seen += len;
  });
  return [before, after];
}

const CITE_BREAK = /\s*[[(]/;

/** The size most of the cite is set in, weighted by how much text uses it. */
function baseSize(runs) {
  const chars = {};
  (runs || []).forEach((r) => {
    const k = r.fs || 0;
    chars[k] = (chars[k] || 0) + (r.t || '').length;
  });
  let best = 0, most = -1;
  Object.keys(chars).forEach((k) => { if (chars[k] > most) { most = chars[k]; best = Number(k); } });
  return best;
}

/**
 * Cut the short cite out of a cite line.
 *
 * Debaters mark it the Verbatim way — the author's name and the year are set
 * bold, and usually a size or two larger, inside an otherwise plain line:
 *
 *   Rosalind **Hurtshouse** 2-7-20**02**, British-born New Zealand based…
 *
 * so the short cite is whatever carries that emphasis: "Hurtshouse 02". Only
 * when nothing in the line is emphasised do we fall back to underlining, then
 * to splitting at the opening bracket of a "Author Year [full citation]" line.
 */
function shortCiteRuns(runs) {
  const base = baseSize(runs);
  const emph = (r) => !!r.b || (!!r.fs && !!base && r.fs > base);

  let out = keepRuns(runs, emph);
  if (out.length) return out;

  out = keepRuns(runs, (r) => !!r.u);
  if (out.length) return out;

  const m = runsText({ runs }).match(CITE_BREAK);
  if (m && m.index > 0) return keepRuns(splitRunsAt(runs, m.index)[0], () => true);
  return [];
}

/**
 * A cite line becomes a short cite at reading size, optionally followed by the
 * whole line shrunk down for reference. Only the first cite paragraph is
 * treated this way — paragraphs after it are qualifications, and those stay at
 * reading size. When the emphasis already covers the whole line (a cite that is
 * just "Smith 2025") there is nothing to split, so it prints once.
 */
function formatCite(cite, s) {
  if (!cite.length) return [];
  const style = s.citeStyle || 'compact';
  const first = cite[0];
  const out = [];

  const short = style === 'full' ? [] : shortCiteRuns(first.runs || []);
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  const shortText = norm(short.map((r) => r.t).join(''));
  const split = !!shortText && shortText !== norm(runsText(first));

  if (split) {
    out.push(forceRuns(Object.assign(clone(first), { runs: short }), {
      bold: s.citeBold ? true : undefined, size: s.citeSize, stripBg: s.stripHl, h: 'P'
    }));
    if (style !== 'short') {
      out.push(forceRuns(first, {
        bold: false, size: s.fullCiteSize, stripBg: s.stripHl, h: 'P'
      }));
    }
  } else {
    out.push(forceRuns(first, {
      bold: s.citeBold ? true : undefined, size: s.citeSize, stripBg: s.stripHl, h: 'P'
    }));
  }

  cite.slice(1).forEach((e) => out.push(forceRuns(e, {
    bold: s.citeBold ? true : undefined, size: s.citeSize, stripBg: s.stripHl, h: 'P'
  })));
  return out;
}

/** The number an analytic should take: one past the highest already in the block. */
function nextArgNumber(parts) {
  let max = 0;
  (parts || []).forEach((p) => {
    (p.elems || []).forEach((e) => {
      if ((LEVEL[e.h] || 0) !== 4) return;
      const m = runsText(e).match(/^\s*(\d+)\s*[.)]/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
  });
  return max + 1;
}

/**
 * Build an analytic from typed text. Every line becomes its own numbered
 * Heading 4 at 13pt — same weight, size and numbering as the taglines around
 * it, so a speech document reads as one continuous list. A line you numbered
 * yourself is left alone and the count picks up from it.
 *
 * Marked so the speech document leaves the content alone: there is no cite to
 * shorten and no highlighting to extract.
 */
function analyticPart(text, startAt) {
  const lines = String(text || '').split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  if (!lines.length) return null;

  let n = Math.max(1, startAt || 1);
  const elems = lines.map((line) => {
    const own = line.match(/^\s*(\d+)\s*[.)]/);
    const t = own ? line : (n + '. ' + line);
    n = (own ? parseInt(own[1], 10) : n) + 1;
    return { k: 'p', h: 'H4', an: 1, runs: [{ t: t, b: true, fs: 13 }] };
  });

  return { id: uid('prt'), title: runsText(elems[0]), elems: elems, analytic: true };
}

/** One sent card -> the elements that belong in the speech document. */
function readElements(card, s) {
  const out = [];
  if (s.readHeadings && card.head3) out.push(clone(card.head3));

  // Your own analytics are already the words you say: no cite to shorten, no
  // highlighting to extract. They pass through untouched.
  if (card.tagline && card.tagline.an) {
    out.push(forceRuns(card.tagline, { bold: s.boldTag ? true : undefined, stripBg: s.stripHl }));
    (card.body || []).forEach((e) => out.push(clone(e)));
    return out;
  }

  if (card.tagline) out.push(forceRuns(card.tagline, { bold: s.boldTag ? true : undefined, stripBg: s.stripHl }));

  const [cite, ev] = splitCite(card.body || [], s);
  const evidence = [];
  const take = (list) => (list || []).forEach((e) => {
    const hl = highlightOnly(e, s.stripHl);
    if (hl) evidence.push(hl);
  });

  take(ev);

  // Safety net. Highlighted text is the whole point of the speech document, so
  // it must never be lost to a misjudged cite boundary. If the split produced
  // no evidence at all, look inside what was taken as the cite.
  if (!evidence.length) take(cite.slice(1));

  if (!evidence.length && cite.length === 1 && hasHl(cite[0])) {
    // Cite and card in a single paragraph. Pull the highlights out of it too,
    // unless they are only the short cite highlighted for reading aloud.
    const hl = highlightOnly(cite[0], s.stripHl);
    const shortText = shortCiteRuns(cite[0].runs || [])
      .map((r) => r.t).join('').replace(/\s+/g, ' ').trim();
    if (hl && runsText(hl).replace(/\s+/g, ' ').trim() !== shortText) evidence.push(hl);
  }

  formatCite(cite, s).forEach((e) => out.push(e));
  evidence.forEach((e) => out.push(e));
  return out;
}

/** Words in a document, counted the way a speech-timer would. */
function wordCount(elems) {
  const text = (elems || []).map(runsText).join(' ');
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

function fmtDuration(words, wpm) {
  const secs = Math.round((words / Math.max(40, wpm || 200)) * 60);
  return Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
}

/**
 * Build a speech document from any element list — the single path used by both
 * the Read tab and the case converter, so they cannot drift apart.
 *
 * Heading 4s mark cards. When a paste has none, headings still break it into
 * sections and each section is run through the same card treatment, so the
 * highlighting still drives what survives.
 */
function readFromElements(elems) {
  const out = [];
  let seg = [];
  const flush = () => { if (seg.length) { out.push(...readSegment(seg)); seg = []; } };

  (elems || []).forEach((e) => {
    const lvl = LEVEL[e.h] || 0;
    // Contention and subpoint headers are structure, not evidence: keep them
    // and start a new section. A card block never contains these, so the Send
    // side is unaffected.
    if (lvl === 1 || lvl === 2) {
      flush();
      out.push(forceRuns(e, { bold: true, stripBg: S.settings.stripHl }));
      return;
    }
    seg.push(e);
  });

  flush();
  return out;
}

function readSegment(elems) {
  const spacer = () => ({ k: 'p', h: 'P', runs: [] });
  const out = [];
  const cards = toCards(elems);

  if (cards.length) {
    cards.forEach((card) => {
      const els = readElements(card, S.settings);
      if (els.length) out.push(...els, spacer());
    });
    return out;
  }

  // No Heading 4s at all: split on whatever headings there are and put each
  // run of paragraphs through the same card treatment.
  let body = [];
  const flushBody = () => {
    if (!body.length) return;
    const els = readElements({ tagline: null, head3: null, body }, S.settings);
    if (els.length) out.push(...els, spacer());
    body = [];
  };
  elems.forEach((e) => {
    if (LEVEL[e.h]) {
      flushBody();
      out.push(forceRuns(e, { bold: true, stripBg: S.settings.stripHl }));
    } else body.push(e);
  });
  flushBody();
  return out;
}

/** Parse pasted clipboard HTML into elements, without touching the library. */
function elementsFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style,script,meta,link').forEach((n) => n.remove());
  const out = [];
  walkBlocks(doc.body, (node, listCtx) => {
    const e = elementFor(node, listCtx);
    if (e) out.push(e);
  });
  return out;
}

/** Split inserted elements into cards, so Read can be derived from Send. */
function toCards(elems) {
  const cards = [];
  let head3 = null, seen = false, cur = null;
  elems.forEach((e) => {
    const lvl = LEVEL[e.h] || 0;
    if (lvl === 1 || lvl === 2) { cur = null; return; }
    if (lvl === 3) { head3 = e; seen = false; cur = null; return; }
    if (lvl === 4) {
      cur = { tagline: e, head3: seen ? null : head3, body: [] };
      seen = true;
      cards.push(cur);
      return;
    }
    if (cur) cur.body.push(e);
  });
  return cards;
}

/* ====================================================================
   4. HTML output — what actually lands on the clipboard
   ==================================================================== */

function runStyle(r) {
  const css = [];
  if (r.b) css.push('font-weight:700');
  if (r.i) css.push('font-style:italic');
  const d = [];
  if (r.u) d.push('underline');
  if (r.s) d.push('line-through');
  if (d.length) css.push('text-decoration:' + d.join(' '));
  if (r.fs) css.push('font-size:' + r.fs + 'pt');
  if (r.ff) css.push("font-family:'" + r.ff + "'");
  if (r.fg) css.push('color:' + r.fg);
  if (r.bg) css.push('background-color:' + r.bg);
  return css.join(';');
}

function runHtml(r) {
  const inner = esc(r.t).replace(/ {2}/g, ' &nbsp;');
  const css = runStyle(r);
  const span = css ? '<span style="' + css + '">' + inner + '</span>' : inner;
  return r.lk ? '<a href="' + esc(r.lk) + '">' + span + '</a>' : span;
}

const HTAG = { H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h5', H6: 'h6' };

/**
 * One thing a run cannot say: `brk`, a page break. Docs throws these away on
 * paste, whatever they are written as, so this one is for the page on screen;
 * `forPaste` takes it out again before anything reaches the clipboard, since
 * what Docs does keep is the horizontal rule, and a stray line through the
 * document is worse than no break at all.
 */

function toHtml(elems) {
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };

  elems.forEach((e) => {
    const inner = (e.runs || []).map(runHtml).join('') || '<br>';
    const css = [];
    if (e.ml) css.push('margin-left:' + e.ml + 'pt');
    if (e.al) css.push('text-align:' + e.al);
    const attr = css.length ? ' style="' + css.join(';') + '"' : '';

    if (e.k === 'brk') { closeList(); out.push('<hr class="brk">'); return; }
    if (e.k === 'li') {
      const want = e.ol ? 'ol' : 'ul';
      if (list !== want) { closeList(); out.push('<' + want + '>'); list = want; }
      out.push('<li' + attr + '>' + inner + '</li>');
      return;
    }
    closeList();
    const tag = HTAG[e.h] || 'p';
    out.push('<' + tag + attr + '>' + inner + '</' + tag + '>');
  });
  closeList();
  return '<meta charset="utf-8">' + out.join('');
}

const toText = (elems) => elems.map(runsText).join('\n');

/**
 * What goes on the clipboard, as opposed to what is on the page.
 *
 * Google Docs discards page breaks when you paste and keeps the horizontal
 * rule they are written as, which would leave a line across the document
 * where the break was meant to be. So the breaks are drawn on the page and
 * dropped on the way out.
 */
const forPaste = (html) => html.replace(/<hr[^>]*>/gi, '');

/* ------------------------------------------------------------ clipboard */

const copyRich = (elems) => copyMarkup(forPaste(toHtml(elems)), toText(elems));

async function copyMarkup(html, text) {
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' })
    })]);
    return true;
  } catch (e) {
    // Fallback for browsers without the async clipboard API: stage the HTML
    // in a hidden contenteditable and use the legacy copy command.
    const stage = $('#clipstage');
    stage.innerHTML = html;
    const range = document.createRange();
    range.selectNodeContents(stage);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('copy');
    sel.removeAllRanges();
    stage.innerHTML = '';
    if (!ok) throw new Error('The browser refused clipboard access.');
    return true;
  }
}

/* ====================================================================
   5. Storage — IndexedDB, so the library can be far larger than
      localStorage's few megabytes
   ==================================================================== */

const DB = (() => {
  let dbp = null;
  let conn = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('evidence', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('blocks')) db.createObjectStore('blocks');
      };
      req.onsuccess = () => { conn = req.result; resolve(conn); };
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  /**
   * Wipe every store.
   *
   * Deliberately not indexedDB.deleteDatabase(): that call is blocked for as
   * long as any other tab holds the database open, and a blocked delete also
   * stalls the next open, so a second tab could hang the page instead of
   * clearing it. Emptying the stores cannot be blocked and is what actually
   * removes the data. An empty database shell may still be listed in DevTools.
   */
  async function destroy() {
    await tx('blocks', 'readwrite', (s) => s.clear());
    await tx('kv', 'readwrite', (s) => s.clear());
  }

  // An IDBRequest for a key that isn't there has result === undefined, which
  // is indistinguishable from "no request" if you test the value. Test the
  // object instead — IDBRequest always carries a string readyState.
  const isRequest = (o) => !!o && typeof o === 'object' && typeof o.readyState === 'string';

  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => resolve(isRequest(out) ? out.result : out);
      t.onerror = () => reject(t.error);
    });
  };

  return {
    destroy,
    count: (store) => tx(store, 'readonly', (s) => s.count()),
    get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
    set: (store, key, val) => tx(store, 'readwrite', (s) => s.put(val, key)),
    del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
    clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
    putMany: (store, entries) => tx(store, 'readwrite', (s) => { entries.forEach(([k, v]) => s.put(v, k)); }),
    estimate: async () => (navigator.storage && navigator.storage.estimate) ? navigator.storage.estimate() : null
  };
})();

/* ====================================================================
   6. App state
   ==================================================================== */

const DEFAULTS = {
  sens: 0.45,
  max: 200,
  args: true,
  head: true,
  boldTag: true,
  citeBold: true,
  citeSize: 13,
  citeStyle: 'short',     // 'short' | 'compact' | 'full'
  fullCiteSize: 9,
  citeLines: 2,
  stripHl: true,
  readHeadings: true,
  wpm: 200,
  stripAT: true,
  // The formatter's answers. The code and the side stay the same all weekend,
  // so they are asked once and remembered; the tournament changes and is the
  // one thing anyone should have to retype.
  fmtCode: '',
  fmtSpeech: '2AC',
  fmtTourn: '',
  fmtDrop: false,
  fmtRenumber: true,
  fmtTag: true,
  fmtTidy: true,
  fmtPages: true
};

const S = {
  index: [],
  meta: null,
  settings: Object.assign({}, DEFAULTS),
  send: [],          // [{ id, title, trigger, elems }]
  results: [],
  flat: [],
  sel: 0,
  expanded: {},
  collapsed: {},
  groups: [],
  query: '',
  tab: 'send',
  caseElems: [],
  caseWords: 0,
  addingTo: null,
  /**
   * The send document once it has been typed in.
   *
   * Null means nobody has touched it and the panel is a live picture of the
   * send list. As soon as a word is changed it becomes a draft: this holds
   * the draft's HTML, `docIds` holds the blocks already in it, and anything
   * sent afterwards is added to the end rather than regenerating over the
   * top of what was written.
   */
  docHtml: null,
  docIds: []
};

function loadSettings() {
  try {
    const raw = localStorage.getItem('evidence.settings');
    if (raw) S.settings = Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch (e) { /* first run */ }
  try {
    const c = localStorage.getItem('evidence.collapsed');
    if (c) S.collapsed = JSON.parse(c) || {};
  } catch (e) { /* first run */ }
}

function saveCollapsed() {
  try { localStorage.setItem('evidence.collapsed', JSON.stringify(S.collapsed)); } catch (e) {}
}
function saveSettings() {
  try { localStorage.setItem('evidence.settings', JSON.stringify(S.settings)); } catch (e) {}
}

/* ====================================================================
   7. Rendering
   ==================================================================== */

function markUp(str, pos) {
  if (!pos || !pos.length) return esc(str);
  const set = new Set(pos);
  let out = '', open = false;
  for (let i = 0; i < str.length; i++) {
    if (set.has(i) && !open) { out += '<mark>'; open = true; }
    if (!set.has(i) && open) { out += '</mark>'; open = false; }
    out += esc(str[i]);
  }
  return out + (open ? '</mark>' : '');
}

function renderStat() {
  const bits = [];
  if (!S.meta) bits.push('<span class="chip warn">no library</span>');
  else {
    bits.push('<span class="chip good">' + S.meta.count + ' blocks</span>');
    bits.push('<span class="chip">' + S.meta.argCount + ' args</span>');
    if (S.meta.name) bits.push('<span class="chip">' + esc(S.meta.name) + '</span>');
  }
  $('#stat').innerHTML = bits.join('');
}

/* --------------------------------------------------------------- groups
   Results are grouped by their category path. A whole topic file often sits
   under one heading, which turns the index into hundreds of rows saying the
   same thing on the right; folding them puts the structure back. */

function groupKeyOf(e) {
  return [e.c1, e.c2].filter(Boolean).join(' › ') || 'Uncategorised';
}

/** A search must never hide a hit, so a query forces every group open. */
function groupOpen(key) {
  return S.query ? true : !S.collapsed[key];
}

function buildGroups() {
  const byKey = {};
  const order = [];
  S.results.forEach((r, ri) => {
    const k = groupKeyOf(r.entry);
    if (!byKey[k]) { byKey[k] = { key: k, rows: [], cards: 0 }; order.push(byKey[k]); }
    byKey[k].rows.push(ri);
    byKey[k].cards += (r.entry.n || 0);
  });
  return order;
}

function toggleGroup(key) {
  if (S.query) return;                   // nothing to fold while searching
  S.collapsed[key] = !S.collapsed[key];
  saveCollapsed();
  renderResults();
}

function toggleAllGroups() {
  const anyOpen = S.groups.some((g) => !S.collapsed[g.key]);
  S.groups.forEach((g) => { S.collapsed[g.key] = anyOpen; });
  saveCollapsed();
  renderResults();
}

function buildFlat() {
  S.groups = buildGroups();
  S.flat = [];

  S.groups.forEach((g) => {
    S.flat.push({ t: 'group', gk: g.key });
    if (!groupOpen(g.key)) return;
    g.rows.forEach((ri) => {
      S.flat.push({ t: 'block', ri: ri });
      const r = S.results[ri];
      if (r.expanded) (r.entry.a || []).forEach((_, ai) => S.flat.push({ t: 'arg', ri: ri, ai: ai }));
    });
  });

  // -1 means "put me on the first real result, not a group header".
  if (S.sel === -1) {
    const first = S.flat.findIndex((f) => f.t !== 'group');
    S.sel = first === -1 ? 0 : first;
  }
  if (S.sel >= S.flat.length) S.sel = Math.max(0, S.flat.length - 1);
}

function renderResults() {
  buildFlat();
  const box = $('#results');

  if (!S.index.length) {
    box.innerHTML = '<div class="blank"><strong>No evidence yet</strong>' +
      '<p>Open your evidence document in Google Docs, select all, copy. ' +
      'Then click <b>Import</b> and paste. Nothing leaves this page.</p></div>';
    $('#searchmeta').textContent = '';
    return;
  }
  if (!S.results.length) {
    box.innerHTML = '<div class="blank"><strong>No matches</strong>' +
      '<p>Try fewer letters, or loosen fuzzy sensitivity in Settings.</p></div>';
    $('#searchmeta').textContent = '0';
    return;
  }

  const rowHtml = (ri) => {
    const r = S.results[ri];
    const e = r.entry;
    const isSel = S.flat[S.sel] && S.flat[S.sel].t === 'block' && S.flat[S.sel].ri === ri;
    let out = '<div class="row' + (isSel ? ' sel' : '') + '" data-ri="' + ri + '">' +
                '<span class="trig">/' + markUp(e.g, r.trigPos) + '</span>' +
                '<span class="ttl">' + markUp(e.t, r.ttlPos) + '</span>' +
                '<span class="meta">' + e.n + (e.n === 1 ? ' arg' : ' args') + '</span>' +
                '<button class="del" data-del="' + ri + '" title="Delete from library">&times;</button>' +
              '</div>';
    if (!r.expanded) return out;

    out += '<div class="args">';
    (e.a || []).forEach((title, ai) => {
      const aSel = S.flat[S.sel] && S.flat[S.sel].t === 'arg' &&
                   S.flat[S.sel].ri === ri && S.flat[S.sel].ai === ai;
      out += '<div class="arg' + (aSel ? ' sel' : '') + '" data-ri="' + ri + '" data-ai="' + ai + '">' +
               '<span class="argn">' + (ai + 1) + '</span>' +
               '<span class="argt">' + esc(title || '(untitled)') + '</span>' +
               '<button class="del" data-delarg="' + ri + ':' + ai + '" title="Delete this argument">&times;</button>' +
             '</div>';
    });
    return out + '</div>';
  };

  let html = '';
  S.groups.forEach((g) => {
    const open = groupOpen(g.key);
    const gSel = S.flat[S.sel] && S.flat[S.sel].t === 'group' && S.flat[S.sel].gk === g.key;
    html += '<div class="grp' + (gSel ? ' sel' : '') + (open ? '' : ' closed') +
              '" data-grp="' + esc(g.key) + '">' +
              '<span class="chev">' + (open ? '▾' : '▸') + '</span>' +
              '<span class="glabel">' + esc(g.key) + '</span>' +
              '<span class="gcount">' + g.rows.length + (g.rows.length === 1 ? ' block' : ' blocks') +
                ' · ' + g.cards + (g.cards === 1 ? ' card' : ' cards') + '</span>' +
              '<button class="del" data-delgrp="' + esc(g.key) +
                '" title="Delete every block in this category">&times;</button>' +
            '</div>';
    if (open) g.rows.forEach((ri) => { html += rowHtml(ri); });
  });

  box.innerHTML = html;
  const shown = S.results.length;
  const found = (typeof S.results.total === 'number') ? S.results.total : shown;
  $('#searchmeta').textContent = (found > shown)
    ? shown + ' of ' + found + ' · capped'
    : shown + ' / ' + S.index.length;
  const selEl = box.querySelector('.sel');
  if (selEl) selEl.scrollIntoView({ block: 'nearest' });
}

function renderSide() {
  $('#sendCount').textContent = S.send.length ? '(' + S.send.length + ')' : '';
  root.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === S.tab);
  });

  const acts = $('#sideacts');
  const body = $('#sidebody');

  if (S.tab === 'send') {
    acts.innerHTML =
      '<button class="btn key" data-act="copySend">Copy Send doc</button>' +
      '<button class="btn" data-act="addAnalytic">+ Analytic</button>' +
      '<button class="btn" data-act="clearSend">Clear</button>';
    if (!S.send.length && S.addingTo === null) {
      body.innerHTML = '<div class="blank"><strong>Nothing sent yet</strong>' +
        '<p>Press <kbd>↵</kbd> on a result. The card is copied for you to paste, ' +
        'and stacks up here. <b>+ Analytic</b> adds a tagline you write yourself.</p></div>';
      renderDoc();
      return;
    }
    body.innerHTML = S.send.map((c, i) => {
      const n = (c.parts || []).length;
      let h = '<div class="sent" draggable="true" data-sent="' + i + '">' +
        '<span class="n" title="Drag to reorder">' + (i + 1) + '</span>' +
        '<div class="body">' +
          '<div class="tag">' + esc(c.title) + '</div>' +
          '<div class="cite">' + (c.analytic ? 'analytic' : '/' + esc(c.trigger)) + ' · ' +
            '<button class="link" data-open="' + i + '">' + n + ' card' + (n === 1 ? '' : 's') +
            (c.open ? ' ▴' : ' ▾') + '</button>' +
          '</div>' +
        '</div>' +
        '<span class="mvs">' +
          '<button class="mv" data-mv="' + i + ':-1"' + (i === 0 ? ' disabled' : '') +
            ' title="move up">▲</button>' +
          '<button class="mv" data-mv="' + i + ':1"' + (i === S.send.length - 1 ? ' disabled' : '') +
            ' title="move down">▼</button>' +
        '</span>' +
        '<button class="x" data-drop="' + i + '" title="remove the whole block">×</button>' +
      '</div>';

      if (!c.open) return h;

      h += '<div class="parts">';
      if (c.head3) {
        h += '<div class="part' + (c.includeHead ? '' : ' off') + '">' +
               '<button class="tick" data-head="' + i + '" title="include the block title">' +
                 (c.includeHead ? '✓' : '') + '</button>' +
               '<span class="ptitle dim">' + esc(c.title) + ' — block title</span>' +
             '</div>';
      }
      (c.parts || []).forEach((p, pi) => {
        h += '<div class="part">' +
               '<span class="pn">' + (pi + 1) + '</span>' +
               '<span class="ptitle">' + esc(p.title) + '</span>' +
               '<button class="x" data-part="' + i + ':' + pi + '" title="remove this card">×</button>' +
             '</div>';
      });
      h += (S.addingTo === i)
        ? composerHtml()
        : '<div class="part addrow"><button class="link" data-addpart="' + i +
          '">+ analytic in this block</button></div>';
      return h + '</div>';
    }).join('') + (S.addingTo === -1 ? composerHtml() : '');

    wireComposer();
    renderDoc();
    return;
  }

  /* Read tab */
  const elems = buildReadElements();
  const words = wordCount(elems);
  acts.innerHTML =
    '<button class="btn key" data-act="copyRead">Copy Read doc</button>' +
    '<span class="chip good">' + words.toLocaleString() + ' words</span>' +
    '<span class="chip">~' + fmtDuration(words, S.settings.wpm) + '</span>';

  if (!elems.length) {
    body.innerHTML = '<div class="blank"><strong>Nothing to read yet</strong>' +
      '<p>Send some cards and the speech document builds itself here.</p></div>';
    return;
  }
  body.innerHTML = '<div class="preview">' + previewHtml(elems) + '</div>';
  renderDoc();
}

/**
 * The document, as the other team will see it.
 *
 * The send list says which blocks are going and in what order, which is what
 * you steer with. It does not show the words. Everyone builds the speech doc
 * in the other window anyway, so the window is here: the panel renders the
 * very HTML that the copy button puts on the clipboard, so what is on this
 * page is what lands in their doc -- highlighting, sizes, the lot. It wears
 * that document's typography rather than the site's, because it is a preview
 * of somewhere else.
 *
 * It follows the tab: the send document beside the send list, the speech
 * document beside the read view.
 */
// toHtml leads with the charset meta the clipboard needs; on a page it is just
// an empty node sitting where the first paragraph should be.
const pageHtml = (elems) => toHtml(elems).replace(/^<meta[^>]*>/, '');

function renderDoc() {
  const host = $('#docbody');
  if (!host) return;
  const read = S.tab === 'read';
  const label = $('#doclabel');
  if (label) label.textContent = read ? 'Read doc' : 'Send doc';
  // The formatting row belongs to the document you can write in, and the read
  // view is not one: it is derived from the highlighting every time.
  const pane = root.querySelector('.docpane');
  if (pane) pane.classList.toggle('editable', !read);

  // The speech document is derived from the highlighting every time, so there
  // is nothing to keep: it is shown, not edited.
  if (read) {
    const elems = buildReadElements();
    host.innerHTML = elems.length
      ? paperHtml(pageHtml(elems), false)
      : '<div class="docempty">The speech document builds itself as you send cards.</div>';
    return;
  }

  // A draft that has been emptied -- everything selected and deleted, or a
  // save that went wrong -- is treated as no draft at all, so the document
  // comes back from the send list instead of showing a blank page for ever.
  if (S.docHtml !== null && !S.docHtml.replace(/<[^>]+>/g, '').trim()) S.docHtml = null;

  if (S.docHtml === null) {
    const elems = buildSendElements();
    S.docIds = S.send.map((c) => c.id);
    // With nothing sent this is a blank page, not a notice about one: the
    // first thing anyone does in a round is start typing, and a paragraph
    // explaining that you could have is in the way of doing it. The prompt
    // is a hint drawn behind the first line and goes on the first keystroke.
    host.innerHTML = elems.length
      ? paperHtml(pageHtml(elems), true)
      : paperHtml('', true).replace('class="sheet"', 'class="sheet blank"');
    return;
  }

  // A draft. Anything sent since the last look joins the end of it.
  const fresh = S.send.filter((c) => !S.docIds.includes(c.id));
  if (fresh.length) {
    const add = [];
    fresh.forEach((c) => {
      const els = entryElems(c);
      if (els.length) add.push(...els, { k: 'p', h: 'P', runs: [] });
    });
    if (add.length) S.docHtml += pageHtml(add);
    S.docIds = S.send.map((c) => c.id);
    saveDoc();
  }
  host.innerHTML =
    '<div class="docnote">Your draft — new cards join the end ' +
      '<button class="link" data-act="docReset">Rebuild</button></div>' +
    paperHtml(S.docHtml, true);
}

/* --------------------------------------------------------------- paper
   A document is not a long strip: it is sheets, one after another, with the
   desk showing between them. So the panel builds sheets -- US Letter at
   96dpi, 816 by 1056, with Docs' inch margins -- and a page break starts a
   new one. A sheet is a full page tall however little is on it, which is why
   a cover page looks like a cover page.

   All of it sits inside one editable element rather than one per sheet, so
   the cursor walks from the foot of one page to the head of the next the way
   it does in any editor. The flat document is recovered by joining the
   sheets back up with the break between them. */

const SHEET_BREAK = '<hr class="brk">';

/** The sheets of a document, as HTML, split where the page breaks are. */
function sheetsFrom(html) {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const sheets = [[]];
  [...holder.childNodes].forEach((n) => {
    if (n.nodeType === 1 && n.tagName === 'HR') { sheets.push([]); return; }
    sheets[sheets.length - 1].push(n);
  });
  return sheets.map((nodes) => {
    const box = document.createElement('div');
    nodes.forEach((n) => box.appendChild(n));
    return box.innerHTML;
  });
}

/**
 * The document as one run of HTML again, breaks included.
 *
 * Falls back to the paper itself when there are no sheets in it. A sheet is a
 * plain div inside an editable region and an editing command is free to take
 * it apart -- select everything and type, and Chrome will happily replace the
 * lot -- so this must never be the reason a draft comes back empty.
 */
function flatten(paper) {
  if (!paper) return '';
  const sheets = [...paper.querySelectorAll('.sheet')];
  if (!sheets.length) return paper.innerHTML;
  return sheets.map((s) => s.innerHTML).join(SHEET_BREAK);
}

/**
 * The paper: every sheet.
 *
 * Each sheet is its own editable region rather than one region wrapped round
 * them all. The cursor cannot then walk from the foot of one page to the head
 * of the next, which is a loss; what it buys is that no edit can delete the
 * page it is being made in, and text typed at the join cannot land outside a
 * sheet where the next save would not find it. A draft that disappears is a
 * worse thing than a cursor that stops at the end of a page.
 */
function paperHtml(html, editable) {
  const attr = editable ? ' contenteditable="true" spellcheck="false"' : '';
  const sheets = sheetsFrom(html)
    .map((inner) => '<div class="sheet"' + attr + '>' + (inner || '<p><br></p>') + '</div>')
    .join('');
  return '<div class="paper">' + sheets + '</div>';
}

/** Keep the draft, debounced: typing must not write to the database per key. */
let docTimer = null;
function saveDoc() {
  clearTimeout(docTimer);
  docTimer = setTimeout(() => {
    if (S.docHtml === null) DB.del('kv', 'doc').catch(() => {});
    else DB.set('kv', 'doc', { html: S.docHtml, ids: S.docIds }).catch(() => {});
  }, 400);
}

/** Typing in the document. The send list is not touched; only the draft is. */
function onDocInput(ev) {
  const sheet = ev.target && ev.target.closest ? ev.target.closest('.sheet[contenteditable]') : null;
  if (!sheet) return;
  const paper = sheet.closest('.paper');
  const first = S.docHtml === null;
  sheet.classList.remove('blank');

  const next = flatten(paper);
  // An empty read with text still on the page is a bug in the reading, not an
  // empty document, and saving it would throw the draft away.
  if (!next.replace(/<[^>]+>/g, '').trim() && paper.innerText.trim()) return;
  S.docHtml = next;
  S.docIds = S.send.map((c) => c.id);
  saveDoc();
  // The strip explaining what a draft is only needs to appear once, and not
  // by redrawing the page out from under the cursor.
  if (first) {
    const note = document.createElement('div');
    note.className = 'docnote';
    note.innerHTML = 'Your draft — new cards join the end ' +
      '<button class="link" data-act="docReset">Rebuild</button>';
    paper.parentNode.insertBefore(note, paper);
  }
}

/** Throw the draft away and go back to mirroring the send list. */
function resetDoc() {
  S.docHtml = null;
  S.docIds = [];
  saveDoc();
  renderDoc();
  toast('Rebuilt from the send list');
}

/** Shared between the Read tab and the case converter. */
function previewHtml(elems) {
  return (elems || []).map((e) => {
    const t = esc(runsText(e));
    if (!t.trim()) return '';
    const lvl = LEVEL[e.h] || 0;
    if (lvl === 4) return '<div class="pv-tag">' + t + '</div>';
    if (lvl) return '<div class="pv-head">' + t + '</div>';
    const fs = (e.runs[0] || {}).fs;
    let cls = 'pv-txt';
    if (fs === S.settings.citeSize) cls = 'pv-cite';
    else if (fs === S.settings.fullCiteSize) cls = 'pv-fullcite';
    return '<div class="' + cls + '">' + t + '</div>';
  }).join('');
}

/**
 * A sent block keeps its Heading 4 sections separate so individual cards can be
 * dropped from the speech without re-sending the block. This flattens whatever
 * is still switched on back into a document.
 */
function entryElems(e) {
  const live = (e.parts || []).filter((p) => !p.off);
  if (!live.length) return [];
  const out = [];
  if (e.includeHead && e.head3) out.push(e.head3);
  if (e.pre && e.pre.length) out.push(...e.pre);
  live.forEach((p) => out.push(...p.elems));
  return out;
}

function composerHtml() {
  return '<div class="composer">' +
    '<textarea id="analyticText" rows="3" placeholder="Every line becomes a numbered ' +
      '13pt Heading 4.' + String.fromCharCode(10) + 'Added to the block above it."></textarea>' +
    '<div class="crow">' +
      '<button class="btn key" data-act="analyticSave">Add</button>' +
      '<button class="btn" data-act="analyticCancel">Cancel</button>' +
      '<span class="hint">Ctrl/⌘+Enter to add · Esc to cancel</span>' +
    '</div></div>';
}

function wireComposer() {
  const ta = $('#analyticText');
  if (!ta) return;
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); saveAnalytic(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); S.addingTo = null; renderSide(); }
    ev.stopPropagation();
  });
  ta.focus();
}

function saveAnalytic() {
  const ta = $('#analyticText');
  if (!ta) return;

  const last = S.send[S.send.length - 1];
  const target = (S.addingTo === -1) ? last : S.send[S.addingTo];
  const part = analyticPart(ta.value, target ? nextArgNumber(target.parts) : 1);
  if (!part) { S.addingTo = null; renderSide(); return; }

  if (S.addingTo === -1 && last) {
    // An analytic said after a card belongs with that card, so it joins the
    // block it follows rather than becoming a row of its own.
    last.parts.push(part);
  } else if (S.addingTo === -1 || !S.send[S.addingTo]) {
    S.send.push({
      id: uid('snt'),
      blockId: null,
      title: part.title,
      trigger: 'analytic',
      analytic: true,
      head3: null,
      pre: [],
      includeHead: false,
      open: false,
      parts: [part]
    });
  } else {
    S.send[S.addingTo].parts.push(part);
  }

  S.addingTo = null;
  persistSend();
  renderSide();
  toast('Analytic added');
}

function persistSend() { DB.set('kv', 'send', S.send).catch(() => {}); }

/** Send lists saved by an earlier version stored one flat element array. */
function normalizeSend(list) {
  return (list || []).map((e) => {
    if (e.parts) return e;
    return {
      id: e.id || uid('snt'),
      blockId: e.blockId || null,
      title: e.title,
      trigger: e.trigger,
      head3: null,
      pre: [],
      includeHead: false,
      open: false,
      parts: [{ id: uid('prt'), title: e.title, elems: e.elems || [] }]
    };
  });
}

function buildReadElements() {
  const all = [];
  S.send.forEach((c) => { all.push(...entryElems(c)); });
  return readFromElements(all);
}

/* ====================================================================
   8. Actions
   ==================================================================== */

let toastTimer = null;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast on' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, bad ? 6000 : 2400);
}

function runSearch() {
  const prev = {};
  S.results.forEach((r) => { if (r.expanded) prev[r.entry.id] = true; });
  S.query = String($('#q').value || '').replace(/^\/+/, '').trim();
  S.results = search($('#q').value, S.index, {
    sens: S.settings.sens, max: S.settings.max, args: S.settings.args
  });
  S.results.forEach((r) => { r.expanded = !!prev[r.entry.id]; });
  S.sel = -1;
  renderResults();
}

function move(d) {
  if (!S.flat.length) return;
  S.sel = Math.min(S.flat.length - 1, Math.max(0, S.sel + d));
  renderResults();
}

function expand(open) {
  const f = S.flat[S.sel];
  if (!f) return;
  if (f.t === 'group') {
    if (S.query) return;
    if (open === undefined || open === !S.collapsed[f.gk]) toggleGroup(f.gk);
    else { S.collapsed[f.gk] = !open; saveCollapsed(); renderResults(); }
    return;
  }
  const r = S.results[f.ri];
  if (!r) return;
  if (open === false && f.t === 'arg') {
    r.expanded = false;
    S.expanded[r.entry.id] = false;
    S.sel = S.flat.findIndex((x) => x.t === 'block' && x.ri === f.ri);
  } else {
    r.expanded = open === undefined ? !r.expanded : open;
    S.expanded[r.entry.id] = r.expanded;
  }
  renderResults();
}

async function sendSelected() {
  const f = S.flat[S.sel];
  if (!f) return;
  if (f.t === 'group') { toggleGroup(f.gk); return; }
  const r = S.results[f.ri];
  if (!r) return;
  await sendBlock(r.entry, f.t === 'arg' ? f.ai : null);
}

async function sendBlock(entry, argIndex) {
  let block;
  try { block = await DB.get('blocks', entry.id); }
  catch (e) { return toast('Could not read the library: ' + e.message, true); }
  if (!block) return toast('That block is missing — re-import.', true);

  const single = (argIndex !== null && argIndex !== undefined && argIndex >= 0);
  const args = single ? [block.args[argIndex]].filter(Boolean) : (block.args || []);

  const parts = args.map((a) => ({
    id: uid('prt'),
    title: a.title || '(untitled)',
    elems: (a.head ? [a.head] : []).concat(a.body || [])
  }));
  if (!parts.length && (block.pre || []).length) {
    parts.push({ id: uid('prt'), title: block.title, elems: block.pre.slice() });
  }
  if (!parts.length) return toast('That block is empty.', true);

  const item = {
    id: uid('snt'),
    blockId: block.id,
    title: block.title,
    trigger: block.trigger,
    head3: block.head || null,
    pre: single ? [] : (block.pre || []),
    includeHead: !!S.settings.head,
    open: false,
    parts
  };

  try { await copyRich(entryElems(item)); }
  catch (e) { return toast(e.message, true); }

  S.send.push(item);
  persistSend();
  renderSide();
  toast('Copied — press Ctrl+V in your Send doc');
  $('#q').value = '';
  runSearch();
}

/** The send document: every block still switched on, in order, with a gap. */
function buildSendElements() {
  const all = [];
  let blocks = 0, cards = 0;
  S.send.forEach((c) => {
    const els = entryElems(c);
    if (!els.length) return;
    blocks++;
    cards += (c.parts || []).filter((p) => !p.off).length;
    all.push(...els, { k: 'p', h: 'P', runs: [] });
  });
  all.blocks = blocks;
  all.cards = cards;
  return all;
}

async function copySendDoc() {
  // What is on the page is what gets copied, edits and all.
  if (S.docHtml !== null) {
    const paper = $('#docbody .paper');
    const html = paper ? flatten(paper) : S.docHtml;
    const text = paper ? paper.innerText : html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return toast('The document is empty.', true);
    try {
      await copyMarkup('<meta charset="utf-8">' + forPaste(html), text);
      toast('Send document copied — your edited version');
    } catch (e) { toast(e.message, true); }
    return;
  }

  const all = buildSendElements();
  const blocks = all.blocks, cards = all.cards;
  if (!all.length) return toast('Nothing sent yet.', true);
  try {
    await copyRich(all);
    toast('Send document copied — ' + cards + ' card' + (cards === 1 ? '' : 's') +
          ' from ' + blocks + ' block' + (blocks === 1 ? '' : 's'));
  } catch (e) { toast(e.message, true); }
}

async function copyReadDoc() {
  const elems = buildReadElements();
  if (!elems.length) return toast('Nothing to read yet.', true);
  try { await copyRich(elems); toast('Read document copied'); }
  catch (e) { toast(e.message, true); }
}

/* ------------------------------------------------------ deleting things
   Cards already sent keep their own copy of the elements, so pruning the
   library never disturbs a round in progress. */

function bareIndex() {
  return S.index.map((e) => ({
    id: e.id, t: e.t, g: e.g, c1: e.c1, c2: e.c2, a: e.a, n: e.n, lk: e.lk
  }));
}

async function persistLibrary() {
  S.meta = Object.assign({}, S.meta, {
    count: S.index.length,
    argCount: S.index.reduce((n, e) => n + (e.n || 0), 0)
  });
  await DB.set('kv', 'index', bareIndex());
  await DB.set('kv', 'meta', S.meta);
  renderStat();
  runSearch();
}

async function deleteBlock(id, quiet) {
  const entry = S.index.find((e) => e.id === id);
  if (!entry) return;
  await DB.del('blocks', id);
  S.index = S.index.filter((e) => e.id !== id);
  await persistLibrary();
  if (!quiet) toast('Deleted “' + entry.t + '” from the library');
}

async function deleteArgument(id, ai) {
  const block = await DB.get('blocks', id);
  if (!block || !block.args[ai]) return;
  const name = block.args[ai].title;

  block.args.splice(ai, 1);
  if (!block.args.length) {
    await deleteBlock(id, true);
    toast('Deleted the last argument, so “' + name + '” went with it');
    return;
  }

  await DB.set('blocks', id, block);
  const entry = S.index.find((e) => e.id === id);
  if (entry) {
    entry.a = block.args.map((a) => a.title);
    entry._a = entry.a.map((x) => String(x || '').toLowerCase());
    entry.n = block.args.length;
  }
  await persistLibrary();
  toast('Deleted “' + name + '”');
}

/**
 * Delete every block filed under one category path.
 *
 * A whole side of the topic usually arrives in one import, so it usually has to
 * leave the same way — otherwise switching topics means clicking × two hundred
 * times.
 */
async function deleteGroup(key) {
  const doomed = S.index.filter((e) => groupKeyOf(e) === key);
  if (!doomed.length) return;

  for (const e of doomed) {
    try { await DB.del('blocks', e.id); } catch (err) { /* already gone */ }
  }

  const gone = {};
  doomed.forEach((e) => { gone[e.id] = true; });
  S.index = S.index.filter((e) => !gone[e.id]);

  delete S.collapsed[key];
  saveCollapsed();
  await persistLibrary();

  toast('Deleted ' + doomed.length + ' block' + (doomed.length === 1 ? '' : 's') +
        ' from “' + key + '”');
}

/** Shared by the header button and the Delete key. */
function confirmDeleteGroup(key) {
  const g = S.groups.filter((x) => x.key === key)[0];
  const blocks = g ? g.rows.length : 0;
  const cards = g ? g.cards : 0;
  if (!blocks) return;
  if (confirm('Delete all ' + blocks + ' block' + (blocks === 1 ? '' : 's') +
              ' filed under “' + key + '”?\n\n' +
              'That is ' + cards + ' card' + (cards === 1 ? '' : 's') + '. ' +
              'Your evidence document and any .json export are untouched.')) {
    deleteGroup(key);
  }
}

function deleteSelected() {
  const f = S.flat[S.sel];
  if (!f) return;
  if (f.t === 'group') { confirmDeleteGroup(f.gk); return; }
  const r = S.results[f.ri];
  if (!r) return;
  if (f.t === 'arg') {
    const name = (r.entry.a || [])[f.ai] || 'this argument';
    if (confirm('Delete the argument “' + name + '” from your library?')) deleteArgument(r.entry.id, f.ai);
  } else {
    const n = r.entry.n;
    if (confirm('Delete “' + r.entry.t + '” and its ' + n + ' argument' + (n === 1 ? '' : 's') +
                ' from your library?\n\nYour source document is not touched.')) {
      deleteBlock(r.entry.id);
    }
  }
}

/* ---------------------------------------------------------- library IO */

/** Why an import found nothing — the two cases need different advice. */
function importProblem(stats) {
  return stats.headings
    ? 'Found headings, but none at level 3. Evidence blocks must be Heading 3 and arguments Heading 4.'
    : 'No headings at all. Your evidence file needs the real Heading 3 / Heading 4 styles — bold or enlarged text is not a heading.';
}

/** Identity of a block across imports: where it sits plus what it is called. */
function blockKey(b) { return [b.cat1 || '', b.cat2 || '', b.title || ''].join('|'); }
function entryKey(e) { return [e.c1 || '', e.c2 || '', e.t || ''].join('|'); }

function indexEntry(b) {
  return {
    id: b.id, t: b.title, g: b.trigger, c1: b.cat1, c2: b.cat2,
    a: b.args.map((x) => x.title), n: b.args.length, lk: !!b.locked
  };
}

/** Give every entry a distinct trigger, leaving earlier ones alone. */
function dedupeIndex(index) {
  const seen = {};
  index.forEach((e) => {
    const base = e.g || 'block';
    let t = base, n = 2;
    while (seen[t]) t = base + ' ' + n++;
    seen[t] = true;
    e.g = t;
  });
  return index;
}

/**
 * Merge freshly parsed blocks into the library.
 *
 * Importing adds; it does not wipe what is already there. A block that matches
 * one already in the library — same category path and title — is updated in
 * place and keeps its id, so re-pasting an edited file refreshes those blocks
 * without disturbing anything else and without duplicating them.
 */
async function ingest(html, opts) {
  const t0 = performance.now();
  const replace = !!(opts && opts.replace);
  const { blocks, stats } = parseHtml(html, { stripAT: S.settings.stripAT });

  if (!blocks.length) throw new Error(importProblem(stats));

  const existing = replace ? [] : S.index.slice();
  const byKey = {};
  existing.forEach((e) => { byKey[entryKey(e)] = e; });

  let updated = 0;
  blocks.forEach((b) => {
    const prev = byKey[blockKey(b)];
    if (!prev) return;
    b.id = prev.id;                    // keep the id: send lists stay valid
    if (prev.lk) { b.trigger = prev.g; b.locked = true; }
    updated++;
  });

  const incoming = {};
  blocks.forEach((b) => { incoming[blockKey(b)] = b; });

  const index = [];
  existing.forEach((e) => {
    const k = entryKey(e);
    if (incoming[k]) { index.push(indexEntry(incoming[k])); delete incoming[k]; }
    else index.push(e);
  });
  Object.keys(incoming).forEach((k) => index.push(indexEntry(incoming[k])));
  dedupeIndex(index);

  if (replace) await DB.clear('blocks');
  await DB.putMany('blocks', blocks.map((b) => [b.id, b]));

  const added = blocks.length - updated;
  const meta = {
    count: index.length,
    argCount: index.reduce((n, e) => n + (e.n || 0), 0),
    built: new Date().toISOString(),
    name: null,
    stats
  };

  await DB.set('kv', 'index', index);
  await DB.set('kv', 'meta', meta);

  S.index = prepare(index);
  S.meta = meta;
  renderStat();
  runSearch();
  return { meta, added, updated, ms: Math.round(performance.now() - t0) };
}

async function exportLibrary() {
  const blocks = [];
  for (const e of S.index) {
    const b = await DB.get('blocks', e.id);
    if (b) blocks.push(b);
  }
  const payload = { format: 'evidence.html/v1', meta: S.meta, settings: S.settings, blocks };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'evidence-library.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Exported ' + blocks.length + ' blocks');
}

async function importLibraryFile(file, opts) {
  const replace = !!(opts && opts.replace);
  const payload = JSON.parse(await file.text());
  if (!payload.blocks) throw new Error('That file is not an evidence library export.');

  const existing = replace ? [] : S.index.slice();
  const byKey = {};
  existing.forEach((e) => { byKey[entryKey(e)] = e; });

  let updated = 0;
  payload.blocks.forEach((b) => {
    const prev = byKey[blockKey(b)];
    if (prev) { b.id = prev.id; updated++; }
  });

  const incoming = {};
  payload.blocks.forEach((b) => { incoming[blockKey(b)] = b; });

  const index = [];
  existing.forEach((e) => {
    const k = entryKey(e);
    if (incoming[k]) { index.push(indexEntry(incoming[k])); delete incoming[k]; }
    else index.push(e);
  });
  Object.keys(incoming).forEach((k) => index.push(indexEntry(incoming[k])));
  dedupeIndex(index);

  if (replace) await DB.clear('blocks');
  await DB.putMany('blocks', payload.blocks.map((b) => [b.id, b]));

  const meta = {
    count: index.length,
    argCount: index.reduce((n, e) => n + (e.n || 0), 0),
    built: new Date().toISOString()
  };

  await DB.set('kv', 'index', index);
  await DB.set('kv', 'meta', meta);
  if (replace && payload.settings) { S.settings = Object.assign({}, DEFAULTS, payload.settings); saveSettings(); }

  S.index = prepare(index);
  S.meta = meta;
  renderStat();
  runSearch();
  toast((payload.blocks.length - updated) + ' added, ' + updated + ' updated — ' +
        index.length + ' blocks in the library');
}

/* ====================================================================
   8b. The formatter
   --------------------------------------------------------------------
   A block file and a send document are not the same document. The file is
   written to be complete: every answer anyone might want, analytics you
   would only read if the round went that way, headings named for how you
   find them rather than for how they are read, and a page of white space
   between blocks from a hundred edits.

   What the other team gets should be what is being read, in the order it is
   read, under a title that says who sent it. That is a handful of mechanical
   edits, done by hand, at speed, immediately before the round -- which is
   exactly when a mistake costs the most. So they are asked as questions and
   done in one pass.
   ==================================================================== */

const SPEECHES = ['1AC', '1NC', '2AC', '2NC', '1AR', '1NR', '2NR', '2AR'];

/** "1. " or "3) " at the start of an argument. */
const ARG_NUM = /^\s*\d+\s*[.)]\s*/;

/** A block's own heading: the thing you search for, not an argument in it. */
const isBlockHead = (e) => { const l = LEVEL[e.h] || 0; return l >= 1 && l <= 3; };

/**
 * The start of an argument: a Heading 4, which is what a cut file uses, or a
 * numbered line set bold, which is what an analytic typed straight into the
 * document looks like.
 */
const isTagline = (e) => (LEVEL[e.h] || 0) === 4 ||
  (ARG_NUM.test(runsText(e)) && (e.runs || []).some((r) => r.b));

/**
 * Does this argument have a card under it?
 *
 * Highlighting settles it -- nobody highlights an analytic. Failing that, a
 * card is a cite and a body, so two paragraphs of real length count too. An
 * argument with nothing under it is an analytic, which is the case that
 * matters: those are the ones you are deciding whether to send.
 */
const hasCard = (body) => body.some(hasHl) ||
  body.filter((e) => runsText(e).trim().length > 40).length >= 2;

/** "LS---2AC---Greenhill", from whichever of the three were answered. */
function docTitle(s) {
  return [s.fmtCode, s.fmtSpeech, s.fmtTourn].map((x) => String(x || '').trim()).filter(Boolean).join('---');
}

function withNumber(head, n) {
  const out = clone(head);
  const runs = out.runs || [];
  const first = runs.find((r) => (r.t || '').trim());
  if (!first) return out;
  first.t = first.t.replace(/^\s*/, '').replace(ARG_NUM, '');
  first.t = n + '. ' + first.t;
  return out;
}

/**
 * The speech goes on the end of the heading -- "AT: Maiese---2AC" -- because
 * the first thing about a heading is what it answers. Sorted, searched or
 * skimmed, the name you are looking for is the one that should be in front.
 */
function withTag(head, speech) {
  const out = clone(head);
  const runs = out.runs || [];
  const last = [...runs].reverse().find((r) => (r.t || '').trim());
  if (!last) return out;
  const tail = '---' + speech;
  if (runsText(out).trim().slice(-tail.length) === tail) return out;   // already done
  last.t = last.t.replace(/\s+$/, '') + tail;
  return out;
}

/**
 * Run the document through the answers. Returns the new elements and a count
 * of what was done to them, because a formatter that silently deletes half a
 * document is not one anyone should trust twice.
 */
function formatElements(src, o) {
  const out = [];
  const tally = { blocks: 0, kept: 0, dropped: 0, blanks: 0, pages: 0 };
  const title = o.title ? String(o.title).trim() : '';
  if (title) {
    out.push({ k: 'p', h: 'H1', al: 'center', runs: [{ t: title, b: true, fs: 26 }] });
    if (o.pages) { out.push({ k: 'brk' }); tally.pages++; }
  }

  let arg = null;
  let n = 0;
  let firstBlock = true;

  const flush = () => {
    if (!arg) return;
    const card = hasCard(arg.body);
    if (o.drop && !card) { tally.dropped++; arg = null; return; }
    n++;
    tally.kept++;
    out.push(o.renumber ? withNumber(arg.head, n) : arg.head);
    arg.body.forEach((e) => out.push(e));
    arg = null;
  };

  (src || []).forEach((e) => {
    // Formatting twice is normal -- you send another card and run it again --
    // so the cover this pass is about to write is dropped from what came in.
    if (title && runsText(e).trim() === title) return;
    if (!runsText(e).trim() && !isBlockHead(e)) {
      if (o.tidy) { tally.blanks++; return; }
      if (arg) { arg.body.push(e); return; }
      out.push(e);
      return;
    }
    if (isBlockHead(e)) {
      flush();
      n = 0;
      tally.blocks++;
      // The cover already broke the page for the first one.
      if (o.pages && !firstBlock) { out.push({ k: 'brk' }); tally.pages++; }
      firstBlock = false;
      out.push(o.tag && o.speech ? withTag(e, o.speech) : e);
      return;
    }
    if (isTagline(e)) { flush(); arg = { head: e, body: [] }; return; }
    if (arg) { arg.body.push(e); return; }
    out.push(e);
  });
  flush();

  out.tally = tally;
  return out;
}

/** How many arguments in the current send document have no card under them. */
function countAnalytics(elems) {
  let arg = null, n = 0;
  const flush = () => { if (arg && !hasCard(arg.body)) n++; arg = null; };
  (elems || []).forEach((e) => {
    if (isBlockHead(e)) { flush(); return; }
    if (isTagline(e)) { flush(); arg = { head: e, body: [] }; return; }
    if (arg) arg.body.push(e);
  });
  flush();
  return n;
}

/* ====================================================================
   9. Modals
   ==================================================================== */

function closeModal() {
  $('#veil').classList.remove('on');
  $('#card').className = 'card';
  $('#q').focus();
}

function onVeilDown(ev) { if (ev.target === $('#veil')) closeModal(); }

/* ------------------------------------------------------- reordering sends
   The order of the send list is the order of the speech, and the order of a
   speech changes while you are writing it. The arrows move one step at a
   time, which is fine for a nudge and tedious for anything else, so a block
   can also just be picked up and dropped where it belongs. */

let dragFrom = null;

const sentRow = (ev) => (ev.target && ev.target.closest) ? ev.target.closest('.sent') : null;
const clearDrop = () => {
  if (!root) return;
  root.querySelectorAll('.sent.over, .sent.dragging').forEach((e) => e.classList.remove('over', 'dragging'));
};

function onDragStart(ev) {
  const row = sentRow(ev);
  if (!row) return;
  dragFrom = Number(row.dataset.sent);
  row.classList.add('dragging');
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', String(dragFrom)); } catch (e) { /* older browsers */ }
  }
}

function onDragOver(ev) {
  const row = sentRow(ev);
  if (dragFrom === null || !row) return;
  ev.preventDefault();                     // without this the drop never fires
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
  root.querySelectorAll('.sent.over').forEach((e) => e.classList.remove('over'));
  if (Number(row.dataset.sent) !== dragFrom) row.classList.add('over');
}

function onDrop(ev) {
  const row = sentRow(ev);
  if (dragFrom === null || !row) return;
  ev.preventDefault();
  const to = Number(row.dataset.sent);
  if (to !== dragFrom && S.send[dragFrom]) {
    const moved = S.send.splice(dragFrom, 1)[0];
    S.send.splice(to, 0, moved);
    persistSend();
  }
  dragFrom = null;
  clearDrop();
  renderSide();
}

function onDragEnd() { dragFrom = null; clearDrop(); }

function openImport() {
  $('#card').innerHTML =
    '<h2>Import evidence</h2><div class="in">' +
    '<p class="hint">Pasting <b>adds</b> to your library. A block already in there — same ' +
    'category and title — is updated in place rather than duplicated, so re-pasting an ' +
    'edited file just refreshes it.<br><br>' +
    'In Google Docs open your evidence file, press <b>Ctrl/⌘+A</b> then ' +
    '<b>Ctrl/⌘+C</b>. Click the box below and press <b>Ctrl/⌘+V</b>.<br><br>' +
    'The clipboard carries the full formatting — headings, bold, highlights, links — so the ' +
    'library is built from that. Nothing is uploaded and no account access is needed.</p>' +
    '<div id="dropzone" contenteditable="true">Click here, then paste…</div>' +
    '<label class="opt"><input type="checkbox" id="replaceLib">' +
      'Replace the whole library instead of adding to it</label>' +
    '<p class="hint" id="importMsg" style="margin-top:12px"></p>' +
    '</div><div class="out">' +
    '<button class="btn" data-act="loadFile">Load a .json export instead</button>' +
    '<span class="spacer" style="flex:1"></span>' +
    '<button class="btn" data-act="close">Close</button></div>';
  $('#veil').classList.add('on');
  const dz = $('#dropzone');
  dz.focus();

  dz.addEventListener('paste', async (ev) => {
    ev.preventDefault();
    const html = ev.clipboardData.getData('text/html');
    const plain = ev.clipboardData.getData('text/plain');
    if (!html) {
      $('#importMsg').textContent = plain
        ? 'That paste had no formatting — copy from Google Docs itself, not from a plain-text editor.'
        : 'Nothing on the clipboard.';
      return;
    }
    dz.classList.add('full');
    dz.textContent = 'Parsing ' + Math.round(html.length / 1024) + ' KB…';
    $('#importMsg').textContent = '';
    await new Promise((r) => setTimeout(r, 30));
    try {
      const replace = !!($('#replaceLib') && $('#replaceLib').checked);
      const r = await ingest(html, { replace: replace });
      dz.textContent = '';
      closeModal();
      toast(r.added + ' added, ' + r.updated + ' updated — ' + r.meta.count +
            ' blocks in the library (' + r.ms + ' ms)');
    } catch (e) {
      dz.classList.remove('full');
      dz.textContent = 'Click here, then paste…';
      $('#importMsg').innerHTML = '<span style="color:var(--red)">' + esc(e.message) + '</span>';
    }
  });
}

/**
 * Report what is actually in the database.
 *
 * navigator.storage.estimate() is not the answer to "did my delete work": it
 * routinely goes *up* straight after a deletion, because IndexedDB appends the
 * deletions to its log and only reclaims the space when it compacts. Counting
 * the records is the honest measure, so that leads and the browser's figure is
 * shown afterwards, labelled for what it is.
 */
function refreshUsage() {
  const node = $('#usage');
  if (!node) return Promise.resolve();
  return Promise.all([
    DB.count('blocks').catch(() => null),
    DB.count('kv').catch(() => null),
    DB.estimate().catch(() => null)
  ]).then(([blocks, kv, est]) => {
    if (blocks === null) { node.textContent = 'Database unavailable.'; return; }
    const mb = (est && typeof est.usage === 'number')
      ? (est.usage / 1048576).toFixed(1) + ' MB' : null;
    node.innerHTML =
      '<b>' + blocks + '</b> evidence block' + (blocks === 1 ? '' : 's') +
      ' and <b>' + kv + '</b> other record' + (kv === 1 ? '' : 's') + ' in the database.' +
      (mb ? ' Browser reports ' + mb + ' reserved for this page.' : '');
  }).catch(() => { node.textContent = ''; });
}

/* ------------------------------------------------------ case converter */

function openCase() {
  $('#card').className = 'card wide';
  renderCase();
  $('#veil').classList.add('on');
}

function renderCase() {
  const s = S.settings;
  const has = S.caseElems && S.caseElems.length;
  let html = '<h2>Case → speech document</h2>';

  if (!has) {
    html +=
      '<div class="in">' +
        '<p class="hint">Paste a case, a rebuttal block, anything. Paragraphs that ' +
        'carry <b>highlighting</b> are cut down to the highlighted text; paragraphs with ' +
        'none — taglines, analytics, cites — are left exactly as written, because you ' +
        'read those aloud. Nothing here touches your library.</p>' +
        '<div id="casezone" contenteditable="true">Click here, then paste…</div>' +
        '<p class="hint" id="caseMsg" style="margin-top:12px"></p>' +
      '</div>' +
      '<div class="out"><span style="flex:1"></span>' +
      '<button class="btn" data-act="close">Close</button></div>';
  } else {
    const words = wordCount(S.caseElems);
    const src = S.caseWords || 0;
    const cut = src ? Math.max(0, Math.round((1 - words / src) * 100)) : 0;
    html +=
      '<div class="casebar">' +
        '<span class="big">' + words.toLocaleString() + '</span>' +
        '<span class="lbl">words</span>' +
        '<span class="chip good">~' + fmtDuration(words, s.wpm) + ' at ' + s.wpm + ' wpm</span>' +
        '<span class="chip">' + src.toLocaleString() + ' pasted · ' + cut + '% cut</span>' +
      '</div>' +
      '<div class="in"><div class="preview">' + previewHtml(S.caseElems) + '</div></div>' +
      '<div class="out">' +
        '<button class="btn key" data-act="copyCase">Copy speech doc</button>' +
        '<button class="btn" data-act="caseReset">Paste another</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn" data-act="close">Close</button>' +
      '</div>';
  }

  $('#card').innerHTML = html;
  const dz = $('#casezone');
  if (dz) { dz.addEventListener('paste', onCasePaste); dz.focus(); }
}

function onCasePaste(ev) {
  ev.preventDefault();
  const html = ev.clipboardData.getData('text/html');
  const note = $('#caseMsg');
  if (!html) {
    if (note) note.textContent = ev.clipboardData.getData('text/plain')
      ? 'That paste had no formatting — copy from the document itself, not a plain-text editor.'
      : 'Nothing on the clipboard.';
    return;
  }
  let src;
  try { src = elementsFromHtml(html); }
  catch (e) { if (note) note.textContent = e.message; return; }
  if (!src.length) { if (note) note.textContent = 'Nothing readable in that paste.'; return; }

  S.caseWords = wordCount(src);
  S.caseElems = readFromElements(src);
  renderCase();
}

async function copyCaseDoc() {
  if (!S.caseElems || !S.caseElems.length) return;
  try {
    await copyRich(S.caseElems);
    toast('Speech document copied — ' + wordCount(S.caseElems).toLocaleString() + ' words');
  } catch (e) { toast(e.message, true); }
}

/**
 * The questions. Everything here is answered in about ten seconds, which is
 * the point: the alternative is doing the same edits by hand while the other
 * team waits.
 */
function openFormat() {
  const s = S.settings;
  const analytics = countAnalytics(S.docHtml === null ? buildSendElements() : elementsFromHtml(S.docHtml));
  const opt = (k, label, sub) =>
    '<div class="set"><label>' + label + (sub ? '<span class="sub">' + sub + '</span>' : '') +
    '</label><input type="checkbox" data-f="' + k + '"' + (s[k] ? ' checked' : '') + '></div>';

  $('#card').innerHTML =
    '<h2>Format the send document</h2><div class="in">' +
    '<p class="hint">The block file is written to be complete. What the other team gets should be ' +
    'what you are reading, titled, in order, with the white space gone.</p>' +
    '<div class="seth">The title</div>' +
    '<div class="set"><label>Your code<span class="sub">Goes first, as it does on the doc you send</span></label>' +
      '<input type="text" data-f="fmtCode" value="' + esc(s.fmtCode) + '" placeholder="LS"></div>' +
    '<div class="set"><label>Speech</label><select data-f="fmtSpeech">' +
      SPEECHES.map((x) => '<option value="' + x + '"' + (s.fmtSpeech === x ? ' selected' : '') + '>' + x + '</option>').join('') +
      '</select></div>' +
    '<div class="set"><label>Tournament</label>' +
      '<input type="text" data-f="fmtTourn" value="' + esc(s.fmtTourn) + '" placeholder="Greenhill"></div>' +
    '<div class="set"><label>Title<span class="sub">Boxed at the top of the document</span></label>' +
      '<b id="fmtPreview" class="mono">' + esc(docTitle(s) || '(none)') + '</b></div>' +
    '<div class="seth">The document</div>' +
    opt('fmtDrop', 'Delete analytics',
        analytics ? analytics + ' argument' + (analytics === 1 ? ' has' : 's have') + ' no card under ' +
          (analytics === 1 ? 'it' : 'them') + ' — the heading above them stays'
          : 'Nothing in here is an analytic') +
    opt('fmtRenumber', 'Renumber what is left', 'One upwards inside each block') +
    opt('fmtTag', 'Put the speech on each heading', '“AT: Heg good” becomes “AT: Heg good---' + s.fmtSpeech + '”') +
    opt('fmtTidy', 'Take out the empty space', 'Blank paragraphs between blocks and cards') +
    opt('fmtPages', 'A page for each block', 'Shown on the page here — Docs drops page breaks on paste, ' +
        'so put them in with Ctrl+Enter once it is pasted') +
    '</div><div class="out">' +
    '<button class="btn key" data-act="formatRun">Format</button>' +
    '<span style="flex:1"></span>' +
    '<button class="btn" data-act="close">Cancel</button></div>';

  $('#veil').classList.add('on');

  const card = $('#card');
  const read = (el) => {
    const k = el.dataset.f;
    if (!k) return;
    S.settings[k] = el.type === 'checkbox' ? el.checked : el.value;
    saveSettings();
    const pv = $('#fmtPreview');
    if (pv) pv.textContent = docTitle(S.settings) || '(none)';
  };
  card.addEventListener('input', (ev) => read(ev.target));
  card.addEventListener('change', (ev) => read(ev.target));
}

/** Do it, and leave the result in the panel as the draft. */
function runFormat() {
  const s = S.settings;
  const src = S.docHtml === null ? buildSendElements() : elementsFromHtml(S.docHtml);
  if (!src.length) { closeModal(); return toast('Nothing to format yet.', true); }

  const out = formatElements(src, {
    title: docTitle(s),
    speech: s.fmtSpeech,
    drop: !!s.fmtDrop,
    renumber: !!s.fmtRenumber,
    tag: !!s.fmtTag,
    tidy: !!s.fmtTidy,
    pages: !!s.fmtPages,
  });
  const t = out.tally;

  S.docHtml = pageHtml(out);
  S.docIds = S.send.map((c) => c.id);
  saveDoc();
  closeModal();
  renderDoc();

  const bits = [t.blocks + ' block' + (t.blocks === 1 ? '' : 's'), t.kept + ' argument' + (t.kept === 1 ? '' : 's')];
  if (t.dropped) bits.push(t.dropped + ' analytic' + (t.dropped === 1 ? '' : 's') + ' cut');
  if (t.blanks) bits.push(t.blanks + ' blank line' + (t.blanks === 1 ? '' : 's') + ' gone');
  if (t.pages) bits.push(t.pages + ' page break' + (t.pages === 1 ? '' : 's'));
  toast('Formatted — ' + bits.join(', ') + '. Rebuild puts it back.');
}

function openSettings() {
  const s = S.settings;
  const chk = (k, label, sub) =>
    '<div class="set"><label>' + label + (sub ? '<span class="sub">' + sub + '</span>' : '') +
    '</label><input type="checkbox" data-s="' + k + '"' + (s[k] ? ' checked' : '') + '></div>';
  const num = (k, label, min, max, sub) =>
    '<div class="set"><label>' + label + (sub ? '<span class="sub">' + sub + '</span>' : '') +
    '</label><input type="number" data-s="' + k + '" min="' + min + '" max="' + max + '" value="' + s[k] + '"></div>';

  $('#card').innerHTML =
    '<h2>Settings</h2><div class="in">' +
    '<div class="seth">Search</div>' +
    '<div class="set"><label>Fuzzy sensitivity<span class="sub">Left: near-exact · right: loose</span></label>' +
      '<input type="range" data-s="sens" min="0" max="1" step="0.05" value="' + s.sens + '">' +
      '<span class="chip" id="sensVal">' + s.sens.toFixed(2) + '</span></div>' +
    chk('args', 'Also match Heading 4 taglines') +
    num('max', 'Maximum search results', 5, 1000, 'Browsing is never capped') +
    '<div class="seth">Sending</div>' +
    chk('head', 'Include the Heading 3 block title') +
    chk('stripAT', 'Strip “AT:” when generating triggers', 'Applies on the next import') +
    '<div class="seth">Read document</div>' +
    '<div class="set"><label>Citation handling' +
      '<span class="sub">The short cite is whatever you set bold or larger in ' +
      'the cite line — “Hurtshouse 02”. The rest is reference material.</span></label>' +
      '<select data-s="citeStyle">' +
        ['short|Short cite only', 'compact|Short cite, then the full citation small',
          'full|The cite exactly as written']
          .map((o) => { const [v, l] = o.split('|');
            return '<option value="' + v + '"' + (s.citeStyle === v ? ' selected' : '') + '>' + l + '</option>'; })
          .join('') +
      '</select></div>' +
    chk('boldTag', 'Bold the tagline') +
    chk('citeBold', 'Bold the short cite') +
    num('citeSize', 'Short cite size (pt)', 6, 48) +
    num('fullCiteSize', 'Full citation size (pt)', 5, 24, 'Used by the compact style') +
    num('citeLines', 'Cite lines when a card has no highlighting', 0, 6, 'Fallback only') +
    chk('stripHl', 'Remove highlight colour in Read') +
    chk('readHeadings', 'Include Heading 3 titles in Read') +
    num('wpm', 'Reading speed (words per minute)', 80, 400, 'Only affects the time estimate') +
    '<div class="seth">Storage</div>' +
    '<p class="hint" id="usage">checking…</p>' +
    '<p class="hint" style="margin-top:8px">The browser\'s figure can go <b>up</b> ' +
      'right after a delete. IndexedDB records deletions as new entries in its log and ' +
      'only reclaims the space when it compacts — minutes later, or on restart. The ' +
      'record counts above are the real answer.</p>' +
    '</div><div class="out">' +
    '<button class="btn" data-act="wipe">Delete library</button>' +
    '<span style="flex:1"></span>' +
    '<button class="btn key" data-act="close">Done</button></div>';

  $('#veil').classList.add('on');

  refreshUsage();

  $('#card').addEventListener('change', (ev) => {
    if (ev.target.tagName === 'SELECT') ev.target.dispatchEvent(new Event('input', { bubbles: true }));
  });

  $('#card').addEventListener('input', (ev) => {
    const k = ev.target.dataset.s;
    if (!k) return;
    let v;
    if (ev.target.type === 'checkbox') v = ev.target.checked;
    else if (ev.target.tagName === 'SELECT') v = ev.target.value;
    else v = Number(ev.target.value);
    S.settings[k] = v;
    if (k === 'sens') $('#sensVal').textContent = Number(v).toFixed(2);
    saveSettings();
    runSearch();
    renderSide();
  });
}

/* ====================================================================
   10. Events
   ==================================================================== */

async function onClick(ev) {
  const act = ev.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'import') openImport();
    if (a === 'case') openCase();
    if (a === 'copyCase') copyCaseDoc();
    if (a === 'caseReset') { S.caseElems = []; S.caseWords = 0; renderCase(); }
    if (a === 'settings') openSettings();
    if (a === 'export') exportLibrary().catch((e) => toast(e.message, true));
    if (a === 'close') closeModal();
    if (a === 'copySend') copySendDoc();
    if (a === 'groups') toggleAllGroups();
    if (a === 'addAnalytic') { S.addingTo = -1; renderSide(); }
    if (a === 'analyticSave') saveAnalytic();
    if (a === 'analyticCancel') { S.addingTo = null; renderSide(); }
    if (a === 'copyRead') copyReadDoc();
    if (a === 'docReset') resetDoc();
    if (a === 'format') openFormat();
    if (a === 'formatRun') runFormat();
    if (a === 'clearSend') {
      if (S.send.length && confirm('Clear the ' + S.send.length + ' sent card(s)?')) {
        S.send = [];
        S.docHtml = null;
        S.docIds = [];
        DB.set('kv', 'send', S.send).catch(() => {});
        saveDoc();
        renderSide();
      }
    }
    if (a === 'wipe') {
      if (!confirm('Delete the whole library from this browser?\n\n' +
                   'This drops the database itself, not just its contents, and clears the ' +
                   'send list too. Your evidence document and any .json export are untouched.')) return;
      try {
        await DB.destroy();
        S.index = [];
        S.meta = null;
        S.send = [];
        renderStat();
        runSearch();
        renderSide();
        await refreshUsage();
        toast('Library deleted');
      } catch (e) {
        toast('Could not delete the library: ' + e.message, true);
      }
    }
    if (a === 'loadFile') {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = () => {
        if (inp.files[0]) {
          const replace = !!($('#replaceLib') && $('#replaceLib').checked);
          importLibraryFile(inp.files[0], { replace: replace }).then(closeModal).catch((e) => {
            $('#importMsg').innerHTML = '<span style="color:var(--red)">' + esc(e.message) + '</span>';
          });
        }
      };
      inp.click();
    }
    return;
  }

  const tab = ev.target.closest('[data-tab]');
  if (tab) { S.tab = tab.dataset.tab; renderSide(); return; }

  const del = ev.target.closest('[data-del]');
  if (del) {
    ev.stopPropagation();
    const r = S.results[Number(del.dataset.del)];
    if (r && confirm('Delete “' + r.entry.t + '” and its ' + r.entry.n + ' argument' +
                     (r.entry.n === 1 ? '' : 's') + ' from your library?\n\n' +
                     'Your source document is not touched.')) {
      deleteBlock(r.entry.id);
    }
    return;
  }

  const delArg = ev.target.closest('[data-delarg]');
  if (delArg) {
    ev.stopPropagation();
    const [ri, ai] = delArg.dataset.delarg.split(':').map(Number);
    const r = S.results[ri];
    const name = r && (r.entry.a || [])[ai];
    if (r && confirm('Delete the argument “' + (name || '') + '” from your library?')) {
      deleteArgument(r.entry.id, ai);
    }
    return;
  }

  const delGrp = ev.target.closest('[data-delgrp]');
  if (delGrp) {
    ev.stopPropagation();
    confirmDeleteGroup(delGrp.dataset.delgrp);
    return;
  }

  const grp = ev.target.closest('[data-grp]');
  if (grp) { toggleGroup(grp.dataset.grp); return; }

  const openBtn = ev.target.closest('[data-open]');
  if (openBtn) {
    const i = Number(openBtn.dataset.open);
    if (S.send[i]) S.send[i].open = !S.send[i].open;
    renderSide();
    return;
  }

  const partBtn = ev.target.closest('[data-part]');
  if (partBtn) {
    const [i, pi] = partBtn.dataset.part.split(':').map(Number);
    const item = S.send[i];
    if (!item) return;
    item.parts.splice(pi, 1);
    if (!item.parts.length) S.send.splice(i, 1);
    persistSend();
    renderSide();
    return;
  }

  const headBtn = ev.target.closest('[data-head]');
  if (headBtn) {
    const i = Number(headBtn.dataset.head);
    if (S.send[i]) S.send[i].includeHead = !S.send[i].includeHead;
    persistSend();
    renderSide();
    return;
  }

  const addPart = ev.target.closest('[data-addpart]');
  if (addPart) {
    S.addingTo = Number(addPart.dataset.addpart);
    renderSide();
    return;
  }

  const mv = ev.target.closest('[data-mv]');
  if (mv) {
    const [i, d] = mv.dataset.mv.split(':').map(Number);
    const j = i + d;
    if (j >= 0 && j < S.send.length) {
      const moved = S.send.splice(i, 1)[0];
      S.send.splice(j, 0, moved);
      persistSend();
      renderSide();
    }
    return;
  }

  const drop = ev.target.closest('[data-drop]');
  if (drop) {
    S.send.splice(Number(drop.dataset.drop), 1);
    persistSend();
    renderSide();
    return;
  }

  const row = ev.target.closest('[data-ri]');
  if (row) {
    const ri = Number(row.dataset.ri);
    const ai = row.dataset.ai !== undefined ? Number(row.dataset.ai) : null;
    if (S.results[ri]) sendBlock(S.results[ri].entry, ai);
  }
}

function onQueryInput(ev) {
  const el = ev.target;
  if (el.value[0] === '/') el.value = el.value.slice(1);
  runSearch();
}

function onQueryKey(ev) {
  switch (ev.key) {
    case 'ArrowDown': ev.preventDefault(); move(1); break;
    case 'ArrowUp': ev.preventDefault(); move(-1); break;
    case 'ArrowRight':
      if (ev.target.selectionStart === ev.target.value.length) { ev.preventDefault(); expand(true); }
      break;
    case 'ArrowLeft':
      if (ev.target.selectionStart === 0) { ev.preventDefault(); expand(false); }
      break;
    case 'Tab': ev.preventDefault(); expand(); break;
    case 'Enter': ev.preventDefault(); sendSelected(); break;
    case 'Backspace':
      // Plain backspace still edits the query; only the modifier deletes.
      if (ev.metaKey || ev.ctrlKey) { ev.preventDefault(); deleteSelected(); }
      break;
    case 'Delete': ev.preventDefault(); deleteSelected(); break;
    case 'Escape': ev.preventDefault(); ev.target.value = ''; runSearch(); break;
  }
}

function onDocKey(ev) {
  if (ev.key === 'Escape' && $('#veil').classList.contains('on')) { closeModal(); return; }
  if (ev.target.tagName === 'INPUT' || ev.target.isContentEditable) return;
  if (ev.key === '/') { ev.preventDefault(); $('#q').focus(); $('#q').select(); }
}

/* ====================================================================
   11. Debug handle
   --------------------------------------------------------------------
   `const` declarations don't land on window, so state is exposed here
   deliberately — for the test suite, and for poking at the library from
   the browser console (EV.state.index, EV.state.send, ...).
   ==================================================================== */


/* ====================================================================
   12. Boot
   ==================================================================== */

async function start() {
  loadSettings();
  try {
    const [index, meta, send, doc] = await Promise.all([
      DB.get('kv', 'index'), DB.get('kv', 'meta'), DB.get('kv', 'send'), DB.get('kv', 'doc')
    ]);
    S.index = prepare(index || []);
    S.meta = meta || null;
    S.send = normalizeSend(send);
    if (doc && typeof doc.html === 'string') { S.docHtml = doc.html; S.docIds = doc.ids || []; }
  } catch (e) {
    toast('Storage unavailable — the library will not persist. ' + e.message, true);
  }
  renderStat();
  renderSide();
  runSearch();
  $('#q').focus();
  if (!S.index.length) openTimer = setTimeout(openImport, 400);
}


/* ====================================================================
   12. Mounting
   ==================================================================== */

/**
 * Attach the tool to `el`, which must already contain the markup, and return
 * the function that detaches it. The document-level key handler is the only
 * listener that reaches outside, and it is removed with the rest.
 */
export function boot(el) {
  root = el;
  const offs = [];
  const bind = (target, type, fn) => {
    if (!target) return;
    target.addEventListener(type, fn);
    offs.push(() => target.removeEventListener(type, fn));
  };

  bind(root, 'click', onClick);
  bind(root, 'input', onDocInput);
  bind(root, 'dragstart', onDragStart);
  bind(root, 'dragover', onDragOver);
  bind(root, 'drop', onDrop);
  bind(root, 'dragend', onDragEnd);
  bind($('#veil'), 'mousedown', onVeilDown);
  bind($('#q'), 'input', onQueryInput);
  bind($('#q'), 'keydown', onQueryKey);
  bind(document, 'keydown', onDocKey);

  // `const` declarations don't land on window, so state is exposed here
  // deliberately — for poking at the library from the browser console
  // (EV.state.index, EV.state.send, ...).
  window.EV = {
  state: S,
  DB, ingest, parseHtml, blockToElements, toHtml, toCards, readElements,
  search, prepare, buildReadElements, importProblem,
  deleteBlock, deleteArgument, formatCite, highlightOnly, shortCiteRuns, keepRuns,
  splitCite, refreshUsage, entryElems, normalizeSend, importLibraryFile, indexEntry,
  buildGroups, groupKeyOf, groupOpen, toggleGroup, toggleAllGroups, deleteGroup,
  analyticPart, saveAnalytic, nextArgNumber,
  wordCount, fmtDuration, readFromElements, readSegment, elementsFromHtml, previewHtml,
  renderCase, openCase, copyCaseDoc, renderDoc, buildSendElements, resetDoc, copySendDoc,
  formatElements, countAnalytics, docTitle, openFormat, runFormat, sheetsFrom, flatten
  };

  start();

  return () => {
    offs.forEach((f) => f());
    clearTimeout(toastTimer);
    clearTimeout(openTimer);
    clearTimeout(docTimer);
    root = null;
  };
}
