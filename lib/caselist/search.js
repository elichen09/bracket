/**
 * Searching the caselist index.
 *
 * Tags are not always descriptive — "1. They're wrong", "Ext — no link" — so
 * a card is found by more than its tag: the block it sits under ("AT: Econ"),
 * the words of its highlighted text (what is actually read, which says what
 * the card is about), and its cite (the author, the year). Each place a word
 * matches counts for a set amount — the tag most, then the block, the read
 * text, the cite — and a rare word for more than a common one.
 *
 * A word matches its root ("regulations" finds "regulation"), the debate
 * words that mean it ("econ" is "economy", "heg" is "hegemony", "nukes" is
 * "nuclear"), and, failing those, itself with one letter wrong; the word
 * still being typed matches the start of a longer one. Cards with every word
 * come first, and a search of three words or more is also answered by cards
 * with all but one; when no card has every word, the ones with the most do,
 * so a search is never empty for the want of one word — and of those, the
 * ones that answer it weakly (a word in the cite, when other cards say it in
 * the tag) are left out.
 *
 * And a search means what it says: "doesn't cause extinction" is not answered
 * by a card that says it does (polarity.js).
 *
 * It is built to be quick over a few hundred thousand cards. The index is
 * flat typed arrays — every root's cards in one run of one array — so it
 * builds in a pass, searches without allocating per card, and can be kept in
 * IndexedDB as it is and read back without being built again.
 */

import { asked, judge, isAnswers } from './polarity';

export const SEARCH_V = 3;

export const STOP = new Set(('a an and are as at be been but by can could do does for from had has have how if in into is it its ' +
  'may more most no not of on or our so such than that the their them then there these they this those to was were what ' +
  'when which who will with would you your vs v t s').split(' '));

