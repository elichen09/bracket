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

import { scoped, adoptLocal } from '../owner';
import { makeSendItem } from './sendItem';
import { mountCaselist } from './caselist';
import { openBus } from '../toolsBus';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { yXmlFragmentToProseMirrorRootNode, prosemirrorToYXmlFragment } from 'y-prosemirror';
import { DOMParser as PMDOMParser, DOMSerializer } from 'prosemirror-model';
import { schema as docSchema } from './docSchema';
import { openRoom as openYRoom, MATE_COLORS } from '../docflow/room';
import { joinFlow } from '../flow/share';

/** The line to Flow, when it is open in another tab. Set by boot(). */
let BUS = null;
/** The signed-in account's name, which a partner sees on the shared send doc. */
let OWNER_NAME = '';

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
      // A page break is not a block of text, so it is announced as itself: a
      // null node. What that means is the caller's business — the library
      // ignores it, the .docx writes a real break.
      if (tag === 'HR') { cb(null, listCtx); continue; }
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
    if (!node) return;                       // a page break is not evidence
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
    if (!node) { out.push({ k: 'brk' }); return; }
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
 * Two things a run cannot say:
 *
 *   bd   the rule round a cover title. Written inline, because a paste has no
 *        stylesheet to consult; kept off everything else, because a border is
 *        not something a heading should acquire by being one.
 *   brk  a page break. Docs throws these away on paste, whatever they are
 *        written as, so this one is for the page on screen and for the .docx,
 *        where a break is a break; `forPaste` takes it out again before
 *        anything reaches the clipboard, since what Docs does keep is the
 *        horizontal rule, and a stray line is worse than no break at all.
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
    if (e.bd) css.push('border:4px solid #333333;padding:8pt 12pt');
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

const LEGACY_DB = 'evidence';

const DB = (() => {
  let dbp = null;
  let conn = null;
  // Each account has a database of its own (see lib/owner.ts); boot() says
  // whose before anything is read.
  let name = LEGACY_DB;

  function use(next) {
    if (next === name) return;
    if (conn) { try { conn.close(); } catch (e) { /* already closed */ } }
    name = next;
    dbp = null;
    conn = null;
  }

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      let made = false;
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        made = true;
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('blocks')) db.createObjectStore('blocks');
      };
      req.onsuccess = async () => {
        conn = req.result;
        // A database made just now for an account: bring over the library that
        // was stored before libraries belonged to anyone. Only ever at creation,
        // so it happens once per account, and the first account empties it.
        if (made && name !== LEGACY_DB) { try { await adopt(conn); } catch (e) { /* start empty */ } }
        resolve(conn);
      };
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  /** Copy the shared library into this account's database, then empty it. */
  function adopt(into) {
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(LEGACY_DB, 1); } catch (e) { resolve(); return; }
      // An upgrade means there was no old database; abandon it rather than
      // create an empty one.
      req.onupgradeneeded = () => { try { req.transaction.abort(); } catch (e) { /* gone */ } };
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
      req.onsuccess = () => {
        const old = req.result;
        const done = () => { try { old.close(); } catch (e) { /* closed */ } resolve(); };
        const stores = ['kv', 'blocks'].filter((s) => old.objectStoreNames.contains(s));
        if (!stores.length) { done(); return; }
        const read = old.transaction(stores, 'readonly');
        const got = {};
        stores.forEach((s) => { const st = read.objectStore(s); got[s] = { k: st.getAllKeys(), v: st.getAll() }; });
        read.onerror = done;
        read.oncomplete = () => {
          if (!stores.some((s) => got[s].k.result.length)) { done(); return; }
          const write = into.transaction(stores, 'readwrite');
          stores.forEach((s) => {
            const st = write.objectStore(s);
            got[s].k.result.forEach((key, i) => st.put(got[s].v.result[i], key));
          });
          write.onerror = done;
          write.oncomplete = () => {
            // Emptied rather than deleted, for the reason given at destroy().
            const wipe = old.transaction(stores, 'readwrite');
            stores.forEach((s) => wipe.objectStore(s).clear());
            wipe.oncomplete = done;
            wipe.onerror = done;
          };
        };
      };
    });
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
    use,
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
  docText: '',
  docIds: [],
  /**
   * Bins: piles the library is sorted into — Aff, Neg, the old topic — each
   * of which can be in this round or out of it. `of` files a block by its
   * address (pocket | hat | title), so re-importing a file keeps every block
   * in its bin; a block in no bin is Unsorted, which can be left out too.
   */
  bins: { list: [], of: {}, loose: true }
};

/** The signed-in account, set by boot(); every stored name carries it. */
let OWNER = null;
/** The caselist source, while this is mounted (lib/evidence/caselist.js). */
let CL = null;

