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
 * "nuclear"), the start of a longer word (as you type), and, failing those,
 * itself with one letter wrong. Cards with every word come first; when no
 * card has every word, the ones with the most do, so a search is never empty
 * for the want of one word.
 *
 * Built once per index, the first time it is searched: an inverted index of
 * word roots to the cards and the places they appear.
 */

const STOP = new Set(('a an and are as at be been but by can could do does for from had has have how if in into is it its ' +
  'may more most no not of on or our so such than that the their them then there these they this those to was were what ' +
  'when which who will with would you your vs v').split(' '));

/** A word's root, near enough: plurals, -ing, -ed, -ly and the like taken off. */
export function stem(w) {
  w = String(w || '').toLowerCase();
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
  'extinction extinct', 'enviro environment environmental', 'mil military militarize militarization', 'sanction sanctions',
  'nato alliance', 'cyber cyberattack cybersecurity', 'space satellite orbital', 'pandemic disease bioweapon',
  'trade tariff', 'immigration immigrant migrant', 'ev electric', 'renewable solar wind', 'innovation innovate',
  'midterm midterms election', 'unemployment job jobs', 'recession downturn', 'inflation price',
].map((g) => g.split(' ').map(stem));
const SAME_AS = new Map();
for (const g of SAME) for (const w of g) SAME_AS.set(w, new Set([...(SAME_AS.get(w) || []), ...g.filter((x) => x !== w)]));

const words = (s) => (String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
const roots = (s) => words(s).filter((w) => !STOP.has(w)).map(stem).filter(Boolean);

// where a word appears, and what a match there is worth
const TAG = 1, BLOCK = 2, READ = 4, CITE = 8;
const WEIGHT = { [TAG]: 3, [BLOCK]: 2, [READ]: 1.4, [CITE]: 0.8 };

/**
 * Build the search for one index: cards are [docIndex, tag, cite, rounds,
 * blockIndex?, readWords?], blocks the block headings they point at.
 */
export function buildSearch(cards, blocks = []) {
  const post = new Map();          // root -> [cardIndex, places] pairs, flat
  const add = (root, i, place) => {
    let l = post.get(root);
    if (!l) { l = []; post.set(root, l); }
    if (l.length && l[l.length - 2] === i) l[l.length - 1] |= place;
    else l.push(i, place);
  };
  const blockRoots = blocks.map((b) => [...new Set(roots(b))]);
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const seen = new Map();
    const note = (list, place) => { for (const r of list) seen.set(r, (seen.get(r) || 0) | place); };
    note(roots(c[1]), TAG);
    if (typeof c[4] === 'number' && blockRoots[c[4]]) note(blockRoots[c[4]], BLOCK);
    if (c[5]) note(roots(c[5]), READ);
    // the cite: its author and year, not every word of the credentials
    if (c[2]) note(roots(String(c[2]).split(/[[(]/)[0]).slice(0, 6), CITE);
    for (const [r, p] of seen) add(r, i, p);
  }
  const vocab = [...post.keys()].sort();
  return { post, vocab, n: cards.length };
}

/** The roots of the index a query word reaches, each with how good a match it is. */
function reach(s, word) {
  const out = new Map();
  const r = stem(word);
  const put = (k, q) => { if (s.post.has(k) && (out.get(k) || 0) < q) out.set(k, q); };
  put(r, 1);
  put(word.toLowerCase(), 1);
  for (const k of SAME_AS.get(r) || []) put(k, 0.85);
  // the start of a longer word — the last word being typed, mostly
  if (r.length >= 3) {
    let lo = 0, hi = s.vocab.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (s.vocab[m] < r) lo = m + 1; else hi = m; }
    for (let i = lo, n = 0; i < s.vocab.length && s.vocab[i].startsWith(r) && n < 60; i++, n++) put(s.vocab[i], s.vocab[i] === r ? 1 : 0.7);
  }
  // one letter wrong, for a word long enough to mistype, when nothing else reached
  if (!out.size && r.length >= 5) {
    for (const k of s.vocab) {
      if (Math.abs(k.length - r.length) > 1 || k[0] !== r[0]) continue;
      if (within1(k, r)) put(k, 0.55);
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

/**
 * The cards that answer `q`: [{ i, score, have, places }] best first, where
 * `have` is how many of the query's words the card answers and `places` where
 * it matched (TAG, BLOCK, READ, CITE bits). Only the cards answering the most
 * words come back.
 */
export function searchCards(s, q, tagOf) {
  let ws = words(q).filter((w) => !STOP.has(w));
  if (!ws.length) ws = words(q);
  ws = [...new Set(ws)].slice(0, 8);
  if (!ws.length) return { hits: [], terms: [] };
  const acc = new Map();            // card -> { score, have (bit per word), places }
  ws.forEach((w, wi) => {
    for (const [root, quality] of reach(s, w)) {
      const l = s.post.get(root);
      const idf = Math.log(1 + s.n / (l.length / 2));
      for (let k = 0; k < l.length; k += 2) {
        const i = l[k], places = l[k + 1];
        let best = 0;
        for (const p of [TAG, BLOCK, READ, CITE]) if (places & p) best = Math.max(best, WEIGHT[p]);
        let a = acc.get(i);
        if (!a) { a = { score: 0, have: 0, places: 0, per: new Float32Array(ws.length) }; acc.set(i, a); }
        const v = best * quality * idf;
        // a word counts once per card, at its best match
        if (v > a.per[wi]) { a.score += v - a.per[wi]; a.per[wi] = v; }
        a.have |= 1 << wi;
        a.places |= places;
      }
    }
  });
  let most = 0;
  const count = (m) => { let n = 0; while (m) { n += m & 1; m >>= 1; } return n; };
  for (const a of acc.values()) { a.n = count(a.have); if (a.n > most) most = a.n; }
  const phrase = ws.join(' ');
  const hits = [];
  for (const [i, a] of acc) {
    if (a.n < most) continue;
    let score = a.score;
    if (tagOf) { const t = tagOf(i).toLowerCase(); if (ws.length > 1 && t.includes(phrase)) score += 4; }
    hits.push({ i, score, have: a.n, places: a.places });
  }
  hits.sort((x, y) => y.score - x.score);
  return { hits, terms: ws, most, of: ws.length };
}

export const PLACE = { TAG, BLOCK, READ, CITE };
