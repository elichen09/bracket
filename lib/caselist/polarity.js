/**
 * Which way a tag argues.
 *
 * "Mirror bacteria doesn't cause extinction" and "Mirror bacteria causes
 * extinction" are the same words, and opposite cards. A search by words alone
 * cannot tell them apart, so this reads the one thing that does: what is
 * being denied. A denial reaches the words after it ("doesn't cause
 * extinction", "no war from decline") or, for the words that come last
 * ("deterrence fails", "extinction is unlikely"), the words before it — never
 * past the end of its clause, so "X causes extinction — no defense" still
 * says extinction.
 *
 * A search that denies something wants the cards that deny it too, and not
 * the ones that assert it; a search that asserts something would rather not
 * be answered by its own answer. A block headed "AT: …" holds the cards that
 * answer what it names, so under one the block's words count the other way.
 */

import { stem, canon, STOP } from './search';

// what denies the words after it
const BEFORE = new Set(('no not never none nor neither cannot cant wont doesnt dont isnt arent wasnt werent wouldnt couldnt shouldnt ' +
  'didnt hasnt havent hadnt aint').split(' '));
// what denies the words before it
const AFTER = new Set(('fails fail failed failing false wrong unlikely impossible improbable implausible overblown exaggerated overstated ' +
  'overhyped hype myth alarmism alarmist debunked disproven denied untrue').split(' '));
const REACH = 6;          // how many words on a "no" or a "doesn't" denies
const BACK = 3;           // how many words back "fails" or "is wrong" does: "X makes Y impossible" denies Y, not X
// any denial at all — most tags have none, and are read the quick way
const ANY = /\b(no|not|never|none|nor|neither|cannot|aint|fail\w*|false|wrong|unlikely|impossible|improbable|implausible|overblown|exaggerated|overstated|overhyped|hype|myth|alarmis[mt]|debunked|disproven|denied|untrue)\b|n['’‘`]t\b/i;
const NONE = new Set();

const AT_HEAD = /^\s*(a\s*[/-]?\s*t|at|a2|ans|answers?\s+to)\s*[:.\-–—]\s*|^\s*(a\s*\/\s*t|a2|answers?\s+to)\s+/i;
/** Is this a block of answers — "AT: Econ", "A2 heg", "Answers to: the K"? */
export const isAnswers = (heading) => AT_HEAD.test(String(heading || ''));

/** Is this one word a denial — "no", "doesn't", "cannot", "fails"? */
export const isDenial = (word) => {
  const w = String(word || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z']/g, '');
  return /n't$/.test(w) || BEFORE.has(w.replace(/'/g, ''));
};