function loadSettings() {
  try {
    const raw = adoptLocal('evidence.settings', OWNER);
    if (raw) S.settings = Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch (e) { /* first run */ }
  try {
    const c = adoptLocal('evidence.collapsed', OWNER);
    if (c) S.collapsed = JSON.parse(c) || {};
  } catch (e) { /* first run */ }
}

function saveCollapsed() {
  try { localStorage.setItem(scoped('evidence.collapsed', OWNER), JSON.stringify(S.collapsed)); } catch (e) {}
}
function saveSettings() {
  try { localStorage.setItem(scoped('evidence.settings', OWNER), JSON.stringify(S.settings)); } catch (e) {}
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

const UNFILED = 'Uncategorised';

/** The pocket a block sits in — the first heading level, the file itself. */
const tidyName = (x) => String(x || '').replace(/[\s\u200b\u00a0\ufeff]+/g, ' ').trim();
function pocketKeyOf(e) { return tidyName(e.c1) || UNFILED; }

/** The hat below it, written as a path, which is also its fold key. */
function groupKeyOf(e) {
  return [tidyName(e.c1), tidyName(e.c2)].filter(Boolean).join(' › ') || UNFILED;
}

/** A search must never hide a hit, so a query forces every group open. */
function groupOpen(key) {
  return S.query ? true : !S.collapsed[key];
}

/**
 * Tags show under their block unless they have been folded away — except in a
 * library big enough that drawing every tag on every keystroke would be felt,
 * where they wait to be asked for instead.
 */
const TAGS_SHOWN_UP_TO = 600;
function argsOpen(r) {
  const known = S.expanded[r.entry.id];
  if (known !== undefined) return known;
  return S.index.length <= TAGS_SHOWN_UP_TO;
}

/**
 * The library as the outline it was written as.
 *
 * A cut file is a document with a shape — pocket, hat, block, tag — and the
 * only place a debater normally sees that shape whole is the outline pane of
 * the editor it was written in. So this builds the same thing: the pockets in
 * the order they appear, each holding its hats and any blocks filed straight
 * underneath, in document order. A flat list with the address printed beside
 * every row said the same thing in more words.
 */
function buildTree() {
  const pockets = [];
  const byPocket = {};
  S.results.forEach((r, ri) => {
    const e = r.entry;
    const pk = pocketKeyOf(e);
    let p = byPocket[pk];
    if (!p) {
      p = byPocket[pk] = { key: pk, label: pk, kids: [], hats: {}, rows: [], cards: 0 };
      pockets.push(p);
    }
    p.rows.push(ri);
    p.cards += (e.n || 0);

    if (!tidyName(e.c2)) { p.kids.push({ k: 'block', ri: ri }); return; }

    // The hat's key is the path, which is what the fold state and a category
    // delete have always been keyed on.
    const hk = groupKeyOf(e);
    let h = p.hats[hk];
    if (!h) { h = p.hats[hk] = { key: hk, label: tidyName(e.c2), rows: [], cards: 0 }; p.kids.push({ k: 'hat', hat: h }); }
    h.rows.push(ri);
    h.cards += (e.n || 0);
  });
  return pockets;
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

/**
 * The outline, flattened to the lines it draws as.
 *
 * Every line carries the level it is indented to, so the list you walk with
 * the arrow keys and the list on the screen cannot drift apart — the renderer
 * draws this array and nothing else.
 */
function buildFlat() {
  const tree = buildTree();
  S.groups = [];
  S.flat = [];

  const pushBlock = (ri, lvl) => {
    S.flat.push({ t: 'block', ri: ri, lvl: lvl });
    const r = S.results[ri];
    if (!argsOpen(r)) return;
    (r.entry.a || []).forEach((_, ai) => S.flat.push({ t: 'arg', ri: ri, ai: ai, lvl: lvl + 1 }));
  };

  tree.forEach((p) => {
    S.groups.push({ key: p.key, level: 1, label: p.label, rows: p.rows, cards: p.cards });
    S.flat.push({ t: 'group', gk: p.key, lvl: 1, label: p.label, blocks: p.rows.length, cards: p.cards });
    if (!groupOpen(p.key)) return;
    p.kids.forEach((kid) => {
      if (kid.k === 'block') { pushBlock(kid.ri, 2); return; }
      const h = kid.hat;
      S.groups.push({ key: h.key, level: 2, label: h.label, rows: h.rows, cards: h.cards });
      S.flat.push({ t: 'group', gk: h.key, lvl: 2, label: h.label, blocks: h.rows.length, cards: h.cards });
      if (!groupOpen(h.key)) return;
      h.rows.forEach((ri) => pushBlock(ri, 3));
    });
  });

  // -1 means "put me on the first real result, not a group header".
  if (S.sel === -1) {
    const first = S.flat.findIndex((f) => f.t !== 'group');
    S.sel = first === -1 ? 0 : first;
  }
  if (S.sel >= S.flat.length) S.sel = Math.max(0, S.flat.length - 1);
}

/* ====================================================================
   Bins
   ==================================================================== */

const LOOSE = '';
const binKey = (e) => [tidyName(e.c1), tidyName(e.c2), tidyName(e.t)].join('|');
function binOf(e) {
  const id = S.bins.of[binKey(e)];
  return id && S.bins.list.some((b) => b.id === id) ? id : LOOSE;
}
function binOn(id) {
  if (id === LOOSE) return S.bins.loose !== false;
  const b = S.bins.list.find((x) => x.id === id);
  return !b || b.on !== false;
}
const inUse = (e) => binOn(binOf(e));
const binName = (id) => (id === LOOSE ? 'Unsorted' : ((S.bins.list.find((b) => b.id === id) || {}).name || 'Bin'));
function normalizeBins(b) {
  const x = b && typeof b === 'object' ? b : {};
  return {
    list: Array.isArray(x.list) ? x.list.filter((y) => y && y.id).map((y) => ({ id: y.id, name: String(y.name || 'Bin'), on: y.on !== false })) : [],
    of: x.of && typeof x.of === 'object' ? x.of : {},
    loose: x.loose !== false
  };
}
function saveBins() {
  DB.set('kv', 'bins', S.bins).catch(() => {});
  // Flow and Doc flow search the same library, and read the bins as they go.
  if (BUS) BUS.post({ kind: 'bins-changed' });
}

function renderBins() {
  const bar = $('#binbar');
  if (!bar) return;
  if (!S.index.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  const counts = {};
  S.index.forEach((e) => { const b = binOf(e); counts[b] = (counts[b] || 0) + 1; });
  const out = S.index.filter((e) => !inUse(e)).length;
  const chip = (id, name) => {
    const on = binOn(id);
    return '<span class="bin' + (on ? ' on' : ' off') + (id === LOOSE ? ' loose' : '') + '" data-bin="' + esc(id) + '">' +
      '<button type="button" class="bin-t" data-bintoggle="' + esc(id) + '" title="' +
        (on ? 'In this round — click to leave it out' : 'Out of this round — click to use it') +
        (id === LOOSE ? '' : ' · double-click to rename') + ' · drop evidence here to move it">' +
        '<i></i><span class="bin-n">' + esc(name) + '</span><em>' + (counts[id] || 0) + '</em></button>' +
      (id === LOOSE ? '' : '<button type="button" class="bin-x" data-bindel="' + esc(id) + '" title="Delete this bin — what is in it goes back to Unsorted">&times;</button>') +
      '</span>';
  };
  bar.innerHTML = '<span class="bl">Bins</span>' +
    S.bins.list.map((b) => chip(b.id, b.name)).join('') +
    (counts[LOOSE] || !S.bins.list.length ? chip(LOOSE, 'Unsorted') : '') +
    '<button type="button" class="bin-add" data-act="binAdd" title="A new bin — then drag evidence onto it">+ Bin</button>' +
    (out ? '<span class="bin-out">' + out + ' block' + (out === 1 ? '' : 's') + ' out of this round</span>' : '');
}

function toggleBin(id) {
  if (id === LOOSE) S.bins.loose = !binOn(LOOSE);
  else { const b = S.bins.list.find((x) => x.id === id); if (b) b.on = !binOn(id); }
  saveBins(); renderBins(); runSearch();
  toast(binName(id) + (binOn(id) ? ' — in this round' : ' — left out of this round'));
}

function addBin() {
  const b = { id: uid('bin'), name: 'Bin ' + (S.bins.list.length + 1), on: true };
  S.bins.list.push(b);
  saveBins(); renderBins();
  renameBin(b.id);
}

function renameBin(id) {
  const b = S.bins.list.find((x) => x.id === id);
  const chip = root && root.querySelector('#binbar .bin[data-bin="' + id + '"] .bin-n');
  if (!b || !chip) return;
  const input = document.createElement('input');
  input.className = 'bin-in';
  input.value = b.name;
  input.maxLength = 40;
  chip.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return; done = true;
    if (keep && input.value.trim()) { b.name = input.value.trim(); saveBins(); }
    renderBins(); runSearch();
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (ev) => ev.stopPropagation());
}

function deleteBin(id) {
  const b = S.bins.list.find((x) => x.id === id);
  if (!b) return;
  const n = S.index.filter((e) => binOf(e) === id).length;
  if (n && !confirm('Delete the bin “' + b.name + '”?\n\nIts ' + n + ' block' + (n === 1 ? '' : 's') + ' go back to Unsorted — nothing is deleted from the library.')) return;
  S.bins.list = S.bins.list.filter((x) => x.id !== id);
  Object.keys(S.bins.of).forEach((k) => { if (S.bins.of[k] === id) delete S.bins.of[k]; });
  saveBins(); renderBins(); runSearch();
  toast('Bin deleted' + (n ? ' — its evidence is Unsorted' : ''));
}

/** The blocks a row stands for: one block, or every block in a pocket or hat. */
function blocksFor(t) {
  if (t.ri !== undefined && t.ri !== null) { const r = S.results[t.ri]; return r ? [r.entry] : []; }
  return S.index.filter((e) => pocketKeyOf(e) === t.grp || groupKeyOf(e) === t.grp);
}

function moveToBin(t, id) {
  const list = blocksFor(t);
  if (!list.length) return;
  list.forEach((e) => { if (id === LOOSE) delete S.bins.of[binKey(e)]; else S.bins.of[binKey(e)] = id; });
  saveBins(); renderBins(); runSearch();
  toast(list.length + ' block' + (list.length === 1 ? '' : 's') + ' → ' + binName(id) + (binOn(id) ? '' : ' — out of this round'));
}

/** A small menu of bins, from a row's bin button. */
function openBinMenu(btn, t) {
  closeBinMenu();
  const m = document.createElement('div');
  m.className = 'binmenu';
  m.innerHTML = '<div class="bm-h">Move to</div>' +
    S.bins.list.map((b) => '<button type="button" data-bm="' + esc(b.id) + '">' + esc(b.name) + (binOn(b.id) ? '' : ' <small>out</small>') + '</button>').join('') +
    '<button type="button" data-bm="">Unsorted</button>' +
    '<button type="button" class="bm-new" data-bmnew="1">+ New bin…</button>';
  root.appendChild(m);
  const r = btn.getBoundingClientRect(), R = root.getBoundingClientRect();
  m.style.left = Math.min(r.left - R.left, R.width - 220) + 'px';
  m.style.top = (r.bottom - R.top + 4) + 'px';
  m.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const nb = ev.target.closest('[data-bmnew]');
    if (nb) {
      const b = { id: uid('bin'), name: 'Bin ' + (S.bins.list.length + 1), on: true };
      S.bins.list.push(b);
      closeBinMenu(); moveToBin(t, b.id); renameBin(b.id);
      return;
    }
    const x = ev.target.closest('[data-bm]');
    if (!x) return;
    closeBinMenu(); moveToBin(t, x.dataset.bm);
  });
  setTimeout(() => document.addEventListener('mousedown', closeBinMenuOutside), 0);
}
function closeBinMenuOutside(ev) { if (!ev.target.closest || !ev.target.closest('.binmenu')) closeBinMenu(); }
function closeBinMenu() {
  document.removeEventListener('mousedown', closeBinMenuOutside);
  if (root) root.querySelectorAll('.binmenu').forEach((m) => m.remove());
}

/** What the results looked like last time, so a redraw of the same list is quiet. */
let lastShape = '';

function renderResults() {
  if (CL && CL.on) { CL.draw(); return; }
  buildFlat();
  const box = $('#results');

  if (!S.index.length) {
    box.innerHTML = '<div class="blank"><strong>No evidence yet</strong>' +
      '<p>Open your evidence document in Google Docs, select all, copy. ' +
      'Then click <b>Import</b> and paste. Nothing leaves this page.</p></div>';
    $('#searchmeta').textContent = '';
    return;
  }
  if (!S.results.length && !S.index.some(inUse)) {
    box.innerHTML = '<div class="blank"><strong>Every bin is out of this round</strong>' +
      '<p>Switch a bin on above to search it again.</p></div>';
    $('#searchmeta').textContent = '0';
    return;
  }
  if (!S.results.length) {
    box.innerHTML = '<div class="blank"><strong>No matches</strong>' +
      '<p>Try fewer letters, or loosen fuzzy sensitivity in Settings.</p></div>';
    $('#searchmeta').textContent = '0';
    return;
  }

  // Position in the list, which is how long a line waits before it arrives.
  // Capped, so the twentieth line is not still turning up half a second later.
  const seat = (i) => Math.min(i, 16);

  /** A category — a pocket at the top level, a hat under it. */
  const groupLine = (f, i) => {
    const open = groupOpen(f.gk);
    return '<div class="node lv' + f.lvl + (i === S.sel ? ' sel' : '') + (open ? ' open' : ' shut') +
             '" data-grp="' + esc(f.gk) + '" draggable="true" style="--i:' + seat(i) + '">' +
             '<span class="chev"></span>' +
             '<span class="nlabel">' + esc(f.label) + '</span>' +
             '<span class="ncount">' + f.blocks + '</span>' +
             '<button class="tobin" data-tobin-grp="' + esc(f.gk) + '" title="Move every block in this to a bin">bin</button>' +
             '<button class="del" data-delgrp="' + esc(f.gk) +
               '" title="Delete every block in this category">&times;</button>' +
           '</div>';
  };

  /** A block, which is a heading with tags under it. */
  const blockLine = (f, i) => {
    const r = S.results[f.ri];
    const e = r.entry;
    const tags = (e.a || []).length;
    const open = argsOpen(r);
    return '<div class="row lv' + f.lvl + (i === S.sel ? ' sel' : '') +
             (tags ? (open ? ' open' : ' shut') : '') +
             '" data-ri="' + f.ri + '" draggable="true" style="--i:' + seat(i) + '">' +
             '<span class="chev"></span>' +
             '<span class="ttl">' + markUp(e.t, r.ttlPos) + '</span>' +
             (tags && !open ? '<span class="meta">' + tags + '</span>' : '') +
             (S.bins.list.length ? '<span class="binof">' + esc(binName(binOf(e))) + '</span>' : '') +
             '<button class="tobin" data-tobin-ri="' + f.ri + '" title="Move this block to a bin">bin</button>' +
             '<button class="del" data-del="' + f.ri + '" title="Delete from library">&times;</button>' +
           '</div>';
  };

  /** A tag: the card itself, the thing that actually gets sent. */
  const argLine = (f, i) => {
    const e = S.results[f.ri].entry;
    return '<div class="arg lv' + f.lvl + (i === S.sel ? ' sel' : '') +
             '" data-ri="' + f.ri + '" data-ai="' + f.ai + '" style="--i:' + seat(i) + '">' +
             '<span class="chev"></span>' +
             '<span class="argt">' + esc((e.a || [])[f.ai] || '(untitled)') + '</span>' +
             '<button class="del" data-delarg="' + f.ri + ':' + f.ai +
               '" title="Delete this argument">&times;</button>' +
           '</div>';
  };

  const html = S.flat.map((f, i) => (
    f.t === 'group' ? groupLine(f, i) : f.t === 'arg' ? argLine(f, i) : blockLine(f, i)
  )).join('');

  box.innerHTML = html;
  // The list only arrives when it is a different list. Moving the selection
  // redraws the same lines, and lines that re-animate under every arrow key
  // are worse than lines that never move.
  const shape = S.flat.map((f) => f.t + (f.gk || f.ri) + (f.ai === undefined ? '' : '.' + f.ai)).join('|');
  if (shape !== lastShape) {
    lastShape = shape;
    box.classList.remove('fresh');
    void box.offsetWidth;
    box.classList.add('fresh');
  }
  const shown = S.results.length;
  const found = (typeof S.results.total === 'number') ? S.results.total : shown;
  $('#searchmeta').textContent = (found > shown)
    ? shown + ' of ' + found + ' · capped'
    : shown + ' / ' + S.index.filter(inUse).length;
  const selEl = box.querySelector('.sel');
  if (selEl) selEl.scrollIntoView({ block: 'nearest' });
}

/** Which sent block has just arrived, if any — read once and forgotten. */
let landed = -1;

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
        '<p>Press <kbd>Enter</kbd> on a result. The card is copied for you to paste, ' +
        'and stacks up here. <b>+ Analytic</b> adds a tagline you write yourself.</p></div>';
      renderDoc();
      return;
    }
    body.innerHTML = S.send.map((c, i) => {
      const n = (c.parts || []).length;
      // The block that has just been sent says so once, then settles.
      const fresh = (i === landed) ? ' landed' : '';
      let h = '<div class="sent' + fresh + '" draggable="true" data-sent="' + i + '">' +
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
 * The send document as elements: the draft when there is one, otherwise the
 * one the send list makes. The read document is built from this rather than
 * from the send list, so a line written into the send doc is a line in the
 * speech doc too.
 */
function sendDocElements() {
  return S.docHtml !== null ? elementsFromHtml(S.docHtml) : buildSendElements();
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
  if (!root) return;
  const read = S.tab === 'read';
  const label = $('#doclabel');
  if (label) label.textContent = read ? 'Read doc' : 'Send doc';
  const pane = root.querySelector('.docpane');
  if (pane) pane.classList.toggle('editable', !read);

  // A draft that has been emptied is no draft at all, so the document comes
  // back from the send list rather than leaving a blank page for ever.
  if (S.docHtml !== null && !S.docHtml.replace(/<[^>]+>/g, '').trim()) S.docHtml = null;

  // In a room the send doc is the room's: the editor is bound to it, and what
  // this browser sent is added to its end — once, by whoever sent it.
  if (SHARE && SHARE.ready && !read) {
    const fresh = S.send.filter((c) => SHARE.mine.has(c.id) && !SHARE.placed.has(c.id));
    if (fresh.length) {
      const add = [];
      fresh.forEach((c) => { const els = entryElems(c); if (els.length) add.push(...els, { k: 'p', h: 'P', runs: [] }); });
      SHARE.ydoc.transact(() => fresh.forEach((c) => SHARE.placed.set(c.id, 1)), Y_ORIGIN);
      if (add.length) appendShared(pageHtml(add));
    }
    root.dispatchEvent(new CustomEvent('evi:doc', { detail: { html: null, read: false, draft: true, shared: true } }));
    publishDoc();
    return;
  }

  let html;
  if (read) {
    html = pageHtml(buildReadElements());
  } else if (S.docHtml === null) {
    S.docIds = S.send.map((c) => c.id);
    html = pageHtml(buildSendElements());
  } else {
    // a draft: anything sent since it was last looked at joins the end
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
    html = S.docHtml;
  }

  root.dispatchEvent(new CustomEvent('evi:doc', {
    detail: { html: html, read: read, draft: S.docHtml !== null },
  }));
  publishDoc();
}

/**
 * The editor telling us what the document now is.
 *
 * The panel owns the writing; this owns what becomes of it — the draft store,
 * the clipboard, and the rule that an empty document is not a draft.
 */
function setDraft(html, text) {
  // the room's send doc is kept from the shared document itself
  if (SHARE && SHARE.ready && S.tab !== 'read') return;
  const bare = String(html || '').replace(/<[^>]+>/g, '').trim();
  S.docHtml = bare ? html : null;
  S.docText = text || '';
  S.docIds = S.send.map((c) => c.id);
  saveDoc();
  if (!bare) renderDoc();
  publishDoc();
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

/** Unused: the editor reports edits through setDraft. Kept out of the way. */
function onDocInput_unused(ev) {
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
  if (SHARE && SHARE.ready) {
    SHARE.ydoc.transact(() => S.send.forEach((c) => SHARE.placed.set(c.id, 1)), Y_ORIGIN);
    replaceShared(pageHtml(buildSendElements()));
    toast('Rebuilt the shared send doc from the send list');
    return;
  }
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
      '<span class="hint">Ctrl+Enter to add · Esc to cancel</span>' +
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

function persistSend() { DB.set('kv', 'send', S.send).catch(() => {}); pushSend(); }

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
  return readFromElements(sendDocElements());
}

/* ====================================================================
   8. Actions
   ==================================================================== */

/**
 * Take something out of a list visibly, and then out of the list.
 *
 * A row that is simply gone on the next paint reads as a mis-click; one that
 * leaves reads as the thing you asked for. The work happens in the callback,
 * so the list is only ever wrong for the 150ms the row spends leaving — and
 * not at all for anyone who has asked for less movement.
 */
function vanish(el, done) {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!el || !el.animate || still) return done();
  const next = el.nextElementSibling;
  const parts = next && next.classList.contains('parts') ? next : null;
  const runs = [el, parts].filter(Boolean).map((n) => n.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(28px)' }],
    { duration: 150, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' },
  ));
  let left = runs.length;
  const tick = () => { if (!--left) done(); };
  runs.forEach((a) => { a.onfinish = tick; a.oncancel = tick; });
}

let toastTimer = null;
let toastAlt = false;
function toast(msg, bad) {
  const t = $('#toast');
  const life = bad ? 6000 : 2400;
  t.textContent = msg;
  // The bar across the top runs down for exactly as long as the message has,
  // so one about to go does not look like one that is staying.
  t.style.setProperty('--life', life + 'ms');
  // A second message while the first is still up has to restart that bar
  // without restarting the toast itself, which is already where it belongs —
  // so the bar is drawn by one of two identical animations, alternately.
  toastAlt = !toastAlt;
  t.className = 'toast on' + (bad ? ' bad' : '') + (toastAlt ? ' alt' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, life);
}

function runSearch() {
  S.query = String($('#q').value || '').replace(/^\/+/, '').trim();
  S.results = search($('#q').value, S.index.filter(inUse), {
    sens: S.settings.sens, max: S.settings.max, args: S.settings.args
  });
  // Which blocks are showing their tags is remembered against the block
  // itself (S.expanded), so it survives a search rather than being carried
  // across from the last set of results.
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
    // Closing from inside a block lands you back on the block.
    S.expanded[r.entry.id] = false;
    S.sel = S.flat.findIndex((x) => x.t === 'block' && x.ri === f.ri);
  } else {
    S.expanded[r.entry.id] = open === undefined ? !argsOpen(r) : open;
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

  await sendParsed(block, argIndex);
}

/**
 * Send a block that is already in hand — the library's, or a card read out of
 * a caselist document — into the send list and onto the clipboard.
 */
async function sendParsed(block, argIndex, from) {
  // Built by the same function Flow uses when it sends into this list.
  const item = makeSendItem(block, argIndex, S.settings.head);
  if (!item) return toast('That block is empty.', true);

  try { await copyRich(entryElems(item)); }
  catch (e) { return toast(e.message, true); }

  S.send.push(item);
  persistSend();
  landed = S.send.length - 1;
  renderSide();
  landed = -1;
  // Said before the search is cleared, so the row it came from is still on
  // screen for the motion layer to carry across to the list.
  root.dispatchEvent(new CustomEvent('evi:sent', { detail: { title: item.title } }));
  // And to Flow, if it is open in another tab: the tags of what was just sent,
  // ready to go into the flow.
  if (BUS) BUS.post({ kind: 'sent', title: item.title, trigger: item.trigger || '', tags: item.parts.map((p) => p.title) });
  toast('Copied' + (from ? ' ' + from : '') + ' — press Ctrl+V in your Send doc');
  // A library search is spent once its block is sent; a caselist search cost a
  // quarter of the minute's allowance, so it stays for the next card.
  if (CL && CL.on) return;
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
    const html = S.docHtml;
    const text = S.docText || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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
  renderBins();
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
async function deleteGroup(key, level) {
  // A pocket holds everything filed under it, hats included; a hat holds only
  // what is directly in it. Both are one line in the outline, so which was
  // clicked has to come with the key.
  const holds = level === 1
    ? (e) => pocketKeyOf(e) === key
    : (e) => groupKeyOf(e) === key;
  const doomed = S.index.filter(holds);
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

/** Shared by the line's own × and the Delete key. */
function confirmDeleteGroup(key) {
  const g = S.groups.filter((x) => x.key === key)[0];
  const blocks = g ? g.rows.length : 0;
  const cards = g ? g.cards : 0;
  if (!blocks) return;
  if (confirm('Delete all ' + blocks + ' block' + (blocks === 1 ? '' : 's') +
              ' filed under “' + (g.label || key) + '”?\n\n' +
              'That is ' + cards + ' card' + (cards === 1 ? '' : 's') + '. ' +
              'Your evidence document and any .json export are untouched.')) {
    deleteGroup(key, g.level);
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
  renderBins();
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
  renderBins();
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
/** "---2AC", "---1AR": any of them, at the end, however it was typed. */
const TAGGED = /---\s*(1AC|2AC|1NC|2NC|1AR|1NR|2NR|2AR)\s*$/i;

function withTag(head, speech) {
  const out = clone(head);
  const runs = out.runs || [];
  const last = [...runs].reverse().find((r) => (r.t || '').trim());
  if (!last) return out;
  // A block that came out of the file already saying which speech it is keeps
  // what it says, even when that is a different speech from this one -- it is
  // the file's own label, and doubling it up would be the mistake.
  if (TAGGED.test(runsText(out).trim())) return out;
  last.t = last.t.replace(/\s+$/, '') + '---' + speech;
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
    out.push({ k: 'p', h: 'H1', al: 'center', bd: 1, runs: [{ t: title, b: true, fs: 26 }] });
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
let binClick = null;
/** A bin's name is renamed by double-clicking it; one click (after a beat) switches it. */
function onDblClick(ev) {
  const bt = ev.target.closest && ev.target.closest('[data-bintoggle]');
  if (!bt || bt.dataset.bintoggle === LOOSE) return;
  clearTimeout(binClick);
  renameBin(bt.dataset.bintoggle);
}

const sentRow = (ev) => (ev.target && ev.target.closest) ? ev.target.closest('.sent') : null;
const clearDrop = () => {
  if (!root) return;
  root.querySelectorAll('.sent.over, .sent.dragging').forEach((e) => e.classList.remove('over', 'dragging'));
};

let binDrag = null;
function onDragStart(ev) {
  const lib = ev.target.closest && ev.target.closest('#results .node[data-grp], #results .row[data-ri]');
  if (lib) {
    binDrag = lib.dataset.grp !== undefined ? { grp: lib.dataset.grp } : { ri: Number(lib.dataset.ri) };
    lib.classList.add('lifting');
    root.classList.add('binning');
    if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', lib.textContent.trim()); } catch (e) { /* older browsers */ } }
    return;
  }
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
  if (binDrag) {
    const bin = ev.target.closest && ev.target.closest('#binbar .bin');
    root.querySelectorAll('#binbar .bin.over').forEach((b) => { if (b !== bin) b.classList.remove('over'); });
    if (!bin) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    bin.classList.add('over');
    return;
  }
  const row = sentRow(ev);
  if (dragFrom === null || !row) return;
  ev.preventDefault();                     // without this the drop never fires
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
  root.querySelectorAll('.sent.over').forEach((e) => e.classList.remove('over'));
  if (Number(row.dataset.sent) !== dragFrom) row.classList.add('over');
}

function onDrop(ev) {
  if (binDrag) {
    const bin = ev.target.closest && ev.target.closest('#binbar .bin');
    const t = binDrag;
    endBinDrag();
    if (!bin) return;
    ev.preventDefault();
    moveToBin(t, bin.dataset.bin);
    return;
  }
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

function endBinDrag() {
  binDrag = null;
  if (!root) return;
  root.classList.remove('binning');
  root.querySelectorAll('.lifting, #binbar .bin.over').forEach((e) => e.classList.remove('lifting', 'over'));
}
function onDragEnd() { dragFrom = null; clearDrop(); endBinDrag(); }

function openImport() {
  $('#card').innerHTML =
    '<h2>Import evidence</h2><div class="in">' +
    '<p class="hint">Pasting <b>adds</b> to your library. A block already in there — same ' +
    'category and title — is updated in place rather than duplicated, so re-pasting an ' +
    'edited file just refreshes it.<br><br>' +
    'In Google Docs open your evidence file, press <b>Ctrl+A</b> then ' +
    '<b>Ctrl+C</b>. Click the box below and press <b>Ctrl+V</b>.<br><br>' +
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
  if (SHARE && SHARE.ready) replaceShared(S.docHtml);
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
  const bt = ev.target.closest('[data-bintoggle]');
  if (bt) { if (ev.detail > 1) return; clearTimeout(binClick); binClick = setTimeout(() => toggleBin(bt.dataset.bintoggle), 220); return; }
  const bd = ev.target.closest('[data-bindel]');
  if (bd) { deleteBin(bd.dataset.bindel); return; }
  const tb = ev.target.closest('[data-tobin-grp], [data-tobin-ri]');
  if (tb) {
    ev.stopPropagation();
    openBinMenu(tb, tb.dataset.tobinGrp !== undefined ? { grp: tb.dataset.tobinGrp } : { ri: Number(tb.dataset.tobinRi) });
    return;
  }
  const act = ev.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'import') openImport();
    if (a === 'binAdd') addBin();
    if (a === 'case') openCase();
    if (a === 'copyCase') copyCaseDoc();
    if (a === 'caseReset') { S.caseElems = []; S.caseWords = 0; renderCase(); }
    if (a === 'settings') openSettings();
    if (a === 'room') openRoom();
    if (a === 'roomJoin') joinRoom(($('#room-code') || {}).value, ($('#room-name') || {}).value);
    if (a === 'roomLeave') leaveRoom();
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
        if (SHARE && SHARE.ready) { pushSend(); SHARE.ydoc.transact(() => SHARE.placed.clear(), Y_ORIGIN); replaceShared(''); }
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
        S.bins = normalizeBins(null);
        S.send = [];
        renderStat();
        renderBins();
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
    const i = Number(drop.dataset.drop);
    vanish(drop.closest('.sent'), () => {
      S.send.splice(i, 1);
      persistSend();
      renderSide();
    });
    return;
  }

  // The mark at the head of a block opens its tags. Everywhere else on the
  // line still sends it, which is what the line is mostly for.
  const chev = ev.target.closest('.chev');
  if (chev) {
    const line = chev.closest('[data-ri]');
    if (line && line.dataset.ai === undefined) {
      const r = S.results[Number(line.dataset.ri)];
      if (r && (r.entry.a || []).length) {
        S.expanded[r.entry.id] = !argsOpen(r);
        renderResults();
        return;
      }
    }
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
  if (CL && CL.on) { CL.input(el.value); return; }
  runSearch();
}

function onQueryKey(ev) {
  if (CL && CL.on && CL.key(ev)) return;
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
    const [index, meta, send, doc, bins] = await Promise.all([
      DB.get('kv', 'index'), DB.get('kv', 'meta'), DB.get('kv', 'send'), DB.get('kv', 'doc'), DB.get('kv', 'bins')
    ]);
    S.bins = normalizeBins(bins);
    S.index = prepare(index || []);
    S.meta = meta || null;
    S.send = normalizeSend(send);
    if (doc && typeof doc.html === 'string') { S.docHtml = doc.html; S.docIds = doc.ids || []; }
  S.docText = '';
  } catch (e) {
    toast('Storage unavailable — the library will not persist. ' + e.message, true);
  }
  renderStat();
  renderSide();
  renderBins();
  runSearch();
  $('#q').focus();
  // an empty library asks for a paste — unless the search is on the caselist, which needs none
  if (!S.index.length && !(CL && CL.on)) openTimer = setTimeout(openImport, 400);
}


/* ====================================================================
   12. Mounting
   ==================================================================== */

/**
 * Attach the tool to `el`, which must already contain the markup, and return
 * the function that detaches it. The document-level key handler is the only
 * listener that reaches outside, and it is removed with the rest.
 */

/* ====================================================================
   Sharing the send doc

   One partner builds the send doc here while the other flows the round.
   The send doc goes out as an outline — sections, block headers, tags and
   their cites — which is what a flow needs and a fraction of the size of
   the cards themselves. It goes two ways: to this account's own Flow tabs
   over the bus, always, and into a flow room when there is one, under the
   same code the flow uses, for a partner on another computer.
   ==================================================================== */

let ROOM = null;
let roomPeers = [];
let roomName = '';
let roomStatus = 'off';
let publishTimer = null;
let lastDoc = '';

/** The send doc as a flow wants it: blocks, and the tags under each. */
function sendDocOutline() {
  const out = [];
  let block = null;
  let section = '';
  const text = (e) => (e.runs || []).map((r) => r.t).join('').replace(/\s+/g, ' ').trim();
  const els = sendDocElements();
  els.forEach((e, i) => {
    if (!e || e.k === 'brk') return;
    if (e.h === 'H1' || e.h === 'H2') { section = text(e); return; }
    if (e.h === 'H3') { block = { head: text(e), section, tags: [] }; out.push(block); return; }
    if (e.h === 'H4') {
      if (!block) { block = { head: '', section, tags: [] }; out.push(block); }
      // the cite is the bold at the head of the paragraph that follows
      const next = els[i + 1];
      const cite = next && !next.h ? (next.runs || []).filter((r) => r.b).map((r) => r.t).join('').trim().slice(0, 60) : '';
      block.tags.push({ tag: text(e), cite });
    }
  });
  return out.filter((b) => b.head || b.tags.length);
}

/* ---- one send doc for the room ----
   Joining a room is joining its send doc. Both partners' Evidence tabs hold
   one Yjs document — the send list, and the send doc's text — on a channel
   of its own (senddoc-CODE), so either can send a card, reorder, cut or type
   in the doc and the other sees it, and two people typing at once both keep
   what they typed. The first one in brings their send doc; whoever joins
   takes the room's, and anything they had already sent is added to it. */
let SHARE = null;
const Y_ORIGIN = 'evi';

const pmParse = (html) => { const d = document.createElement('div'); d.innerHTML = html || '<p></p>'; return PMDOMParser.fromSchema(docSchema).parse(d); };
const pmHtml = (node) => { const d = document.createElement('div'); d.appendChild(DOMSerializer.fromSchema(docSchema).serializeFragment(node.content)); return d.innerHTML; };
const sharedNode = () => yXmlFragmentToProseMirrorRootNode(SHARE.frag, docSchema);
const writeShared = (node) => SHARE.ydoc.transact(() => prosemirrorToYXmlFragment(node, SHARE.frag), Y_ORIGIN);
function replaceShared(html) { if (SHARE) writeShared(pmParse(html)); }
function appendShared(html) {
  if (!SHARE) return;
  const cur = sharedNode();
  const add = pmParse(html);
  // an empty document's one blank paragraph goes, rather than sitting on top
  const keep = cur.childCount === 1 && !cur.textContent.trim() ? cur.content.cut(cur.content.size) : cur.content;
  writeShared(cur.copy(keep.append(add.content)));
}

/** The send list into the shared doc — only what changed, so a partner's change at the same moment survives. */
function pushSend() {
  if (!SHARE || !SHARE.ready) return;
  const { list, items, ydoc, mine } = SHARE;
  const ids = S.send.map((c) => c.id);
  ydoc.transact(() => {
    const have = list.toArray();
    for (let i = have.length - 1; i >= 0; i--) if (!ids.includes(have[i])) list.delete(i, 1);
    const now = list.toArray();
    ids.forEach((id, i) => { if (!now.includes(id)) { mine.add(id); list.insert(Math.min(i, list.length), [id]); } });
    if (list.toArray().join('|') !== ids.join('|')) { list.delete(0, list.length); list.insert(0, ids); }
    S.send.forEach((c) => { const j = JSON.stringify(c); if (items.get(c.id) !== j) items.set(c.id, j); });
    Array.from(items.keys()).forEach((k) => { if (!ids.includes(k)) items.delete(k); });
  }, Y_ORIGIN);
}

/** The shared doc's send list into this tab. */
function pullSend() {
  const seen = new Set();
  const next = [];
  SHARE.list.toArray().forEach((id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const raw = SHARE.items.get(id);
    if (raw) try { next.push(JSON.parse(raw)); } catch (e) { /* a broken item */ }
  });
  S.send = normalizeSend(next);
  DB.set('kv', 'send', S.send).catch(() => {});
}

let sharedTimer = null;
function onSharedChange(txn) {
  if (!SHARE || !SHARE.ready) return;
  // a partner's change to the list: read it now, so nothing local is written over it
  if (txn.origin !== Y_ORIGIN && (txn.changed.has(SHARE.list) || txn.changed.has(SHARE.items))) {
    pullSend();
    renderSide();
  }
  if (txn.changed.has(SHARE.frag) || txn.changedParentTypes.has(SHARE.frag)) {
    clearTimeout(sharedTimer);
    sharedTimer = setTimeout(() => {
      if (!SHARE) return;
      // the doc as text, for the clipboard, the formatter, SpeechDrop and a local copy
      S.docHtml = pmHtml(sharedNode());
      S.docIds = S.send.map((c) => c.id);
      saveDoc();
      publishDoc();
    }, 250);
  }
}

/** Nobody had a send doc to give: this one is the room's. */
function seedShare(sh) {
  sh.ydoc.transact(() => {
    S.send.forEach((c) => { sh.list.push([c.id]); sh.items.set(c.id, JSON.stringify(c)); sh.placed.set(c.id, 1); });
  }, Y_ORIGIN);
  writeShared(pmParse(S.docHtml !== null ? S.docHtml : pageHtml(buildSendElements())));
}

/** The room's send doc arrived: take it, and add what this tab had already sent. */
function adoptShare(sh) {
  const mine = sh.before;
  pullSend();
  const sig = (c) => (c.blockId || c.title || '') + '|' + (c.parts || []).map((p) => p.title).join('|');
  const there = new Set(S.send.map(sig));
  const extra = mine.filter((c) => !there.has(sig(c)));
  if (extra.length) {
    S.send = S.send.concat(extra);
    sh.ready = true;
    pushSend();
    toast(extra.length + ' card' + (extra.length === 1 ? '' : 's') + ' you had sent joined the shared send doc');
  }
}

function announceShare() {
  if (!root) return;
  root.dispatchEvent(new CustomEvent('evi:shared', {
    detail: SHARE && SHARE.ready ? { ydoc: SHARE.ydoc, frag: SHARE.frag, awareness: SHARE.awareness } : null,
  }));
}

function openShare(code) {
  closeShare();
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  awareness.setLocalStateField('user', { name: roomName || OWNER_NAME || 'Partner', color: MATE_COLORS[Math.floor(Math.random() * MATE_COLORS.length)] });
  const sh = {
    code, ydoc, awareness,
    list: ydoc.getArray('send'), items: ydoc.getMap('items'), placed: ydoc.getMap('placed'), frag: ydoc.getXmlFragment('doc'),
    mine: new Set(), before: S.send.slice(), ready: false, mates: [], room: null,
  };
  SHARE = sh;
  ydoc.on('afterTransaction', onSharedChange);
  sh.room = openYRoom({
    code, channel: 'senddoc', ydoc, awareness, title: () => 'senddoc', fresh: true,
    onStatus: () => {},
    onMates: (m) => { sh.mates = m; paintRoom(); },
    onTitle: () => {},
    onSeed: () => { if (SHARE === sh) { sh.ready = true; seedShare(sh); } },
    onSynced: (from) => {
      if (SHARE !== sh) return;
      if (from) adoptShare(sh);
      sh.ready = true;
      S.docHtml = pmHtml(sharedNode());
      announceShare();
      renderSide();
      renderDoc();
    },
  });
}

/** Out of the room: what the send doc was is kept here, as this tab's own. */
function closeShare() {
  if (!SHARE) return;
  const sh = SHARE;
  SHARE = null;
  clearTimeout(sharedTimer);
  try { if (sh.ready) S.docHtml = pmHtml(yXmlFragmentToProseMirrorRootNode(sh.frag, docSchema)); } catch (e) { /* keep the last copy */ }
  sh.ydoc.off('afterTransaction', onSharedChange);
  sh.room && sh.room.leave();
  sh.awareness.destroy();
  saveDoc();
  announceShare();
  if (root) renderDoc();
}

/* ---- the whole send doc, for a partner's Doc viewer ----
   A flow needs the outline; someone reading the doc needs every word of it.
   So the document itself goes out too, but only while a viewer is in the
   room: gzipped, as base64, in pieces under Realtime's message size, spaced
   under its rate limit — and a newer version cancels an older one mid-way. */
let htmlTimer = null;
let htmlSig = '';
let htmlRun = 0;
const viewers = () => roomPeers.filter((p) => p.kind === 'viewer').length;

async function gzip64(str) {
  if (typeof CompressionStream === 'undefined') return { enc: 'plain', data: str };
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { enc: 'gzip', data: btoa(bin) };
}

function publishHtml(now) {
  clearTimeout(htmlTimer);
  const go = async () => {
    if (!ROOM || !root) return;
    let html;
    try { html = pageHtml(sendDocElements()); } catch (e) { return; }
    if (html === htmlSig && !now) return;
    htmlSig = html;
    const { enc, data } = await gzip64(html);
    const run = ++htmlRun;
    const id = uid('doc');
    const SIZE = 48000;
    const n = Math.max(1, Math.ceil(data.length / SIZE));
    const by = roomName || OWNER_NAME || 'Partner';
    const at = Date.now();
    for (let i = 0; i < n; i++) {
      if (run !== htmlRun || !ROOM) return;
      ROOM.send('senddoc-html', { id, i, n, enc, part: data.slice(i * SIZE, (i + 1) * SIZE), by, at });
      if (i < n - 1) await new Promise((r) => setTimeout(r, 160));
    }
  };
  if (now) go(); else htmlTimer = setTimeout(go, 1200);
}

/** Send it out, soon — the doc changes on every keystroke of a draft. */
function publishDoc(now) {
  if (ROOM && viewers()) publishHtml(now);
  clearTimeout(publishTimer);
  const go = () => {
    if (!root) return;
    let blocks;
    try { blocks = sendDocOutline(); } catch (e) { return; }
    const payload = { by: roomName || OWNER_NAME || 'Partner', uid: OWNER || '', at: Date.now(), blocks };
    const sig = JSON.stringify(blocks);
    // unchanged since last time: nothing to say, unless someone asked
    if (sig === lastDoc && !now) return;
    lastDoc = sig;
    if (BUS) BUS.post({ kind: 'senddoc', ...payload });
    if (ROOM) ROOM.send('senddoc', payload);
  };
  if (now) go(); else publishTimer = setTimeout(go, 350);
}

function paintRoom() {
  const dot = $('#roomdot');
  const label = $('#roomstate');
  if (!dot || !label) return;
  const flows = roomPeers.filter((p) => p.kind !== 'evidence');
  const mates = SHARE ? SHARE.mates : [];
  dot.className = 'dot' + (ROOM ? (flows.length || mates.length ? ' live' : ' waiting') : '');
  label.textContent = ROOM ? (flows.length ? `Sharing · ${ROOM.code}` : `Room ${ROOM.code}`) : 'Room';
  const st = $('#room-st');
  if (st) {
    st.textContent = !ROOM ? 'Not sharing.'
      : mates.length ? `One send doc with ${mates.map((m) => m.name).join(', ')} — either of you can send, cut, reorder and type in it.` +
        (flows.length ? ` Also here: ${flows.map((p) => p.name + (p.kind === 'viewer' ? ' (reading)' : ' (flowing)')).join(', ')}.` : '')
      : flows.length ? `Sharing with ${flows.map((p) => p.name + (p.kind === 'viewer' ? ' (reading)' : '')).join(', ')} — they see every change as you make it.`
      : `In room ${ROOM.code}. Waiting for your partner's flow to join it.`;
  }
  const join = $('#room-join'), leave = $('#room-leave');
  if (join) join.hidden = !!ROOM;
  if (leave) leave.hidden = !ROOM;
}

function joinRoom(code, name) {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (code.length < 4) return toast('That is not a room code', true);
  roomName = (name || '').trim().slice(0, 24) || OWNER_NAME || 'Partner';
  try { localStorage.setItem(scoped('evidence.me', OWNER), roomName); } catch (e) { /* private browsing */ }
  if (ROOM) ROOM.leave();
  roomPeers = [];
  ROOM = joinFlow(code, roomName, {
    // a flow that has just arrived asks for what is in the room: the doc
    onEvent: (type) => {
      if (type === 'ask') publishDoc(true);
      // a Doc viewer asks for the document itself
      if (type === 'askdoc') publishHtml(true);
    },
    onPeers: (peers) => {
      const before = roomPeers.filter((p) => p.kind === 'flow').length;
      const readers = viewers();
      roomPeers = peers;
      if (peers.filter((p) => p.kind === 'flow').length > before) publishDoc(true);
      if (viewers() > readers) publishHtml(true);
      paintRoom();
    },
    onStatus: (status, detail) => {
      roomStatus = status;
      if (status === 'error') toast('Could not reach the room: ' + (detail || 'no connection'), true);
      if (status === 'alone' || status === 'live') publishDoc(true);
      paintRoom();
    },
    snapshot: () => null,
  }, 'evidence');
  openShare(code);
  paintRoom();
  toast('In room ' + code + ' — one send doc, for both of you');
}
function leaveRoom() {
  closeShare();
  if (ROOM) ROOM.leave();
  ROOM = null; roomPeers = [];
  paintRoom();
  toast('Left the room — the send doc stays here as yours');
}

function openRoom() {
  let suggested = '';
  try {
    suggested = localStorage.getItem(scoped('flow.room', OWNER)) || '';
    if (!roomName) roomName = localStorage.getItem(scoped('evidence.me', OWNER)) || OWNER_NAME || '';
  } catch (e) { /* private browsing */ }
  $('#card').className = 'card';
  $('#card').innerHTML =
    '<h2>One send doc for the room</h2><div class="in">' +
    '<p class="hint">Join the same room code as your flow and you and your partner share <b>one send doc</b>: ' +
    'either of you can send a card, cut or reorder the list, or type in the document, and the other sees it ' +
    'as it happens. If the room already has a send doc you take it, and cards you had sent are added to it. ' +
    'Your partner\'s <b>Flow</b> gets a <b>Send doc</b> tab that follows it, and the <b>Doc viewer</b> can read ' +
    'every word. Nothing is stored anywhere but your two browsers.</p>' +
    '<div class="set"><label>You are</label><input type="text" id="room-name" maxlength="24" value="' + esc(roomName) + '"></div>' +
    '<div class="set"><label>Room code<span class="sub">' +
      (suggested ? 'Filled in from the flow you have open.' : 'The code from the flow — Share in Flow shows it.') +
    '</span></label><input type="text" id="room-code" maxlength="8" value="' + esc(ROOM ? ROOM.code : suggested) + '"></div>' +
    '<p class="hint" id="room-st"></p>' +
    '</div><div class="out">' +
    '<button class="btn key" id="room-join" data-act="roomJoin">Join the room</button>' +
    '<button class="btn" id="room-leave" data-act="roomLeave">Leave the room</button>' +
    '<span class="spacer"></span><button class="btn" data-act="close">Close</button></div>';
  $('#veil').classList.add('on');
  paintRoom();
  setTimeout(() => { const c = $('#room-code'); if (c && !c.value) c.focus(); }, 30);
}

export function boot(el, opts = {}) {
  root = el;
  // Whose library this is — before anything is read, so the first read is
  // already from the right database.
  OWNER = opts.owner || null;
  OWNER_NAME = opts.me || '';
  DB.use(scoped(LEGACY_DB, OWNER));

  // Flow can put a card in the send list from its own tab. The list lives in
  // this database, so the only news is that it changed: read it again.
  BUS = openBus(OWNER, async (m) => {
    if (!root) return;
    if (m.kind === 'bins-changed') {
      // switched on or off from a flow, mid-round
      try { S.bins = normalizeBins(await DB.get('kv', 'bins')); renderBins(); runSearch(); } catch (e) { /* next change catches up */ }
      return;
    }
    if (m.kind !== 'send-changed') return;
    try {
      S.send = normalizeSend(await DB.get('kv', 'send'));
      landed = S.send.length - 1;
      renderSide();
      landed = -1;
      toast('From Flow: ' + (m.title || 'a card') + ' is in the send list');
    } catch (e) { /* the next send will catch it up */ }
  });
  const offs = [];
  const bind = (target, type, fn) => {
    if (!target) return;
    target.addEventListener(type, fn);
    offs.push(() => target.removeEventListener(type, fn));
  };

  bind(root, 'click', onClick);
  bind(root, 'dragstart', onDragStart);
  bind(root, 'dragover', onDragOver);
  bind(root, 'drop', onDrop);
  bind(root, 'dragend', onDragEnd);
  bind(root, 'dblclick', onDblClick);
  bind($('#veil'), 'mousedown', onVeilDown);
  CL = mountCaselist({
    root, $, esc, toast, scoped, owner: OWNER, toHtml,
    parseHtml: (html) => parseHtml(html, { stripAT: S.settings.stripAT }),
    send: sendParsed,
    library: () => runSearch(),
    // the paste prompt an empty library opens by itself has nothing to do with the caselist
    caselist: () => { clearTimeout(openTimer); if ($('#veil').classList.contains('on') && $('#dropzone')) closeModal(); },
  });
  bind($('#q'), 'input', onQueryInput);
  bind($('#q'), 'keydown', onQueryKey);
  bind(document, 'keydown', onDocKey);

  // `const` declarations don't land on window, so state is exposed here
  // deliberately — for poking at the library from the browser console
  // (EV.state.index, EV.state.send, ...).
  window.EV = {
  state: S,
  get caselist() { return CL && CL.state; },
  sharedDoc: () => (SHARE && SHARE.ready ? { ydoc: SHARE.ydoc, frag: SHARE.frag, awareness: SHARE.awareness } : null),
  DB, ingest, parseHtml, blockToElements, toHtml, toCards, readElements,
  search, prepare, buildReadElements, importProblem,
  deleteBlock, deleteArgument, formatCite, highlightOnly, shortCiteRuns, keepRuns,
  splitCite, refreshUsage, entryElems, normalizeSend, importLibraryFile, indexEntry,
  buildTree, groupKeyOf, pocketKeyOf, groupOpen, toggleGroup, toggleAllGroups, deleteGroup,
  analyticPart, saveAnalytic, nextArgNumber,
  wordCount, fmtDuration, readFromElements, readSegment, elementsFromHtml, previewHtml,
  renderCase, openCase, copyCaseDoc, renderDoc, buildSendElements, resetDoc, copySendDoc,
  formatElements, countAnalytics, docTitle, openFormat, runFormat, setDraft, sendDocElements
  };

  start();
  // A link with a room in it — the one Flow hands a partner — goes straight in.
  if (opts.room) {
    let name = OWNER_NAME;
    try { name = localStorage.getItem(scoped('evidence.me', OWNER)) || OWNER_NAME; } catch (e) { /* private browsing */ }
    joinRoom(opts.room, name);
  }
  paintRoom();

  return () => {
    offs.forEach((f) => f());
    clearTimeout(toastTimer);
    clearTimeout(openTimer);
    clearTimeout(docTimer);
    closeShare();
    if (ROOM) { ROOM.leave(); ROOM = null; roomPeers = []; }
    clearTimeout(publishTimer);
    if (BUS) { BUS.close(); BUS = null; }
    closeBinMenu();
    clearTimeout(binClick);
    if (CL) { CL.destroy(); CL = null; }
    root = null;
  };
}