const STEMS = new Map();
/** A word's root, near enough: plurals, -ing, -ed, -ly and the like taken off. */
export function stem(w) {
  w = String(w || '').toLowerCase();
  let r = STEMS.get(w);
  if (r !== undefined) return r;
  r = stem_(w);
  if (STEMS.size < 400000) STEMS.set(w, r);
  return r;
}
function stem_(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(sses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (/ization$/.test(w)) return w.slice(0, -7) + 'ize';
  if (/isation$/.test(w)) return w.slice(0, -7) + 'ize';
  if (/ational$/.test(w)) return w.slice(0, -5) + 'e';
  if (/ingly$/.test(w) && w.length > 7) return w.slice(0, -5);
  if (/ing$/.test(w) && w.length > 5) return w.slice(0, -3);
  if (/edly$/.test(w) && w.length > 6) return w.slice(0, -4);
  if (/ed$/.test(w) && w.length > 4) return w.slice(0, -2);
  if (/ly$/.test(w) && w.length > 5) return w.slice(0, -2);
  if (/s$/.test(w) && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** The debate words that mean the same thing, each set by its roots. */
const SAME = [
  'econ economy economic economics', 'heg hegemony hegemon hegemonic', 'nuke nuclear', 'prolif proliferation proliferate',
  'china chinese prc ccp beijing', 'russia russian moscow kremlin putin', 'warming climate', 'war conflict warfare',
  'dem democrat democratic', 'gop republican', 'tech technology technological', 'reg regulation regulatory regulate',
  'deter deterrence deterrent', 'dedev degrowth', 'cap capitalism capitalist', 'fed federal', 'ai agi',
  'extinction extinct existential', 'enviro environment environmental', 'mil military militarize militarization', 'sanction sanctions',
  'nato alliance', 'cyber cyberattack cybersecurity', 'space satellite orbital', 'pandemic disease bioweapon',
  'trade tariff', 'immigration immigrant migrant', 'ev electric', 'renewable solar wind', 'innovation innovate',
  'midterm midterms election', 'unemployment job jobs', 'recession downturn', 'inflation price',
  'solve solves solvency', 'bacteria bacterium bacterial',
].map((g) => [...new Set(g.split(' ').map(stem))]);
const SAME_AS = new Map();
const CANON = new Map();
for (const g of SAME) for (const w of g) {
  SAME_AS.set(w, new Set([...(SAME_AS.get(w) || []), ...g.filter((x) => x !== w)]));
  if (!CANON.has(w)) CANON.set(w, g[0]);
}
/** One name for every root that means the same thing. */
export const canon = (root) => CANON.get(root) || root;

const WORDS = /[\p{L}\p{N}]+/gu;
const words = (s) => (String(s || '').toLowerCase().match(WORDS) || []);

// where a word appears, and what a match there is worth
const TAG = 1, BLOCK = 2, READ = 4, CITE = 8;
export const PLACE = { TAG, BLOCK, READ, CITE };
// the worth of a set of places is its best one
const WORTH = new Float32Array(16);
for (let p = 1; p < 16; p++) WORTH[p] = p & TAG ? 3 : p & BLOCK ? 2 : p & READ ? 1.4 : 0.8;

/**
 * Build the search for one index: cards are [docIndex, tag, cite, rounds,
 * blockIndex?, readWords?], blocks the block headings they point at. What
 * comes back is plain data — strings and typed arrays — and can be stored.
 */
export function buildSearch(cards, blocks = []) {
  const n = cards.length;
  const ids = new Map();             // root -> its number, in the order met
  const names = [];
  const wordId = new Map();          // word -> root number, or -1 for a word not worth indexing
  const idOf = (w) => {
    let id = wordId.get(w);
    if (id !== undefined) return id;
    if (STOP.has(w)) id = -1;
    else {
      const r = stem(w);
      id = ids.get(r);
      if (id === undefined) { id = names.length; names.push(r); ids.set(r, id); }
    }
    wordId.set(w, id);
    return id;
  };
  const rootsOf = (text, cap) => {
    const m = String(text || '').toLowerCase().match(WORDS);
    if (!m) return [];
    const out = [];
    for (let k = 0; k < m.length && (!cap || out.length < cap); k++) { const id = idOf(m[k]); if (id >= 0) out.push(id); }
    return out;
  };
  const blockRoots = blocks.map((b) => rootsOf(b));

  // every (root, card, places) there is, then sorted by root in one counting pass
  let cap = Math.max(1 << 16, n * 24), m = 0;
  let tr = new Uint32Array(cap), tc = new Uint32Array(cap), tp = new Uint8Array(cap);
  const grow = () => {
    cap *= 2;
    const a = new Uint32Array(cap), b = new Uint32Array(cap), c = new Uint8Array(cap);
    a.set(tr); b.set(tc); c.set(tp); tr = a; tc = b; tp = c;
  };
  const seen = new Map();
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    seen.clear();
    const note = (list, place) => { for (let k = 0; k < list.length; k++) seen.set(list[k], (seen.get(list[k]) || 0) | place); };
    note(rootsOf(c[1]), TAG);
    if (typeof c[4] === 'number' && blockRoots[c[4]]) note(blockRoots[c[4]], BLOCK);
    if (c[5]) note(rootsOf(c[5]), READ);
    // the cite: its author and year, not every word of the credentials
    if (c[2]) note(rootsOf(String(c[2]).split(/[[(]/)[0], 6), CITE);
    if (m + seen.size > cap) grow();
    for (const [r, p] of seen) { tr[m] = r; tc[m] = i; tp[m] = p; m++; }
  }
  // the roots in order, so the start of a word can be looked up
  const order = names.map((_, k) => k).sort((a, b) => (names[a] < names[b] ? -1 : names[a] > names[b] ? 1 : 0));
  const rank = new Uint32Array(names.length);
  order.forEach((id, at) => { rank[id] = at; });
  const start = new Uint32Array(names.length + 1);
  for (let k = 0; k < m; k++) start[rank[tr[k]] + 1]++;
  for (let k = 0; k < names.length; k++) start[k + 1] += start[k];
  const at = start.slice(0, names.length);
  const post = new Uint32Array(m), places = new Uint8Array(m);
  for (let k = 0; k < m; k++) { const w = at[rank[tr[k]]]++; post[w] = tc[k]; places[w] = tp[k]; }
  return { v: SEARCH_V, n, vocab: order.map((id) => names[id]), start, post, places };
}

/** Where a root is in the vocabulary, or -1. */
function where(s, key) {
  let lo = 0, hi = s.vocab.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (s.vocab[mid] < key) lo = mid + 1; else hi = mid; }
  return lo < s.vocab.length && s.vocab[lo] === key ? lo : -1;
}

/** The roots of the index a query word reaches, each with how good a match it is. */
function reach(s, word, typing) {
  const out = new Map();             // vocabulary position -> quality
  const r = stem(word);
  const put = (key, q) => { const at = where(s, key); if (at >= 0 && (out.get(at) || 0) < q) out.set(at, q); };
  put(r, 1);
  put(word, 1);
  for (const k of SAME_AS.get(r) || []) put(k, 0.85);
  // the start of a longer word — for the word still being typed, or one nothing else answers
  if (r.length >= 3 && (typing || !out.size)) {
    let lo = 0, hi = s.vocab.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s.vocab[mid] < r) lo = mid + 1; else hi = mid; }
    for (let i = lo, n = 0; i < s.vocab.length && s.vocab[i].startsWith(r) && n < 40; i++, n++) {
      if (!out.has(i)) out.set(i, s.vocab[i] === r ? 1 : typing && out.size ? 0.45 : 0.6);
    }
  }
  // one letter wrong, for a word long enough to mistype, when nothing else reached
  if (!out.size && r.length >= 5) {
    for (let i = 0; i < s.vocab.length; i++) {
      const k = s.vocab[i];
      if (Math.abs(k.length - r.length) > 1 || k[0] !== r[0]) continue;
      if (within1(k, r)) out.set(i, 0.55);
    }
  }
  return out;
}
function within1(a, b) {
  if (a === b) return true;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const POP = new Uint8Array(256);
for (let i = 1; i < 256; i++) POP[i] = POP[i >> 1] + (i & 1);

// scratch, kept between searches of an index of the same size
let scratch = null;
function arrays(n) {
  if (!scratch || scratch.n !== n) scratch = { n, score: new Float32Array(n), best: new Float32Array(n), have: new Uint8Array(n), inTag: new Uint8Array(n), places: new Uint8Array(n), touched: new Uint32Array(n) };
  return scratch;
}

/** What a search is made of: its words (the denying ones taken out), and which way it argues. */
export function parseQuery(q) {
  const ask = asked(q);
  let ws = ask.words.filter((w) => !STOP.has(w));
  if (!ws.length) ws = words(q);
  ws = [...new Set(ws)].slice(0, 8);
  return { ws, ask, typing: !!q && !/\s$/.test(q) };
}

/**
 * The cards that answer `q`: [{ i, score, have, places, pol }] best first,
 * where `have` is how many of the query's words the card answers, `places`
 * where it matched (TAG, BLOCK, READ, CITE bits) and `pol` whether it argues
 * the way the search does (1), the opposite (-1) or does not say (0). Only
 * the cards answering the most words come back, and of a search that denies
 * something, not the cards that assert it — `opposite` says how many those
 * were, and `flipped` that they are all there was, so they are what came back. `tagOf(i)` and `blockOf(i)` give a card's tag and its block heading.
 */
export function searchCards(s, q, tagOf, blockOf, limit = 1500) {
  const { ws, ask, typing } = parseQuery(q);
  if (!ws.length || !s || !s.n) return { hits: [], terms: [], total: 0, most: 0, of: 0, opposite: 0 };
  const A = arrays(s.n);
  const { score, best, have, inTag, places, touched } = A;
  const all = [];                    // every card any word reached
  let nAll = 0;
  ws.forEach((w, wi) => {
    const bit = 1 << wi;
    let nt = 0;
    for (const [at, quality] of reach(s, w, typing && wi === ws.length - 1)) {
      const a = s.start[at], b = s.start[at + 1];
      const idf = Math.log(1 + s.n / (b - a));
      for (let k = a; k < b; k++) {
        const i = s.post[k], p = s.places[k];
        const v = WORTH[p] * quality * idf;
        if (best[i] === 0) touched[nt++] = i;
        // a word counts once per card, at its best match
        if (v > best[i]) best[i] = v;
        places[i] |= p;
        if (p & TAG) inTag[i] |= bit;
      }
    }
    for (let k = 0; k < nt; k++) {
      const i = touched[k];
      if (have[i] === 0) all[nAll++] = i;
      score[i] += best[i]; best[i] = 0; have[i] |= bit;
    }
  });
  let most = 0;
  for (let k = 0; k < nAll; k++) { const c = POP[have[all[k]]]; if (c > most) most = c; }
  let hits = [];
  let top = 0;
  // a search written as a sentence: a card may lack one of its words and still be the card —
  // "no extinction from mirror life" answers "mirror bacteria doesn't cause extinction"
  const need = ws.length >= 3 && most >= 3 ? most - 1 : most;
  // and a search that denies something is answered by cards about the same thing that deny it in
  // other words — "No mirror life impact" — so what it is about is enough to be looked at
  let topic = 0, topicN = 0;
  if (ask.negated) ws.forEach((w, wi) => { if (ask.topic.has(canon(stem(w)))) { topic |= 1 << wi; topicN++; } });
  for (let k = 0; k < nAll; k++) {
    const i = all[k];
    const n = POP[have[i]];
    if (n >= need || (topicN && POP[have[i] & topic] >= Math.max(1, topicN - 1))) {
      // every word in the tag itself: the card is about exactly this
      let sc = score[i] + (ws.length > 1 && POP[inTag[i]] === ws.length ? 2 : 0);
      if (n < most) sc *= n >= need ? 0.7 : 0.55;
      if (sc > top) top = sc;
      hits.push({ i, score: sc, have: n, places: places[i], pol: 0 });
    }
    score[i] = 0; have[i] = 0; inTag[i] = 0; places[i] = 0;
  }
  // the weak answers go: a word found only in a cite or the read text, when other cards say it outright
  const weakOut = (list, share) => {
    if (list.length <= 12) return list;
    const floor = list.reduce((m, h) => Math.max(m, h.score), 0) * share;
    const strong = list.filter((h) => h.score >= floor);
    return strong.length >= 8 ? strong : list;
  };
  // (a search that denies something is weighed after its cards have been read for which way they argue)
  if (!ask.negated && hits.length > 12) { const floor = top * 0.42; const strong = hits.filter((h) => h.score >= floor); if (strong.length >= 8) hits = strong; }
  hits.sort((x, y) => y.score - x.score);
  const total = hits.length;
  // which way each of the best argues, and the phrase itself in a tag
  const phrase = ws.join(' ');
  const look = hits.slice(0, ask.negated ? 6000 : Math.max(limit * 2, 3000));
  let opposite = 0;
  if (tagOf) {
    const judging = ask.negated || ask.all.size >= 2;
    for (const h of look) {
      const tag = String(tagOf(h.i) || '');
      if (ws.length > 1 && tag.toLowerCase().includes(phrase)) h.score += 4;
      if (!judging) continue;
      let pol = judge(ask, tag);
      if (!pol && blockOf && ask.negated) { const b = blockOf(h.i); if (b) pol = judge(ask, b, isAnswers(b)); }
      h.pol = pol;
      if (pol > 0) h.score *= pol === 1 ? 1.5 : 1.25;
      else if (pol < 0) { h.score *= 0.5; opposite++; }
      // let in only for what it is about: it stays only if it denies something
      else if (ask.negated && h.have < need) h.score = 0;
    }
    look.sort((x, y) => y.score - x.score);
    while (look.length && look[look.length - 1].score === 0) look.pop();
  }
  let out = look, flipped = false;
  if (ask.negated && opposite) {
    const agree = look.filter((h) => h.pol > 0);
    // enough cards say it: only those; a few: those and the ones that do not say either way
    out = agree.length >= 5 ? agree : look.filter((h) => h.pol >= 0);
    // nothing says it: the cards that say the opposite, and said to be that
    if (!out.length) { out = look; flipped = true; }
    out = weakOut(out, 0.3);
  } else opposite = 0;
  return { hits: out.slice(0, limit), terms: ws, total: out === look ? total : out.length, most, of: ws.length, opposite, flipped, negated: ask.negated };
}