/** The words of a text, clause by clause; a denying word is kept as what it is. */
function clauses(text) {
  return String(text || '').toLowerCase()
    .replace(/[’‘`]/g, "'")
    .split(/-{2,}|[—–;:.!?,()[\]]| - /)
    .map((c) => (c.match(/[\p{L}\p{N}']+/gu) || []).map((w) => {
      const neg = /n't$/.test(w) || w === 'cannot';
      return { w: w.replace(/'/g, ''), neg, raw: w };
    }).filter((t) => t.w))
    .filter((c) => c.length);
}

const rootOf = (w) => canon(stem(w));

/**
 * The roots a text uses, and which of them it denies. Denied twice is
 * asserted — "no deterrence failure", "claims that deterrence fails are
 * wrong" both say it works. `last` is the last thing denied: what the denial
 * is about ("doesn't cause extinction" is about extinction).
 */
export function stance(text) {
  const all = new Set();
  if (!ANY.test(text)) {
    for (const w of String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) if (!STOP.has(w)) all.add(rootOf(w));
    return { all, neg: NONE, mixed: NONE, last: null, denies: false };
  }
  const said = new Map();                      // root -> [clauses asserting it, clauses denying it]
  const order = [];
  for (const c of clauses(text)) {
    const content = [];                        // [index in clause, root] — the words that say something
    const cues = [];                           // indexes of the words that deny what came before them
    c.forEach((t, i) => {
      if (t.neg || BEFORE.has(t.w)) return;
      if (AFTER.has(t.w)) { cues.push(i); return; }
      if (STOP.has(t.w)) return;
      const r = rootOf(t.w);
      content.push([i, r]);
      all.add(r);
    });
    const times = new Map();                   // root -> how many times this clause denies it
    const fore = new Set();
    c.forEach((t, i) => {
      if (!(t.neg || BEFORE.has(t.w))) return;
      let n = 0;
      for (const [at, r] of content) if (at > i && n++ < REACH) fore.add(r);
    });
    for (const r of fore) times.set(r, 1);
    for (const i of cues) {
      for (const [, r] of content.filter(([at]) => at < i).slice(-BACK)) times.set(r, (times.get(r) || 0) + 1);
    }
    const here = new Map();
    for (const [, r] of content) here.set(r, (times.get(r) || 0) % 2);
    for (const [r, denied] of here) {
      let v = said.get(r);
      if (!v) { v = [0, 0]; said.set(r, v); order.push(r); }
      v[denied]++;
    }
  }
  // denied in more clauses than assert it: denied. As many each way: it does not say.
  const neg = new Set(), mixed = new Set();
  let last = null;
  for (const r of order) {
    const [yes, no] = said.get(r);
    if (no > yes) { neg.add(r); last = r; } else if (no && no === yes) mixed.add(r);
  }
  return { all, neg, mixed, last, denies: neg.size > 0 };
}

/** What a search asks for: its words without the denying ones, and what it denies. */
export function asked(q) {
  const s = stance(q);
  const words = [];
  // "china's" is china; "doesn't" is not a word to look for
  for (const c of clauses(q)) for (const t of c) if (!t.neg && !BEFORE.has(t.w)) words.push(...t.raw.split("'").filter(Boolean));
  // what it is about, as against what it denies of it: "mirror bacteria" in "mirror bacteria doesn't cause extinction"
  const topic = new Set([...s.all].filter((r) => !s.neg.has(r)));
  return { ...s, topic, words, negated: s.neg.size > 0 };
}

/**
 * Does a text argue the way the search does? 1 it does, -1 it argues the
 * opposite, 0 it does not say — and 0.5 for a text that denies the thing the
 * search is about without using its words ("No mirror life impact" for
 * "mirror bacteria doesn't cause extinction"). `answers`: the text heads a
 * block of answers, so what it names is what its cards deny.
 */
export function judge(ask, text, answers = false) {
  let t = String(text || '');
  if (AT_HEAD.test(t)) { t = t.replace(AT_HEAD, ''); answers = !answers; }
  const s = stance(t);
  if (ask.negated) {
    // what the denial is about decides it: "no nuclear war" is answered by a card denying war, not one denying "nuclear"
    if (ask.last && s.all.has(ask.last)) {
      if (s.mixed.has(ask.last)) return 0;
      return s.neg.has(ask.last) !== answers ? 1 : -1;
    }
    const present = [...ask.neg].filter((r) => s.all.has(r));
    if (present.length) {
      // it is about something else the search named: the opposite if it asserts it, not known if it denies it
      return present.some((r) => s.neg.has(r)) !== answers ? 0 : -1;
    }
    // none of the denied words — but it denies the thing itself, or sits among the answers to it
    let about = false, denied = false;
    for (const r of ask.topic) if (s.all.has(r)) { about = true; if (s.neg.has(r)) denied = true; }
    if (!about) return 0;
    if (answers) return denied ? -1 : 0.5;
    return denied ? 0.5 : 0;
  }
  // asserting: only a text that denies most of what was asked about is the opposite
  let shared = 0, denied = 0;
  for (const r of ask.all) if (s.all.has(r)) { shared++; if (s.neg.has(r)) denied++; }
  if (shared < 2 || !denied) return 0;
  return denied * 2 >= shared ? -1 : 0;
}
