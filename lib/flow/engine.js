/**
 * Flow — the round, written down.
 *
 * A flow is a grid: one column per speech, one row per argument, and the
 * answer to something sits to the right of the thing it answers. That is the
 * whole idea, and every keystroke in here serves it — Enter goes down the
 * column you are in, Tab goes across to answer, and the column the timer says
 * is live is the one the tool widens and tints.
 *
 * It is built the way Evidence is: React renders the shell once and this owns
 * everything inside it. A round is fast and a re-render per keystroke is not,
 * so the grid is written as HTML and patched in place.
 *
 * Sections
 *   1  state and persistence
 *   2  drawing the grid
 *   3  the cursor, ranges, and which screen is live
 *   4  selection and editing
 *   5  structural edits, all undoable
 *   6  mouse: click, drag a cell, drag a row, the hover ×, the menu
 *   7  keyboard and clipboard
 *   8  sheets
 *   9  the clock
 *  10  the drawer: notes, cards, and what Evidence just sent
 *  11  round vision: named stops across every sheet, walked through in a speech
 *  12  the command panel
 *  13  flowing with your partner
 */

import { columns as colsFor, sheetColumns, columnOn, speeches as speechesFor, clock, PREP_DEFAULT, PREP_CHOICES } from './format';
import { joinFlow, newCode, tidyCode } from './share';
import { library, find, sendToEvidence, blockTags, readBins, setBinUse } from './cards';
import { scoped, adoptLocal } from '../owner';
import { openBus } from '../toolsBus';
import { putRound, getRound, summarizeGrid, gridHasWriting } from '../pastflows';
import { readCase } from './caseread';

const STORE = 'flow.doc';
const NAME_KEY = 'flow.me';
const RM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;


const uid = (p) => p + Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);

/** The marks a flow is written in, which become chips as you type them. */
const TAGS = /\b(dropped|ext|turn|perm|nuq|xa|cx)\b/gi;

export function boot(root, opts = {}) {
  // Whose flow this is: every name it is stored under carries the account.
  const OWNER = opts.owner || null;
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
  const mod = (e) => (isMac ? e.metaKey : e.ctrlKey);
  // Keys, named the way this computer names them: Ctrl+K and Alt+1 on Windows
  // and Linux, the symbols only on a Mac. kb('mod+shift+Z') -> Ctrl+Shift+Z.
  const KB = isMac
    ? { mod: '⌘', alt: '⌥', shift: '⇧', enter: '↵', tab: '⇥', back: '⌫', esc: 'esc', sep: '' }
    : { mod: 'Ctrl', alt: 'Alt', shift: 'Shift', enter: 'Enter', tab: 'Tab', back: 'Backspace', esc: 'Esc', sep: '+' };
  const kb = (spec) => String(spec).split('+').map((p) => (KB[p] !== undefined ? KB[p] : p)).join(KB.sep);
  const offs = [];
  const on = (el, ev, fn, o) => { if (!el) return; el.addEventListener(ev, fn, o); offs.push(() => el.removeEventListener(ev, fn, o)); };

  /* ================================================================
     1. State
     ================================================================ */

  /** How many columns a sheet has: its case, then the answers, both ways, through final focus. */
  const NCOL = 7;
  const blankC = () => Array(NCOL).fill('');
  const blankRows = (n = 6) => Array.from({ length: n }, () => ({ id: uid('r'), c: blankC() }));

  const freshDoc = () => ({
    id: uid('g'),
    created: Date.now(),
    layout: 2,
    first: 'pro',
    prep: PREP_DEFAULT,
    meta: { tourn: '', round: '', side: 'pro' },
    notes: '',
    vision: [],
    sheets: [
      { id: uid('s'), name: 'Pro case', side: 'pro', rows: blankRows() },
      { id: uid('s'), name: 'Con case', side: 'con', rows: blankRows() },
    ],
  });

  const S = load() || freshDoc();
  // A round's id is what Past flows files it under, so it is written down the
  // moment it exists rather than at the first edit.
  try { localStorage.setItem(scoped(STORE, OWNER), JSON.stringify(S)); } catch { /* private browsing */ }

  let SP = speechesFor(S.first);

  function load() {
    try {
      const raw = adoptLocal(STORE, OWNER);
      if (!raw) return null;
      return repair(JSON.parse(raw));
    } catch { return null; }
  }

  /** A round as stored, made whole: anything written by an older shape is repaired rather than thrown out. */
  function repair(d) {
    try {
      if (!d || !Array.isArray(d.sheets) || !d.sheets.length) return null;
      d.id = d.id || uid('g');
      d.created = d.created || Date.now();
      d.first = d.first === 'con' ? 'con' : 'pro';
      const old = d.layout !== 2;
      d.sheets.forEach((s) => {
        s.id = s.id || uid('s');
        s.side = s.side === 'con' ? 'con' : 'pro';
        s.rows = (s.rows || []).map((r) => Object.assign({ id: r.id || uid('r') }, r,
          r.c ? { c: Array.from({ length: old ? 8 : NCOL }, (_, i) => (r.c[i] || '')) } : null));
      });
      d.notes = d.notes || '';
      if (old) relayout(d);
      d.prep = Number(d.prep) || PREP_DEFAULT;
      d.meta = d.meta || { tourn: '', round: '', side: 'pro' };
      // Round vision replaced the roadmap: its lines come across as stops that
      // do not point at a cell yet.
      d.vision = Array.isArray(d.vision) ? d.vision : [];
      if (Array.isArray(d.road) && d.road.length) {
        d.road.forEach((name) => d.vision.push({ id: uid('v'), name: String(name), sheet: null, row: null, col: 0 }));
      }
      delete d.road;
      return d;
    } catch { return null; }
  }

  /**
   * A round written when every sheet had all eight speeches as columns, laid
   * out the way sheets are now: its own case, then the chain of answers. The
   * other side's constructive has no column on a sheet any more; anything
   * written there goes into the round's notes rather than being lost.
   */
  function relayout(d) {
    const g = colsFor(d.first);
    const moved = [];
    d.sheets.forEach((s) => {
      const mine = sheetColumns(s.side);
      const from = mine.map((col) => g.findIndex((x) => x.key === col.key));
      const gone = g.findIndex((x) => x.side !== s.side && x.key.endsWith('CASE'));
      s.rows.forEach((r) => {
        if (!r.c) return;
        const was = r.c;
        if (gone >= 0 && (was[gone] || '').trim()) moved.push(`${s.name} · ${g[gone].key}: ${was[gone].replace(/\n/g, ' / ')}`);
        r.c = from.map((i) => was[i] || '');
      });
    });
    (d.vision || []).forEach((v) => {
      const sh = d.sheets.find((x) => x.id === v.sheet);
      if (!sh || v.col == null) return;
      v.col = Math.max(0, columnOn(sh.side, d.first, v.col));
    });
    if (moved.length) d.notes = (d.notes ? d.notes + '\n\n' : '') + 'Moved here when each flow got its own columns:\n' + moved.join('\n');
    d.layout = 2;
    return d;
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(scoped(STORE, OWNER), JSON.stringify(S)); } catch { /* private browsing */ }
    }, 350);
    archiveSoon();
  }

  // Every round is kept in Past flows as it is flowed — a copy taken now, so
  // what is saved is this round even if the next one has started by the time
  // the write lands. A round with nothing written in it is not worth a row.
  let archTimer = null;
  function archiveSoon() { clearTimeout(archTimer); archTimer = setTimeout(archiveNow, 1500); }
  function archiveNow() {
    clearTimeout(archTimer);
    if (!gridHasWriting(S)) return;
    putRound(OWNER, summarizeGrid(JSON.parse(JSON.stringify(S)), Date.now()));
  }

  const sheetById = (id) => S.sheets.find((s) => s.id === id);
  const rowIndex = (sheet, id) => sheet.rows.findIndex((r) => r.id === id);

  /* the two screens */
  const PANES = $$('.pw').map((el, i) => ({
    i,
    root: el,
    flow: el.querySelector('.flow'),
    grid: el.querySelector('.grid'),
    cursor: el.querySelector('.cursor'),
    lab: el.querySelector('.cursor .lab'),
    hx: el.querySelector('.hx'),
    dl: el.querySelector('.dropline'),
    select: el.querySelector('.psheet'),
    cur: Math.min(i, S.sheets.length - 1),
    sel: null,
    anchor: null,
    hxCell: null,
  }));
  let A = PANES[0];
  let split = null;
  let editing = null;
  let before = '';
  let editSnap = null;
  let focusOn = true;
  let fs = 15;

  const visible = () => (split ? PANES : [PANES[0]]);
  const sheetOf = (p = A) => S.sheets[p.cur] || S.sheets[0];
  const rows = (p = A) => sheetOf(p).rows;
  const paneOf = (el) => PANES.find((p) => p.root.contains(el));
  const LAST = NCOL - 1;
  /** The columns of the sheet on a screen, or of a given sheet. */
  const colsOf = (p = A) => sheetColumns(sheetOf(p).side);
  const colsOn = (sheet) => sheetColumns(sheet && sheet.side === 'con' ? 'con' : 'pro');
  /** Where the speech on the clock is written on a screen's sheet, or -1. */
  const liveCol = (p = A) => (tmode === 'sp' ? columnOn(sheetOf(p).side, S.first, SP[ti].col) : -1);

  /* undo / redo — a snapshot of everything both screens can see */
  const UNDO = [];
  const REDO = [];
  const state = () => JSON.stringify({ sheets: S.sheets, panes: PANES.map((p) => ({ cur: p.cur, sel: p.sel })), a: A.i, first: S.first });
  function snap() { UNDO.push(state()); if (UNDO.length > 300) UNDO.shift(); REDO.length = 0; }
  function travel(from, to, label) {
    if (editing) commit();
    const s = from.pop();
    if (!s) return toast('Nothing to ' + label.toLowerCase());
    to.push(state());
    const o = JSON.parse(s);
    S.sheets = o.sheets;
    S.first = o.first || S.first;
    SP = speechesFor(S.first);
    PANES.forEach((p, i) => { p.cur = Math.min(o.panes[i].cur, S.sheets.length - 1); p.sel = o.panes[i].sel; p.anchor = null; });
    A = PANES[split ? o.a : 0];
    // An undone flip changes which speech the clock is naming, too.
    paintActive(); renderAll(); paintT(); save(); pushDoc();
    const el = A.sel && cellEl(A.sel.r, A.sel.c);
    if (el) flash(el);
    toast(label);
  }
  const undo = () => travel(UNDO, REDO, 'Undone');
  const redo = () => travel(REDO, UNDO, 'Redone');

  /* ================================================================
     2. Drawing
     ================================================================ */

  function fmt(t) {
    let h = esc(t);
    h = h.replace(/^→/, '<span class="arr">→</span>');
    return h.replace(TAGS, (m) => `<span class="tg ${m.toLowerCase()}">${m.toUpperCase()}</span>`);
  }
  const cellEl = (r, c, p = A) => p.grid.querySelector(`.c[data-r="${r}"][data-c="${c}"]`);
  const spoken = (c, p) => rows(p).some((x) => x.c && x.c[c].trim());

  function draw(p, born) {
    const sheet = sheetOf(p);
    // The speech in large type and the side in small, the way a flow pad's
    // columns are headed: CASE over the Pro half, REB over the Con.
    let html = '<div class="h gh"></div>';
    const cols = colsOn(sheet);
    cols.forEach((col, i) => {
      const [side, ...leg] = col.key.split(' ');
      html += `<div class="h ${col.side}" data-col="${i}" title="${esc(col.long)} — jump here">` +
        `<b>${esc(leg.join(' '))}</b><span class="sd">${esc(side)}</span>` +
        '<span class="lv"><i></i>live</span><span class="ct"></span></div>';
    });
    let hi = 0;
    sheet.rows.forEach((row, ri) => {
      const b = born && born.includes(ri) ? ' born' : '';
      if (row.h !== undefined && !row.c) {
        hi++;
        html += `<div class="rh${b}" data-r="${ri}"><span class="k">[${String(hi).padStart(2, '0')}]</span>` +
          `<span class="hn">${esc(row.h)}</span><em>${esc(row.t || '')}</em></div>`;
        return;
      }
      html += `<div class="r" data-r="${ri}"><div class="g${b}" data-r="${ri}">` +
        '<span class="grip" title="Drag to move this row">⣿</span>' +
        `<button type="button" class="del" data-r="${ri}" title="Delete row" aria-label="Delete row">×</button></div>` +
        row.c.map((t, ci) => {
          const n = stopNumber(sheet.id, row.id, ci);
          return `<div class="c ${cols[ci].side}${b}" data-r="${ri}" data-c="${ci}"${n ? ` data-stop="${n}"` : ''}>${fmt(t)}</div>`;
        }).join('') +
        '</div>';
    });
    html += '<div class="end"></div>';
    p.grid.innerHTML = html;
    // A different sheet arrives rather than replacing the last one in place.
    if (p.shown !== sheet.id) {
      p.shown = sheet.id;
      if (!RM) { p.grid.classList.remove('swap'); void p.grid.offsetWidth; p.grid.classList.add('swap'); }
    }

    p.select.innerHTML = S.sheets.map((s, i) => `<option value="${i}"${i === p.cur ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    p.root.querySelector('.pside').textContent = sheet.side;

    if (p.sel && !(sheet.rows[p.sel.r] && sheet.rows[p.sel.r].c)) {
      const r = nearestRow(p.sel.r, p);
      p.sel = r == null ? null : { r, c: p.sel.c };
    }
    if (!p.sel) p.sel = firstSel(p);
    marks(p); widths(p); paintRange(p); placeCursor(p, true); hideHx(p); paintPeers(p); paintStops(p);
  }

  function render(born) {
    draw(A, born);
    visible().forEach((p) => { if (p !== A) draw(p); });
    chrome(); markLive();
  }
  const renderAll = () => render();
  function syncOthers() { visible().forEach((p) => { if (p !== A && p.cur === A.cur) draw(p); }); }

  function chrome() {
    $('#tabs').innerHTML = S.sheets.map((s, i) =>
      // The side is said once: not again after a name like "Pro case" that says it already.
      `<button type="button" role="tab" class="${s.side}" data-i="${i}" aria-selected="${i === A.cur}" title="Click again to rename · × to delete · right-click for more">${esc(s.name)}` +
      `${new RegExp('\\b' + s.side + '\\b', 'i').test(s.name) ? '' : `<i>${s.side}</i>`}` +
      `<span class="tx" data-del="${i}" title="Delete this flow" aria-label="Delete ${esc(s.name)}">×</span></button>`).join('') +
      '<button type="button" class="plus" data-add="pro">+ Pro</button><button type="button" class="plus" data-add="con">+ Con</button>' +
      '<button type="button" class="plus sdp" data-sdopen title="Their case off SpeechDrop, tags down a column">⇩ SpeechDrop</button>';
    $('#crumb').textContent = sheetOf().name + (split ? ' · screen ' + (A.i ? 'B' : 'A') : '');
    // A stop's line in the list names its sheet and column, which a render can change.
    paintVision();
  }

  function nearestRow(r, p = A) {
    const rs = rows(p);
    for (let d = 0; d < rs.length; d++) {
      if (rs[r + d] && rs[r + d].c) return r + d;
      if (rs[r - d] && rs[r - d].c) return r - d;
    }
    return null;
  }
  function firstSel(p = A) {
    const rs = rows(p);
    const i = rs.findIndex((x) => x.c);
    if (i < 0) return null;
    // a sheet's first column is its own case
    return { r: i, c: 0 };
  }

  /**
   * The two marks that make a flow readable at a glance: a red edge on an
   * argument the other side has not answered, and hatching on the cell where
   * that answer should have gone.
   */
  function marks(p = A) {
    const cols = colsOf(p);
    const sp = cols.map((_, i) => spoken(i, p));
    const cells = [...p.grid.querySelectorAll('.c')];
    cells.forEach((el) => {
      const r = +el.dataset.r, c = +el.dataset.c, row = rows(p)[r].c;
      const open = row[c].trim() && c < LAST && sp[c + 1] && !row[c + 1].trim() && !row.slice(c + 2).some((x) => x.trim());
      el.classList.toggle('open', !!open);
      el.title = open ? `No answer in ${cols[c + 1].key}` : '';
    });
    cells.forEach((el) => {
      const c = +el.dataset.c;
      const prev = c > 0 ? cellEl(+el.dataset.r, c - 1, p) : null;
      el.classList.toggle('miss', !!(prev && prev.classList.contains('open')));
    });
    cols.forEach((_, i) => {
      const n = rows(p).filter((x) => x.c && x.c[i].trim()).length;
      const h = p.grid.querySelector(`.h[data-col="${i}"] .ct`);
      if (h) h.textContent = n || '';
    });
  }

  /** The column you are in, and the one it answers, get the room. */
  function widths(p = A) {
    const w = colsOf(p).map(() => 1);
    if (focusOn && p.sel) { w[p.sel.c] = 1.8; if (p.sel.c > 0) w[p.sel.c - 1] = 1.35; }
    const narrow = split === 'side';
    const lo = narrow ? 84 : 112, hi = narrow ? 140 : 180;
    p.grid.style.minWidth = narrow ? '820px' : '1080px';
    const next = '24px ' + w.map((x) => `minmax(${x > 1 ? hi : lo}px,${x}fr)`).join(' ');
    if (p.grid.style.gridTemplateColumns === next) return;
    // In one step, and with the cell you are in held still. Animating the
    // widths re-wrapped every other column's text at each step on the way,
    // rows above grew in jumps, and the cell being written in hopped down the
    // screen two or three times. Now the widths change once, and the view
    // scrolls by exactly as much as the rows above moved, so the cell stays
    // where your eye already is.
    const el = p.sel && cellEl(p.sel.r, p.sel.c, p);
    const before = el ? el.getBoundingClientRect().top : null;
    p.grid.style.gridTemplateColumns = next;
    if (el && before !== null) {
      const moved = el.getBoundingClientRect().top - before;
      if (moved) p.flow.scrollTop += moved;
    }
    placeCursor(p, true);
  }

  /* ================================================================
     3. The cursor
     ================================================================ */

  function placeCursor(p = A, instant) {
    const el = p.sel && cellEl(p.sel.r, p.sel.c, p);
    p.grid.querySelectorAll('.c.sel').forEach((x) => { if (x !== el) x.classList.remove('sel'); });
    if (!el) { p.cursor.hidden = true; return; }
    el.classList.toggle('sel', p === A);
    p.cursor.hidden = false;
    if (instant) p.cursor.style.transition = 'none';
    p.cursor.style.transform = `translate(${el.offsetLeft}px,${el.offsetTop}px)`;
    // Never past the grid's right edge: a pixel over put a scrollbar under the flow.
    p.cursor.style.width = Math.min(el.offsetWidth + 1, p.grid.offsetWidth - el.offsetLeft) + 'px';
    p.cursor.style.height = el.offsetHeight + 1 + 'px';
    const ed = p === A && !!editing;
    p.cursor.classList.toggle('editing', ed);
    p.cursor.classList.toggle('range', !!p.anchor);
    // The cursor wears the colour of the side whose column it is in.
    const col = colsOf(p)[p.sel.c] || colsOf(p)[0];
    p.cursor.classList.toggle('pro', col.side === 'pro');
    p.cursor.classList.toggle('con', col.side === 'con');
    p.cursor.classList.toggle('top', el.offsetTop < 70);
    p.lab.textContent = col.key + (ed ? ' · editing' : p.anchor ? ` · ${rangeCells(p).length} cells` : '');
    if (instant) { p.cursor.getBoundingClientRect(); p.cursor.style.transition = ''; }
    if (p === A) pushCaret();
  }
  function follow(p, ms) {
    if (RM) return placeCursor(p, true);
    const t0 = performance.now();
    (function f() {
      placeCursor(p, true);
      if (performance.now() - t0 < ms) requestAnimationFrame(f);
      else paintPeers(p);          // your partner's cursor is placed by position too
    })();
  }
  PANES.forEach((p) => {
    // Anything drawn over the grid by position has to move when a row grows.
    const ro = new ResizeObserver(() => { placeCursor(p, true); paintStops(p); paintPeers(p); });
    ro.observe(p.grid);
    offs.push(() => ro.disconnect());
  });
  function reveal(el, p = A) {
    const f = p.flow, a = el.getBoundingClientRect(), b = f.getBoundingClientRect();
    if (a.bottom > b.bottom - 20) f.scrollTop += a.bottom - b.bottom + 60;
    if (a.top < b.top + 60) f.scrollTop -= b.top + 60 - a.top;
    if (a.right > b.right) f.scrollLeft += a.right - b.right + 20;
    if (a.left < b.left + 26) f.scrollLeft -= b.left + 26 - a.left;
  }
  function flash(el) { if (!el) return; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

  function rangeCells(p = A) {
    const s = p.sel, a = p.anchor;
    if (!a || !s) return s ? [s] : [];
    const r0 = Math.min(a.r, s.r), r1 = Math.max(a.r, s.r), c0 = Math.min(a.c, s.c), c1 = Math.max(a.c, s.c);
    const out = [];
    for (let r = r0; r <= r1; r++) { if (!rows(p)[r] || !rows(p)[r].c) continue; for (let c = c0; c <= c1; c++) out.push({ r, c }); }
    return out;
  }
  function paintRange(p = A) {
    p.grid.querySelectorAll('.c.inrange').forEach((x) => x.classList.remove('inrange'));
    if (!p.anchor) return;
    rangeCells(p).forEach(({ r, c }) => { const el = cellEl(r, c, p); if (el) el.classList.add('inrange'); });
  }

  function activate(p) {
    if (p === A) return;
    if (editing) commit();
    const prev = A; A = p;
    paintActive(); placeCursor(prev, true); placeCursor(A, true); chrome(); markLive();
  }
  function paintActive() { PANES.forEach((x) => x.root.classList.toggle('active', x === A)); }

  /* ================================================================
     4. Selection and editing
     ================================================================ */

  function setSel(r, c, edit, extend) {
    if (editing) commit();
    if (extend) { if (!A.anchor) A.anchor = { ...A.sel }; } else A.anchor = null;
    A.sel = { r, c };
    paintRange(); widths(); placeCursor();
    const el = cellEl(r, c);
    if (el) requestAnimationFrame(() => reveal(el));
    if (edit) startEdit(); else A.flow.focus({ preventScroll: true });
  }
  function startEdit(initial) {
    const el = cellEl(A.sel.r, A.sel.c);
    if (!el) return;
    A.anchor = null; paintRange();
    editing = el;
    before = rows()[A.sel.r].c[A.sel.c];
    editSnap = state();
    el.textContent = before + (initial || '');
    el.classList.add('editing');
    el.contentEditable = 'plaintext-only';
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.focus({ preventScroll: true });
    caretEnd(el); hideHx(A); placeCursor();
  }
  function caretEnd(el) {
    const rg = document.createRange();
    rg.selectNodeContents(el); rg.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(rg);
  }
  function commit() {
    const el = editing;
    if (!el) return;
    editing = null;
    const p = paneOf(el) || A;
    const r = +el.dataset.r, c = +el.dataset.c;
    const t = el.textContent.replace(/\n+$/, '');
    const row = rows(p)[r];
    row.c[c] = t;
    el.contentEditable = 'false';
    el.classList.remove('editing');
    el.innerHTML = fmt(t);
    if (t !== before) {
      UNDO.push(editSnap); REDO.length = 0;
      const had = (before.match(TAGS) || []).length, now = (t.match(TAGS) || []).length;
      if (now > had) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
      visible().forEach((q) => { if (q !== p && q.cur === p.cur) draw(q); });
      save();
      pushCell(sheetOf(p).id, row.id, c, t);
    }
    marks(p); placeCursor(p);
  }
  function nextCell(r, d) {
    const rs = rows();
    let n = r + d;
    while (n >= 0 && n < rs.length && !rs[n].c) n += d;
    return n >= 0 && n < rs.length ? n : null;
  }
  function caretLine(el) {
    const s = getSelection();
    if (!s.rangeCount) return { first: true, last: true };
    const rg = s.getRangeAt(0), p = rg.getBoundingClientRect(), b = el.getBoundingClientRect();
    if (!p.height) return { first: true, last: true };
    return { first: p.top - b.top < fs * 1.6, last: b.bottom - p.bottom < fs * 1.6 };
  }

  /* ================================================================
     5. Structural edits
     ================================================================ */

  function insertRow(at, c, edit) {
    snap();
    rows().splice(at, 0, { id: uid('r'), c: blankC() });
    render([at]); setSel(at, c, edit); save(); pushRows(sheetOf());
  }
  /** "C1 — Climate" becomes the label and the title the heading row shows. */
  const splitHeading = (s) => {
    const m = String(s || '').match(/^\s*(.+?)\s*(?:—|–|-|·|:)\s*(.+)$/);
    return m ? { h: m[1], t: m[2] } : { h: String(s || '').trim() || 'Untitled', t: '' };
  };
  async function insertHeading(at) {
    const anchor = cellEl(at, A.sel ? A.sel.c : 0) || A.flow;
    const name = await ask('Heading', 'C1 — Warming', anchor, 'A label, a dash, then what it is about');
    if (name === null) return;
    snap();
    rows().splice(at, 0, Object.assign({ id: uid('r') }, splitHeading(name)));
    render([at]); save(); pushRows(sheetOf());
    toast('Heading added');
  }
  function newLineBelow(r, c) {
    const rs = rows();
    let n = r + 1;
    if (n >= rs.length || !rs[n].c) { snap(); rs.splice(n, 0, { id: uid('r'), c: blankC() }); render([n]); pushRows(sheetOf()); }
    setSel(n, c, true);
  }
  function clearCells(list, label) {
    const cells = list.filter(({ r, c }) => rows()[r] && rows()[r].c && rows()[r].c[c]);
    if (!cells.length) return;
    snap();
    cells.forEach(({ r, c }) => { const el = cellEl(r, c); if (el) el.classList.add('gone'); });
    setTimeout(() => {
      cells.forEach(({ r, c }) => {
        const row = rows()[r];
        if (!row) return;
        row.c[c] = '';
        const el = cellEl(r, c);
        if (el) { el.classList.remove('gone'); el.innerHTML = ''; }
        pushCell(sheetOf().id, row.id, c, '');
      });
      marks(); placeCursor(A, true); syncOthers(); save();
      toast(label || (cells.length > 1 ? `Cleared ${cells.length} cells` : 'Cleared'), true);
    }, RM ? 0 : 140);
  }
  function deleteRows(rs, label) {
    rs = [...new Set(rs)].filter((r) => rows()[r] && rows()[r].c).sort((a, b) => b - a);
    if (!rs.length) return;
    snap();
    rs.forEach((r) => A.grid.querySelectorAll(`[data-r="${r}"].c,[data-r="${r}"].g`).forEach((x) => x.classList.add('dying')));
    setTimeout(() => {
      rs.forEach((r) => rows().splice(r, 1));
      if (!rows().length) rows().push({ id: uid('r'), c: blankC() });
      A.sel = A.sel ? { r: Math.min(A.sel.r, rows().length - 1), c: A.sel.c } : null;
      A.anchor = null;
      render(); save(); pushRows(sheetOf());
      toast(label || (rs.length > 1 ? `Deleted ${rs.length} rows` : 'Row deleted'), true);
    }, RM ? 0 : 170);
  }
  /** Take one cell out and pull the rest of that column up into the gap. */
  function deleteCellUp(r, c) {
    snap();
    const rs = rows();
    let i = r;
    while (rs[i + 1] && rs[i + 1].c) { rs[i].c[c] = rs[i + 1].c[c]; i++; }
    rs[i].c[c] = '';
    if (rs[i].c.every((x) => !x.trim()) && i !== r) rs.splice(i, 1);
    render(); setSel(r, c, false); save(); pushRows(sheetOf());
    toast('Cell deleted — column shifted up', true);
  }
  function moveRow(r, d) {
    const rs = rows(), t = r + d;
    if (t < 0 || t >= rs.length) return;
    snap();
    [rs[r], rs[t]] = [rs[t], rs[r]];
    render([t]); setSel(t, A.sel.c, false); save(); pushRows(sheetOf());
  }
  function moveCell(r, c, d) {
    const t = c + d;
    if (t < 0 || t > LAST) return;
    snap();
    const row = rows()[r];
    [row.c[c], row.c[t]] = [row.c[t], row.c[c]];
    render(); setSel(r, t, false); flash(cellEl(r, t)); save(); pushRows(sheetOf());
  }
  function tag(t) {
    const list = A.anchor ? rangeCells() : [A.sel];
    if (editing) {
      const s0 = editing.textContent;
      editing.textContent = s0.startsWith(t + ' ') ? s0.slice(t.length + 1) : t + ' ' + s0.replace(/^(DROPPED|EXT|TURN) /, '');
      caretEnd(editing);
      return;
    }
    if (!A.sel) return;
    snap();
    list.forEach(({ r, c }) => {
      const row = rows()[r];
      if (!row || !row.c) return;
      let s = row.c[c];
      s = s.startsWith(t + ' ') ? s.slice(t.length + 1) : t + ' ' + s.replace(/^(DROPPED|EXT|TURN) /, '');
      row.c[c] = s;
      const el = cellEl(r, c);
      if (el) { el.innerHTML = fmt(s); el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
      pushCell(sheetOf().id, row.id, c, s);
    });
    marks(); syncOthers(); save();
    toast(t === 'DROPPED' ? 'Marked dropped' : t === 'EXT' ? 'Marked extended' : 'Marked turn', true);
  }
  function pasteLines(text) {
    const lines = text.replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length || !A.sel) return;
    snap();
    let r = A.sel.r;
    const born = [];
    lines.forEach((ln, i) => {
      if (i > 0) {
        let n = r + 1;
        if (n >= rows().length || !rows()[n].c) { rows().splice(n, 0, { id: uid('r'), c: blankC() }); born.push(n); }
        r = n;
      }
      rows()[r].c[A.sel.c] = ln;
    });
    render(born); setSel(r, A.sel.c, false); save(); pushRows(sheetOf());
    toast(`Pasted ${lines.length} line${lines.length > 1 ? 's' : ''}`, true);
  }

  /** One sheet, or all of them, as text you can paste anywhere. */
  function asText(all) {
    const list = all ? S.sheets : [sheetOf()];
    return list.map((sheet) => {
      const head = sheet.name + ' (' + sheet.side + ')';
      const body = sheet.rows.map((row) => {
        if (!row.c) return '\n== ' + row.h + (row.t ? ' — ' + row.t : '') + ' ==';
        if (!row.c.some((x) => x.trim())) return '';
        return row.c.map((t, i) => (t.trim() ? colsOn(sheet)[i].key + ': ' + t.replace(/\n/g, ' / ') : '')).filter(Boolean).join('  |  ');
      }).filter((x) => x !== '').join('\n');
      return head + '\n' + '-'.repeat(head.length) + '\n' + body;
    }).join('\n\n\n');
  }
  async function copyText(all) {
    try {
      await navigator.clipboard.writeText(asText(all));
      toast(all ? 'Every flow copied' : 'Flow copied');
    } catch { toast('The clipboard said no'); }
  }

  /* ================================================================
     6. Mouse
     ================================================================ */

  let press = null, drag = null;
  const ghost = document.createElement('div');
  ghost.className = 'ghost'; ghost.hidden = true;
  root.appendChild(ghost);
  offs.push(() => ghost.remove());

  PANES.forEach((p) => {
    on(p.grid, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      activate(p);
      const grip = e.target.closest('.grip');
      if (grip) { e.preventDefault(); if (editing) commit(); press = { kind: 'row', p, r: +grip.parentElement.dataset.r, x: e.clientX, y: e.clientY }; return; }
      const el = e.target.closest('.c');
      if (!el || el === editing) return;
      e.preventDefault();
      const r = +el.dataset.r, c = +el.dataset.c;
      if (e.shiftKey && A.sel) { setSel(r, c, false, true); return; }
      press = { kind: 'cell', p, r, c, x: e.clientX, y: e.clientY };
    });
    on(p.grid, 'click', (e) => {
      const d = e.target.closest('.del');
      if (d) { deleteRows([+d.dataset.r]); return; }
      const h = e.target.closest('.h[data-col]');
      if (h) jumpCol(+h.dataset.col);
      const rh = e.target.closest('.rh');
      if (rh) renameHeading(+rh.dataset.r);
    });
    on(p.grid, 'input', () => {
      if (editing && p === A) { rows()[+editing.dataset.r].c[+editing.dataset.c] = editing.textContent; placeCursor(A, true); }
    });
    on(p.grid, 'contextmenu', (e) => openMenu(e, p));
    on(p.hx, 'pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
    on(p.hx, 'click', () => {
      if (!p.hxCell) return;
      activate(p);
      const r = +p.hxCell.dataset.r, c = +p.hxCell.dataset.c;
      hideHx(p); clearCells([{ r, c }]);
    });
    on(p.flow, 'pointerleave', () => hideHx(p));
    on(p.flow, 'scroll', () => { hideHx(p); paintPeers(p); }, { passive: true });
    on(p.flow, 'focusin', () => activate(p));
    on(p.select, 'change', () => {
      activate(p);
      if (editing) commit();
      p.cur = +p.select.value; p.sel = firstSel(p); p.anchor = null;
      render(); p.flow.scrollTo(0, 0);
    });
    on(p.root.querySelector('.pclose'), 'click', () => closePane(p));
  });

  on(window, 'pointermove', (e) => {
    if (press && !drag && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) {
      if (press.kind === 'cell' && !rows(press.p)[press.r].c[press.c].trim()) return;
      if (editing) commit();
      drag = press;
      document.body.classList.add('flw-dragging');
      ghost.hidden = false; hideHx(drag.p);
      if (drag.kind === 'cell') {
        ghost.innerHTML = esc(rows(drag.p)[drag.r].c[drag.c]) + `<small>${colsOf(drag.p)[drag.c].key}</small>`;
        cellEl(drag.r, drag.c, drag.p).classList.add('dragsrc');
      } else {
        const row = rows(drag.p)[drag.r].c;
        ghost.innerHTML = esc(row.find(Boolean) || 'Empty row') + '<small>row</small>';
        drag.p.grid.querySelectorAll(`[data-r="${drag.r}"].c`).forEach((x) => x.classList.add('dragsrc'));
      }
    }
    if (drag) {
      ghost.style.transform = `translate(${e.clientX + 14}px,${e.clientY + 10}px) rotate(-2deg)`;
      if (drag.kind === 'cell') {
        $$('.c.dropt').forEach((x) => x.classList.remove('dropt'));
        const t = document.elementFromPoint(e.clientX, e.clientY);
        const tc = t && t.closest && t.closest('.c');
        if (tc && tc !== cellEl(drag.r, drag.c, drag.p)) tc.classList.add('dropt');
        drag.target = tc;
        const tp = tc && paneOf(tc);
        if (tp) autoScroll(e, tp);
      } else {
        const at = rowInsertIndex(e.clientY, drag.p);
        drag.to = at;
        drag.p.dl.hidden = false;
        drag.p.dl.style.top = at.y + 'px';
        autoScroll(e, drag.p);
      }
    } else if (!press) hoverHx(e);
  });

  on(window, 'pointerup', (e) => {
    if (drag) {
      document.body.classList.remove('flw-dragging');
      ghost.hidden = true;
      PANES.forEach((p) => { p.dl.hidden = true; });
      $$('.dragsrc').forEach((x) => x.classList.remove('dragsrc'));
      $$('.dropt').forEach((x) => x.classList.remove('dropt'));
      if (drag.kind === 'cell' && drag.target) {
        const tp = paneOf(drag.target), tr = +drag.target.dataset.r, tc = +drag.target.dataset.c;
        snap();
        const from = rows(drag.p)[drag.r].c, to = rows(tp)[tr].c;
        const a = from[drag.c], b = to[tc];
        if (e.altKey) to[tc] = b ? b + '\n' + a : a; else { to[tc] = a; from[drag.c] = b; }
        A = tp; paintActive(); A.sel = { r: tr, c: tc }; A.anchor = null;
        render(); A.flow.focus({ preventScroll: true }); flash(cellEl(tr, tc));
        save(); pushRows(sheetOf(tp)); if (sheetOf(drag.p) !== sheetOf(tp)) pushRows(sheetOf(drag.p));
        toast((e.altKey ? 'Copied' : (b ? 'Swapped' : 'Moved')) + (drag.p !== tp ? ' to screen ' + (tp.i ? 'B' : 'A') : ''), true);
      }
      if (drag.kind === 'row' && drag.to) {
        let to = drag.to.i;
        const from = drag.r;
        if (to !== from && to !== from + 1) {
          snap();
          const [row] = rows().splice(from, 1);
          if (to > from) to--;
          rows().splice(to, 0, row);
          render([to]); setSel(to, A.sel ? A.sel.c : 0, false); save(); pushRows(sheetOf());
          toast('Row moved', true);
        }
      }
      drag = null; press = null;
      return;
    }
    if (press && press.kind === 'cell') { const { r, c } = press; press = null; setSel(r, c, true); return; }
    press = null;
  });

  function rowInsertIndex(y, p) {
    const rs = rows(p);
    let best = { i: rs.length, y: 0 };
    const g = p.grid.getBoundingClientRect();
    for (let i = 0; i < rs.length; i++) {
      const el = rs[i].c ? cellEl(i, 0, p) : p.grid.querySelector(`.rh[data-r="${i}"]`);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      if (y < b.top + b.height / 2) return { i, y: b.top - g.top };
      best = { i: i + 1, y: b.bottom - g.top };
    }
    return best;
  }
  function autoScroll(e, p) {
    const b = p.flow.getBoundingClientRect();
    if (e.clientY > b.bottom - 40) p.flow.scrollTop += 12;
    else if (e.clientY < b.top + 50) p.flow.scrollTop -= 12;
  }

  function hoverHx(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.classList && t.classList.contains('hx')) return;
    const el = t.closest('.c');
    const p = el && paneOf(el);
    PANES.forEach((q) => { if (q !== p) hideHx(q); });
    if (!el || !p || el === editing || !rows(p)[+el.dataset.r].c[+el.dataset.c]) { if (p) hideHx(p); return; }
    p.hxCell = el;
    p.hx.style.left = el.offsetLeft + el.offsetWidth - 21 + 'px';
    p.hx.style.top = el.offsetTop + 4 + 'px';
    p.hx.classList.add('on');
  }
  function hideHx(p) { p.hx.classList.remove('on'); p.hxCell = null; }

  /* the right-click menu */
  const menu = $('#menu');
  function openMenu(e, p) {
    const el = e.target.closest('.c');
    if (!el) return;
    e.preventDefault();
    activate(p);
    const r = +el.dataset.r, c = +el.dataset.c;
    if (!(A.anchor && rangeCells().some((x) => x.r === r && x.c === c))) setSel(r, c, false);
    const many = A.anchor ? rangeCells() : null;
    const items = [
      ['Write in this cell', kb('enter'), () => startEdit()],
      ['Insert row above', '', () => insertRow(r, c, true)],
      ['Insert row below', '', () => insertRow(r + 1, c, true)],
      ['Insert heading above', '', () => insertHeading(r)],
      ['Move row up', keyOf('row.up'), () => moveRow(r, -1)], ['Move row down', keyOf('row.down'), () => moveRow(r, 1)],
      ['Move cell left', keyOf('cell.left'), () => moveCell(r, c, -1)], ['Move cell right', keyOf('cell.right'), () => moveCell(r, c, 1)], '-',
      ['Mark dropped', keyOf('dropped'), () => tag('DROPPED')],
      ['Mark extended', keyOf('ext'), () => tag('EXT')],
      ['Mark turn', keyOf('turn'), () => tag('TURN')],
      [stopAt(A.sel) ? 'Take out of round vision' : 'Add to round vision', keyOf('stop.toggle'), () => toggleStop()],
      ['Find evidence that answers this', keyOf('answer'), () => answerFromEvidence()],
      [split ? 'Open this flow on the other screen' : 'Open in split screen', keyOf('split'), () => openBeside(A.cur)], '-',
      [many ? `Clear ${many.length} cells` : 'Clear cell', kb('back'), () => clearCells(many || [{ r, c }]), 'danger'],
      ['Delete cell, shift column up', keyOf('cell.up'), () => deleteCellUp(r, c), 'danger'],
      [many ? 'Delete these rows' : 'Delete row', keyOf('row.del'), () => deleteRows(many ? many.map((x) => x.r) : [r]), 'danger'],
    ];
    menu.innerHTML = items.map((it, i) => (it === '-' ? '<hr>' :
      `<button type="button" role="menuitem" data-i="${i}" class="${it[3] || ''}"><span>${esc(it[0])}</span>${it[1] ? `<kbd>${esc(it[1])}</kbd>` : ''}</button>`)).join('');
    menu._items = items;
    menu.hidden = false;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(e.clientX, innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(e.clientY, innerHeight - h - 8) + 'px';
    menu.querySelector('button').focus({ preventScroll: true });
  }
  on(menu, 'click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const it = menu._items[+b.dataset.i];
    menu.hidden = true;
    it[2]();
  });
  on(window, 'pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; }, true);

  /* ================================================================
     7. Keyboard and clipboard
     ================================================================ */

  function setSplit(mode) {
    if (editing) commit();
    split = mode;
    const ps = $('#panes');
    ps.classList.toggle('side', mode === 'side');
    ps.classList.toggle('stack', mode === 'stack');
    PANES[1].root.hidden = !mode;
    if (!mode) A = PANES[0];
    else if (PANES[1].cur === PANES[0].cur || !S.sheets[PANES[1].cur]) {
      PANES[1].cur = (PANES[0].cur + 1) % S.sheets.length;
      PANES[1].sel = firstSel(PANES[1]);
    }
    $('#v-split').setAttribute('aria-pressed', String(mode === 'side'));
    $('#v-stack').setAttribute('aria-pressed', String(mode === 'stack'));
    paintActive(); render(); visible().forEach((p) => follow(p, 450));
  }
  function closePane(p) {
    if (p === PANES[0] && split) { const q = PANES[1]; PANES[0].cur = q.cur; PANES[0].sel = q.sel; PANES[0].anchor = null; }
    A = PANES[0]; setSplit(null); toast('Back to one screen');
  }
  function openBeside(i) {
    if (!split) setSplit('side');
    const other = PANES.find((p) => p !== A);
    other.cur = i; other.sel = firstSel(other);
    activate(other); render();
    toast('Opened on screen ' + (other.i ? 'B' : 'A'));
  }
  function swapScreens() {
    if (!split) return;
    activate(PANES.find((p) => p !== A));
    A.flow.focus({ preventScroll: true });
    toast('Writing on screen ' + (A.i ? 'B' : 'A'));
  }

  /* ----------------------------------------------------------------
     Shortcuts you can change.

     Every command with a shortcut is an action with an id, a default, and a
     scope — where it may run. The keys a flow is typed with (arrows, Enter,
     Tab, Backspace, Esc, and letters starting a cell) are not in here: they
     are the grid itself, and rebinding them would break it. Everything else
     can be moved, taken off, or given a shortcut it never had, and the
     choices are kept per account.

     Scopes:
       any   anywhere in the tool, even inside a text box
       flow  anywhere but a text box (a cell being written in counts as the flow)
       cell  needs a selected cell; works while writing in it too
       grid  needs a selected cell, and not while writing in it
     ---------------------------------------------------------------- */

  const ACTIONS = [
    ['Anywhere', 'panel', 'Open the command panel', ['mod+K'], 'any', () => openPal()],
    ['Anywhere', 'answer', 'Find evidence that answers this', ['mod+/'], 'any', () => answerFromEvidence()],
    ['Anywhere', 'drawer', 'Notes, cards, round vision and send doc', ['mod+J'], 'any', () => toggleDrawer()],
    ['Anywhere', 'clock', 'Start / pause the clock', ['mod+.'], 'any', () => toggleTimer()],
    ['Anywhere', 'split', 'Split screen', ['mod+\\'], 'any', () => setSplit(split ? null : 'side')],
    ['Anywhere', 'swap', 'Switch screen', ["mod+'"], 'any', () => swapScreens()],
    ['Anywhere', 'keys', 'Keyboard shortcuts', [], 'any', () => openKeys()],
    ['Round vision', 'stop.toggle', 'Add or remove this cell', ['mod+B'], 'flow', () => { if (editing) commit(); toggleStop(); }],
    ['Round vision', 'stop.next', 'Next stop', ['mod+]'], 'any', () => stepStop(1)],
    ['Round vision', 'stop.prev', 'Previous stop', ['mod+['], 'any', () => stepStop(-1)],
    ['Round vision', 'speak', 'Speak through round vision', [], 'any', () => speak(!speaking)],
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ['Round vision', 'stop.' + n, `Go to stop ${n}`, ['alt+' + n], 'any', () => goStop(n - 1)]),
    ['Editing', 'undo', 'Undo', ['mod+Z'], 'flow', () => undo()],
    ['Editing', 'redo', 'Redo', ['mod+Y', 'mod+shift+Z'], 'flow', () => redo()],
    ['Editing', 'dropped', 'Mark dropped', ['mod+D'], 'cell', () => tag('DROPPED')],
    ['Editing', 'ext', 'Mark extended', ['mod+E'], 'cell', () => tag('EXT')],
    ['Editing', 'turn', 'Mark turn', [], 'cell', () => tag('TURN')],
    ['Editing', 'row.del', 'Delete row', ['mod+Backspace'], 'cell', () => {
      if (editing) { const r = A.sel.r; commit(); return deleteRows([r]); }
      deleteRows(A.anchor ? rangeCells().map((x) => x.r) : [A.sel.r]);
    }],
    ['Editing', 'cell.up', 'Delete cell, shift the column up', ['shift+Backspace'], 'grid', () => deleteCellUp(A.sel.r, A.sel.c)],
    ['Editing', 'row.up', 'Move row up', ['alt+↑'], 'grid', () => moveRow(A.sel.r, -1)],
    ['Editing', 'row.down', 'Move row down', ['alt+↓'], 'grid', () => moveRow(A.sel.r, 1)],
    ['Editing', 'cell.left', 'Move cell left', ['mod+shift+←'], 'grid', () => moveCell(A.sel.r, A.sel.c, -1)],
    ['Editing', 'cell.right', 'Move cell right', ['mod+shift+→'], 'grid', () => moveCell(A.sel.r, A.sel.c, 1)],
    ['Editing', 'row.below', 'Insert row below', [], 'grid', () => insertRow(A.sel.r + 1, A.sel.c, true)],
    ['Editing', 'heading', 'Insert a heading', [], 'grid', () => insertHeading(A.sel.r)],
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => ['Columns', 'col.' + n, () => `Write in column ${n} — ${colsOf()[n - 1].long}`, ['mod+shift+' + n], 'any', () => jumpCol(n - 1)]),
    ['Flows', 'flow.rename', 'Rename this flow', ['F2'], 'flow', () => renameSheet()],
    ['Flows', 'flow.newpro', 'New Pro flow', [], 'flow', () => addSheet('pro')],
    ['Flows', 'flow.newcon', 'New Con flow', [], 'flow', () => addSheet('con')],
    ['Flows', 'flow.delete', 'Delete this flow', [], 'flow', () => deleteSheet()],
    ['Flows', 'flow.copy', 'Copy this flow as text', [], 'flow', () => copyText(false)],
  ].map(([group, id, label, keys, scope, run]) => ({ group, id, label, keys, scope, run }));
  const ACTION = new Map(ACTIONS.map((a) => [a.id, a]));
  const labelOf = (a) => (typeof a.label === 'function' ? a.label() : a.label);

  /** The keys the grid is typed with, shown in the editor but not changeable. */
  const FIXED = [
    ['enter', 'Write in the cell, or the next line down'],
    ['shift+enter', 'A new line inside the cell'],
    ['tab', 'Answer — the next column across'],
    ['↑ ↓ ← →', 'Move'],
    ['shift+↑ ↓ ← →', 'Select a range'],
    ['back', 'Clear the cell'],
    ['esc', 'Stop writing'],
    ['PageDown / Space', 'While speaking: the next stop'],
  ];

  /**
   * What the browser keeps, and what would break typing. Ctrl+1–9 switch
   * tabs and cannot be taken back; the rest can be, but taking Back or the
   * address bar from someone mid-round is not a favour.
   */
  const RESERVED = new Map([
    ['mod+T', 'opens a new tab'], ['mod+W', 'closes the tab'], ['mod+N', 'opens a new window'],
    ['mod+shift+T', 'reopens a closed tab'], ['mod+shift+W', 'closes the window'], ['mod+shift+N', 'opens an incognito window'],
    ['mod+Tab', 'switches tabs'], ['mod+shift+Tab', 'switches tabs'], ['mod+PageUp', 'switches tabs'], ['mod+PageDown', 'switches tabs'],
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ['mod+' + n, 'switches browser tabs']),
    ['alt+←', 'goes Back'], ['alt+→', 'goes Forward'], ['alt+D', 'jumps to the address bar'],
    ['alt+E', 'opens the Chrome menu'], ['alt+F', 'opens the Chrome menu'], ['alt+F4', 'closes the window'],
    ['F5', 'reloads the page'], ['mod+R', 'reloads the page'], ['F11', 'goes full screen'], ['F12', 'opens DevTools'],
    ['mod+shift+I', 'opens DevTools'], ['mod+shift+J', 'opens DevTools'], ['mod+L', 'jumps to the address bar'],
  ]);

  /** Keys that belong to whatever text box has the cursor. */
  const TEXT_NATIVE = new Set(['mod+Z', 'mod+Y', 'mod+shift+Z', 'mod+Backspace', 'mod+Delete', 'shift+Backspace',
    'shift+Delete', 'mod+A', 'mod+C', 'mod+V', 'mod+X', 'mod+←', 'mod+→', 'mod+shift+←', 'mod+shift+→']);

  const KEYNAME = {
    Slash: '/', Period: '.', Comma: ',', Backslash: '\\', Quote: "'", BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  };
  /** A key press as a spec — 'mod+shift+D' — whatever the layout or Caps Lock. */
  function comboOf(e) {
    if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return null;
    const parts = [];
    if (mod(e)) parts.push('mod');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    let k;
    if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
    else if (/^Numpad\d$/.test(e.code)) k = e.code.slice(6);
    else if (KEYNAME[e.code]) k = KEYNAME[e.code];
    else k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    parts.push(k);
    return parts.join('+');
  }

  const KEYS_STORE = scoped('flow.keys', OWNER);
  let BOUND = {};                    // id -> [spec]: only what differs from the default
  try { BOUND = JSON.parse(localStorage.getItem(KEYS_STORE) || '{}') || {}; } catch { BOUND = {}; }
  const keysFor = (id) => (Object.prototype.hasOwnProperty.call(BOUND, id) ? BOUND[id] : (ACTION.get(id) || { keys: [] }).keys);
  let BIND = new Map();
  function rebind() {
    BIND = new Map();
    ACTIONS.forEach((a) => keysFor(a.id).forEach((k) => { if (!BIND.has(k)) BIND.set(k, a); }));
  }
  rebind();
  function saveKeys() { try { localStorage.setItem(KEYS_STORE, JSON.stringify(BOUND)); } catch { /* private browsing */ } }
  /** The first key an action answers to, as this computer names it — or nothing. */
  const keyOf = (id) => { const k = keysFor(id)[0]; return k ? kb(k) : ''; };
  /** Every label on the page that names an action's key, brought up to date. */
  function fillKeys() {
    $$('[data-kb]').forEach((el) => { el.textContent = kb(el.dataset.kb); });
    $$('[data-key]').forEach((el) => {
      const text = el.dataset.key.split('|').map(keyOf).filter(Boolean).join(' ');
      el.textContent = text || 'unset';
      el.classList.toggle('unset', !text);
    });
  }

  /**
   * Whether a key can be given to an action, and if not, why not. Plain
   * keys are for typing; a shortcut needs Ctrl or Alt, or an F key, or
   * Shift with Backspace or Delete.
   */
  function refuse(spec) {
    if (RESERVED.has(spec)) return `${kb(spec)} ${RESERVED.get(spec)} — the browser keeps it`;
    const parts = spec.split('+');
    const key = parts[parts.length - 1];
    const mods = parts.slice(0, -1);
    const fkey = /^F([1-9]|1[0-2])$/.test(key);
    if (mods.includes('mod') || mods.includes('alt') || fkey) return '';
    if (mods.includes('shift') && (key === 'Backspace' || key === 'Delete')) return '';
    return `${kb(spec)} is for typing — use Ctrl or Alt with it, or an F key`;
  }

  /* ----------------------------------------------------------------
     The keyboard. Capture phase on the window, so this runs before
     anything else on the page can take a key — and before the browser
     acts on one.
     ---------------------------------------------------------------- */
  on(window, 'keydown', (e) => {
    if (!root.isConnected) return;
    if (capturing) { captureKey(e); return; }
    const inField = e.target.matches && e.target.matches('input,textarea,select');
    const combo = comboOf(e);
    const action = combo && BIND.get(combo);
    // Claimed first, whatever state the tool is in. A shortcut only claimed
    // once the tool got round to acting on it went to the browser any moment
    // it did not — a text box focused, a menu open, Caps Lock turning d into
    // D — and Ctrl+D bookmarked the page. Inside a text box the keys that
    // mean something to the text (undo, delete a word, copy, jump a word)
    // are left to it. A key the page never sees has been taken by an
    // extension (chrome://extensions/shortcuts).
    if (action && (!inField || !TEXT_NATIVE.has(combo))) e.preventDefault();

    if (!menu.hidden) {
      if (e.key === 'Escape') { menu.hidden = true; A.flow.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const bs = [...menu.querySelectorAll('button')];
        const i = bs.indexOf(document.activeElement);
        bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length].focus();
      }
      return;
    }
    if (!$('#namer').hidden) return;                                    // the naming box has the keys
    if (!$('#keysbox').hidden) { if (e.key === 'Escape') closeKeys(); return; }
    if (!$('#sdbox').hidden) { if (e.key === 'Escape') { e.preventDefault(); closeSd(); } return; }
    if (action && action.scope === 'any') { action.run(); return; }
    if (!$('#scrim').hidden) { palKeys(e); return; }
    if (inField) return;
    // Mid-speech, the keys a presentation clicker sends walk the vision too.
    if (speaking && !editing) {
      if (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) { e.preventDefault(); stepStop(1); return; }
      if (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) { e.preventDefault(); stepStop(-1); return; }
      if (e.key === 'Escape') { e.preventDefault(); speak(false); return; }
    }
    if (action && action.scope === 'flow') { action.run(); return; }
    if (!A.sel) return;
    const { r, c } = A.sel;

    if (editing) {
      if (action && action.scope === 'cell') { action.run(); return; }
      if (e.key === 'Enter' && (e.shiftKey || e.altKey)) return;          // a line break inside the cell
      if (e.key === 'Enter') { e.preventDefault(); commit(); newLineBelow(r, c); return; }
      if (e.key === 'Tab') { e.preventDefault(); commit(); setSel(r, Math.min(LAST, Math.max(0, c + (e.shiftKey ? -1 : 1))), true); return; }
      if (e.key === 'Escape') { e.preventDefault(); commit(); setSel(r, c, false); return; }
      if (e.key === 'Backspace' && !editing.textContent) {
        e.preventDefault(); commit();
        const up = nextCell(r, -1);
        if (rows()[r].c.every((x) => !x.trim())) {
          deleteRows([r], 'Empty row removed');
          if (up != null) setTimeout(() => setSel(up, c, true), RM ? 0 : 180);
        } else if (up != null) setSel(up, c, true);
        return;
      }
      if (e.key === 'ArrowDown' && caretLine(editing).last) { e.preventDefault(); commit(); const n = nextCell(r, 1); if (n != null) setSel(n, c, true); return; }
      if (e.key === 'ArrowUp' && caretLine(editing).first) { e.preventDefault(); commit(); const n = nextCell(r, -1); if (n != null) setSel(n, c, true); return; }
      return;
    }

    if (action && (action.scope === 'cell' || action.scope === 'grid')) { action.run(); return; }
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[e.key] && !mod(e) && !e.altKey) {
      e.preventDefault();
      const [dr, dc] = arrows[e.key];
      const nr = dr ? nextCell(r, dr) : r;
      if (nr == null) return;
      setSel(nr, Math.min(LAST, Math.max(0, c + dc)), false, e.shiftKey);
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); startEdit(); return; }
    if (e.key === 'Tab') { e.preventDefault(); setSel(r, Math.min(LAST, Math.max(0, c + (e.shiftKey ? -1 : 1))), false); return; }
    if (e.key === 'Escape') { A.anchor = null; paintRange(); placeCursor(); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !mod(e) && !e.altKey && !e.shiftKey) { e.preventDefault(); clearCells(A.anchor ? rangeCells() : [{ r, c }]); return; }
    if (e.key.length === 1 && !mod(e) && !e.altKey) { e.preventDefault(); startEdit(rows()[r].c[c] ? ' ' + e.key : e.key); return; }
  }, true);

  /* ----------------------------------------------------------------
     The editor for them.
     ---------------------------------------------------------------- */
  let capturing = null;              // { id, n } while waiting for a key

  function openKeys() {
    if (editing) commit();
    if (!$('#scrim').hidden) closePal();
    $('#keysbox').hidden = false;
    $('#keys-q').value = '';
    paintKeys();
    setTimeout(() => $('#keys-q').focus(), 30);
  }
  function closeKeys() {
    capturing = null;
    $('#keysbox').hidden = true;
    A.flow.focus({ preventScroll: true });
  }
  function paintKeys(note) {
    const q = $('#keys-q').value.trim().toLowerCase();
    let html = '', last = null;
    ACTIONS.forEach((a) => {
      const label = labelOf(a);
      if (q && !(label.toLowerCase().includes(q) || a.group.toLowerCase().includes(q) || keysFor(a.id).some((k) => kb(k).toLowerCase().includes(q)))) return;
      if (a.group !== last) { html += `<li class="kgrp">${esc(a.group)}</li>`; last = a.group; }
      const keys = keysFor(a.id);
      const changed = Object.prototype.hasOwnProperty.call(BOUND, a.id);
      const chips = keys.map((k, n) => {
        const on = capturing && capturing.id === a.id && capturing.n === n;
        return `<button type="button" class="kchip${on ? ' listening' : ''}" data-a="${a.id}" data-n="${n}" title="Click, then press new keys · Backspace to remove">${on ? 'press keys…' : esc(kb(k))}</button>`;
      }).join('');
      const adding = capturing && capturing.id === a.id && capturing.n === keys.length;
      html += `<li class="krow${changed ? ' changed' : ''}"><span class="klb">${esc(label)}</span>` +
        `<span class="kbinds">${chips}<button type="button" class="kchip add${adding ? ' listening' : ''}" data-a="${a.id}" data-n="${keys.length}" title="Add a shortcut">${adding ? 'press keys…' : (keys.length ? '+' : '+ add')}</button></span>` +
        `${changed ? `<button type="button" class="kreset" data-reset="${a.id}" title="Back to the default">↺</button>` : '<span></span>'}` +
        `${note && note.id === a.id ? `<span class="knote${note.bad ? ' bad' : ''}">${esc(note.text)}</span>` : ''}</li>`;
    });
    if (!q || 'fixed'.includes(q) || FIXED.some(([, l]) => l.toLowerCase().includes(q))) {
      html += '<li class="kgrp">Fixed — the keys the grid is typed with</li>' + FIXED.map(([k, l]) =>
        `<li class="krow fixed"><span class="klb">${esc(l)}</span><span class="kbinds"><span class="kchip">${esc(k.split(' ').map((p) => (p.includes('+') || KB[p] ? kb(p) : p)).join(' '))}</span></span><span></span></li>`).join('');
    }
    $('#keys-list').innerHTML = html || '<li class="kempty">Nothing by that name.</li>';
  }
  function captureKey(e) {
    if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const { id, n } = capturing;
    const keys = keysFor(id).slice();
    if (e.key === 'Escape' && !mod(e) && !e.altKey && !e.shiftKey) { capturing = null; paintKeys(); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !mod(e) && !e.altKey && !e.shiftKey) {
      capturing = null;
      if (n < keys.length) { keys.splice(n, 1); setKeys(id, keys); paintKeys({ id, text: 'Removed' }); }
      else paintKeys();
      return;
    }
    const spec = comboOf(e);
    const why = spec && refuse(spec);
    if (!spec || why) { paintKeys({ id, text: why || 'That key cannot be used', bad: true }); return; }
    capturing = null;
    // A key belongs to one action: give it here, take it from wherever it was.
    let from = null;
    ACTIONS.forEach((a) => {
      if (a.id === id) return;
      const theirs = keysFor(a.id);
      if (theirs.includes(spec)) { from = a; setKeys(a.id, theirs.filter((k) => k !== spec)); }
    });
    if (n < keys.length) keys[n] = spec; else keys.push(spec);
    setKeys(id, [...new Set(keys)]);
    paintKeys({ id, text: from ? `Taken from “${labelOf(from)}”` : `Now ${kb(spec)}` });
  }
  function setKeys(id, keys) {
    const def = (ACTION.get(id) || { keys: [] }).keys;
    if (keys.length === def.length && keys.every((k, i) => k === def[i])) delete BOUND[id];
    else BOUND[id] = keys;
    saveKeys(); rebind(); fillKeys(); paintVision();
  }
  on($('#keys-list'), 'click', (e) => {
    const reset = e.target.closest('[data-reset]');
    if (reset) {
      const id = reset.dataset.reset;
      const def = (ACTION.get(id) || { keys: [] }).keys;
      // the default may be in use elsewhere by now; it is taken back from there
      ACTIONS.forEach((a) => { if (a.id !== id) { const t = keysFor(a.id); if (t.some((k) => def.includes(k))) setKeys(a.id, t.filter((k) => !def.includes(k))); } });
      delete BOUND[id]; saveKeys(); rebind(); fillKeys(); paintVision();
      paintKeys({ id, text: 'Back to the default' });
      return;
    }
    const chip = e.target.closest('button.kchip');
    if (!chip) return;
    capturing = { id: chip.dataset.a, n: +chip.dataset.n };
    paintKeys();
  });
  on($('#keys-q'), 'input', () => paintKeys());
  on($('#keys-x'), 'click', closeKeys);
  on($('#keysbox'), 'click', (e) => { if (e.target.id === 'keysbox') closeKeys(); });
  on($('#keys-reset'), 'click', () => {
    if (!confirm('Put every shortcut back to how it started?')) return;
    BOUND = {}; saveKeys(); rebind(); fillKeys(); paintVision(); paintKeys();
    toast('Shortcuts back to the defaults');
  });
  on($('#keys-btn'), 'click', openKeys);

  const outside = (e) => editing || (e.target.matches && e.target.matches('input,textarea,select')) || !A.sel || !root.isConnected;
  on(document, 'copy', (e) => {
    if (outside(e)) return;
    const txt = (A.anchor ? rangeCells() : [A.sel]).map(({ r, c }) => rows()[r].c[c]).filter(Boolean).join('\n');
    e.clipboardData.setData('text/plain', txt); e.preventDefault(); toast('Copied');
  });
  on(document, 'cut', (e) => {
    if (outside(e)) return;
    const list = A.anchor ? rangeCells() : [A.sel];
    e.clipboardData.setData('text/plain', list.map(({ r, c }) => rows()[r].c[c]).filter(Boolean).join('\n'));
    e.preventDefault(); clearCells(list, 'Cut');
  });
  on(document, 'paste', (e) => { if (outside(e)) return; e.preventDefault(); pasteLines(e.clipboardData.getData('text/plain')); });

  /** The first empty cell under the last thing written in that column. */
  function jumpCol(c) {
    const rs = rows();
    let last = -1;
    rs.forEach((x, i) => { if (x.c && x.c[c].trim()) last = i; });
    let r = -1;
    for (let i = last + 1; i < rs.length; i++) if (rs[i].c && !rs[i].c[c].trim()) { r = i; break; }
    if (r < 0) { if (editing) commit(); rs.push({ id: uid('r'), c: blankC() }); r = rs.length - 1; render([r]); pushRows(sheetOf()); }
    setSel(r, c, true);
    toast('Flowing ' + colsOf()[c].key + (split ? ' · screen ' + (A.i ? 'B' : 'A') : ''));
  }

  /* ================================================================
     8. Sheets
     ================================================================ */

  // A second click on a tab within a moment renames it. Counted by hand
  // rather than with dblclick: the first click redraws the tabs, and a
  // double-click whose two halves land on different elements never fires.
  let lastTab = { i: -1, at: 0 };
  on(root, 'click', (e) => {
    const x = e.target.closest('#tabs .tx');
    if (x) { e.stopPropagation(); deleteSheet(+x.dataset.del); return; }
    const t = e.target.closest('#tabs button[data-i]');
    if (t) {
      const i = +t.dataset.i;
      const now = performance.now();
      const again = lastTab.i === i && now - lastTab.at < 450;
      lastTab = { i, at: now };
      if (again) { renameSheet(i); return; }
      if (editing) commit();
      if (i === A.cur) return;
      A.cur = i; A.sel = firstSel(); A.anchor = null;
      render(); A.flow.scrollTo(0, 0);
      return;
    }
    const add = e.target.closest('[data-add]');
    if (add) addSheet(add.dataset.add);
    if (e.target.closest('[data-sdopen]')) openSd();
  });
  on($('#tabs'), 'contextmenu', (e) => {
    const t = e.target.closest('button[data-i]');
    if (!t) return;
    e.preventDefault();
    const i = +t.dataset.i;
    const items = [
      ['Rename', keyOf('flow.rename'), () => renameSheet(i)],
      ['Open on the other screen', '', () => openBeside(i)],
      '-',
      ['Delete this flow', '', () => deleteSheet(i), 'danger'],
    ];
    menu.innerHTML = items.map((it, j) => (it === '-' ? '<hr>' :
      `<button type="button" role="menuitem" data-i="${j}" class="${it[3] || ''}"><span>${esc(it[0])}</span>${it[1] ? `<kbd>${esc(it[1])}</kbd>` : ''}</button>`)).join('');
    menu._items = items;
    menu.hidden = false;
    menu.style.left = Math.min(e.clientX, innerWidth - menu.offsetWidth - 8) + 'px';
    menu.style.top = Math.min(e.clientY, innerHeight - menu.offsetHeight - 8) - 0 + 'px';
    menu.querySelector('button').focus({ preventScroll: true });
  });
  function addSheet(side) {
    if (editing) commit();
    const n = S.sheets.filter((s) => s.side === side).length + 1;
    snap();
    S.sheets.push({ id: uid('s'), name: (side === 'pro' ? 'Pro ' : 'Con ') + n, side, rows: blankRows(5) });
    A.cur = S.sheets.length - 1; A.sel = firstSel();
    render([0, 1, 2]); setSel(A.sel.r, A.sel.c, false);
    save(); pushDoc();
    toast('New ' + side + ' flow');
  }
  async function renameSheet(i = A.cur) {
    const sheet = S.sheets[i];
    if (!sheet) return;
    const tab = $(`#tabs button[data-i="${i}"]`);
    const name = await ask('Name this flow', sheet.name, tab || A.flow);
    if (name === null) return;
    snap();
    sheet.name = name.trim() || sheet.name;
    render(); save(); pushDoc(); paintVision();
  }
  async function renameHeading(r) {
    const row = rows()[r];
    if (!row || row.c) return;
    const el = A.grid.querySelector(`.rh[data-r="${r}"]`);
    const h = await ask('Heading', row.t ? `${row.h} — ${row.t}` : row.h, el || A.flow);
    if (h === null) return;
    snap();
    Object.assign(row, splitHeading(h));
    render(); save(); pushRows(sheetOf());
  }
  /**
   * Throw a flow away. No dialog: it goes, the toast offers it back, and
   * Ctrl+Z brings it back too — a confirm box is a question asked of
   * someone who has already decided, in the middle of a round. Its tab
   * folds away first so the deletion is seen rather than inferred.
   */
  function deleteSheet(i = A.cur) {
    const sheet = S.sheets[i];
    if (!sheet) return;
    if (S.sheets.length < 2) return toast('The last flow stays — clear it instead');
    if (editing) commit();
    const go = () => {
      snap();
      S.sheets.splice(i, 1);
      PANES.forEach((p) => {
        if (p.cur > i || p.cur >= S.sheets.length) p.cur = Math.max(0, p.cur - 1);
        p.sel = null; p.anchor = null;
      });
      render(); save(); pushDoc(); paintVision();
      toast(`Deleted “${sheet.name}”`, true);
    };
    const tab = $(`#tabs button[data-i="${i}"]`);
    if (!tab || RM) return go();
    tab.classList.add('going');
    setTimeout(go, 170);
  }

  /* ================================================================
     9. The clock
     ================================================================ */

  let left = SP.map((s) => s.secs);
  let ti = 0, run = false, tmode = 'sp';
  const prep = { pro: S.prep, con: S.prep };

  function paintT() {
    const sp = SP[ti];
    const name = tmode === 'sp' ? sp.name : (tmode === 'pro' ? 'PRO PREP' : 'CON PREP');
    const t = tmode === 'sp' ? left[ti] : prep[tmode];
    $('#t-sp').textContent = name;
    $('#t-sp').title = tmode === 'sp' ? sp.long : 'Prep';
    $('#t-tm').textContent = clock(t);
    $('#t-tm').classList.toggle('low', t <= 30);
    const g = $('#t-go');
    g.textContent = run ? '❚❚' : '▶';
    g.classList.toggle('on', run);
    g.setAttribute('aria-label', run ? 'Pause the clock' : 'Start the clock');
    $('#tbar').classList.toggle('live', run);
    $('#prep-pro').textContent = 'Pro prep ' + clock(prep.pro);
    $('#prep-con').textContent = 'Con prep ' + clock(prep.con);
    $('#prep-pro').setAttribute('aria-pressed', String(tmode === 'pro'));
    $('#prep-con').setAttribute('aria-pressed', String(tmode === 'con'));
    markLive();
  }
  function markLive() {
    PANES.forEach((p) => {
      const col = liveCol(p);
      p.grid.querySelectorAll('.h[data-col]').forEach((h) => h.classList.toggle('live', +h.dataset.col === col));
      p.grid.querySelectorAll('.c').forEach((el) => el.classList.toggle('livecol', +el.dataset.c === col));
    });
    const nx = SP.slice(ti + 1).find((s) => s.col >= 0);
    const rf = $('#road-for');
    if (rf) rf.textContent = 'Roadmap for ' + (nx ? nx.long : 'the next speech');
  }
  function setSpeech(i, follow) {
    ti = (i + SP.length) % SP.length;
    tmode = 'sp'; run = false; left[ti] = SP[ti].secs;
    paintT(); pushTimer();
    if (follow) goSpeech();
  }
  function toggleTimer() {
    run = !run;
    paintT(); pushTimer();
    if (run && tmode === 'sp' && (!A.sel || A.sel.c !== liveCol())) goSpeech();
  }
  /**
   * To where the speech on the clock is written: its column on this sheet —
   * or, for the other side's constructive, which has no column here, the
   * first sheet of that side's case.
   */
  function goSpeech() {
    const sp = SP[ti];
    if (!sp || sp.col < 0) return;
    const c = columnOn(sheetOf().side, S.first, sp.col);
    if (c >= 0) return jumpCol(c);
    const i = S.sheets.findIndex((sh) => sh.side === sp.side);
    if (i < 0) return;
    if (editing) commit();
    A.cur = i; A.sel = firstSel(); A.anchor = null; render();
    jumpCol(0);
  }
  on($('#t-prev'), 'click', () => setSpeech(ti - 1, true));
  on($('#t-next'), 'click', () => setSpeech(ti + 1, true));
  on($('#t-sp'), 'click', () => setSpeech(ti + 1, true));
  on($('#t-go'), 'click', toggleTimer);
  on($('#t-rs'), 'click', () => {
    if (tmode === 'sp') left[ti] = SP[ti].secs; else prep[tmode] = S.prep;
    run = false; paintT(); pushTimer();
  });
  on($('#prep-pro'), 'click', () => { tmode = tmode === 'pro' ? 'sp' : 'pro'; run = tmode === 'pro'; paintT(); pushTimer(); });
  on($('#prep-con'), 'click', () => { tmode = tmode === 'con' ? 'sp' : 'con'; run = tmode === 'con'; paintT(); pushTimer(); });

  const tick = setInterval(() => {
    if (!run) return;
    if (tmode === 'sp') {
      left[ti] = Math.max(0, left[ti] - 1);
      if (!left[ti]) { run = false; toast(SP[ti].name + ' — time'); }
    } else {
      prep[tmode] = Math.max(0, prep[tmode] - 1);
      if (!prep[tmode]) { run = false; toast((tmode === 'pro' ? 'Pro' : 'Con') + ' is out of prep'); }
    }
    paintT();
  }, 1000);
  offs.push(() => clearInterval(tick));

  /** Who speaks first is the flip's business, so it is a setting, not a rule. */
  function flipFirst() {
    snap();
    S.first = S.first === 'pro' ? 'con' : 'pro';
    // A sheet's columns run in the order its case is answered, which is the
    // same whoever speaks first — so nothing on the flow moves, only the clock.
    SP = speechesFor(S.first);
    left = SP.map((s) => s.secs);
    render(); paintT(); save(); pushDoc();
    toast((S.first === 'pro' ? 'Pro' : 'Con') + ' speaks first');
  }
  function setPrep(secs) {
    S.prep = secs;
    prep.pro = secs; prep.con = secs;
    paintT(); save(); pushDoc();
    toast('Prep set to ' + clock(secs) + ' each');
  }

  /* ================================================================
     10. The drawer: notes, cards, and what Evidence just sent
     ================================================================ */


  function toggleDrawer(force, tab) {
    const d = $('#drawer');
    const wanted = force != null ? force : !d.classList.contains('open');
    d.classList.toggle('open', wanted);
    $('#drawer-btn').setAttribute('aria-pressed', String(wanted));
    $('#drawer-btn').classList.remove('ping');
    if (tab) showTab(tab);
    else if (wanted) $('#notes').focus({ preventScroll: true });
  }
  function showTab(name) {
    $$('.dtabs button[data-p]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.p === name)));
    ['notes', 'cards', 'vision', 'doc'].forEach((p) => { $('#p-' + p).hidden = name !== p; });
    if (name === 'doc') paintSendDoc();
    if (name === 'cards') { INDEX = null; runCards(); $('#q').focus({ preventScroll: true }); }
    if (name === 'vision') paintVision();
  }
  on($('#drawer-btn'), 'click', () => toggleDrawer());
  on($('#drawer-x'), 'click', () => toggleDrawer(false));
  $$('.dtabs button[data-p]').forEach((b) => on(b, 'click', () => showTab(b.dataset.p)));

  $('#notes').value = S.notes || '';
  let notesTimer = null;
  on($('#notes'), 'input', () => {
    S.notes = $('#notes').value;
    save();
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => pushNotes(), 400);
  });

  /* ---------- cards, out of this account's Evidence library ---------- */

  let INDEX = null;
  const loadIndex = async () => { if (INDEX === null) INDEX = await library(OWNER); return INDEX; };

  const cardsIn = (h) => (h.cards ? ` · ${h.cards} card${h.cards === 1 ? '' : 's'}` : '');
  // Sending is the default: a block you pull up mid-round is a block you are
  // about to read, so it goes into the send doc as it goes into the flow.
  const hitHtml = (h, i) =>
    `<article class="card" data-i="${i}" style="--i:${Math.min(i, 10)}"><button type="button" class="ctag open-tags" title="Show the cards in this block, to pick from">${esc(h.title)}<i class="chev" aria-hidden="true"></i></button>` +
    `<span class="cite">/${esc(h.trigger)}${h.path ? ' · ' + esc(h.path) : ''}${cardsIn(h)}</span>` +
    `<div class="tagpick" hidden></div>` +
    `<span class="acts"><button class="ins go" type="button" data-i="${i}" data-send="1" title="Its tags into the flow, and those cards into your send doc">Flow + send</button>` +
    `<button class="ins" type="button" data-i="${i}" data-send="0" title="Its tags into the flow only">Flow only</button></span></article>`;
  const tagRows = (tags) => tags.map((t) =>
    `<label class="tp"><input type="checkbox" data-t="${t.i}"><span><b>${esc(t.title)}</b>${t.cite ? `<small>${esc(t.cite)}</small>` : ''}</span></label>`).join('');

  let cardTimer = null;
  async function runCards() {
    const q = $('#q').value.trim();
    const box = $('#cardlist');
    if (INDEX === null) box.innerHTML = '<p class="small">Looking…</p>';
    await loadIndex();
    if (!INDEX.length) {
      box.innerHTML = '<p class="small">Nothing in your Evidence library yet. Import a cut file in <b>Evidence</b> and it shows up here.</p>';
      return;
    }
    if (!q) { box.innerHTML = `<p class="small">${INDEX.length} blocks in your library. Type to search, or select an argument on the flow and press ${keyOf('answer') || 'the command panel'}.</p>`; return; }
    const hits = find(INDEX, q);
    box._hits = hits;
    box.innerHTML = hits.length ? hits.map(hitHtml).join('') : '<p class="small">Nothing matches.</p>';
  }
  on($('#q'), 'input', () => { clearTimeout(cardTimer); cardTimer = setTimeout(runCards, 140); });
  on($('#cardlist'), 'click', async (e) => {
    const art = e.target.closest('.card');
    const hit = art && ($('#cardlist')._hits || [])[+art.dataset.i];
    if (!hit) return;
    const box = art.querySelector('.tagpick');
    if (e.target.closest('.open-tags')) {
      const opening = box.hidden;
      art.classList.toggle('open', opening);
      if (opening && !box.dataset.done) {
        const tags = await blockTags(OWNER, hit.id);
        box._tags = tags; box.dataset.done = '1';
        box.innerHTML = tags.length
          ? `<div class="tp-h small">Tick the cards you want — none ticked takes them all</div>${tagRows(tags)}`
          : '<p class="small">No cards under this block — its header goes in.</p>';
      }
      box.hidden = !opening;
      return;
    }
    const b = e.target.closest('.ins');
    if (!b) return;
    // the ticked cards, or every card in the block
    const tags = box._tags || await blockTags(OWNER, hit.id);
    const ticked = [...box.querySelectorAll('input:checked')].map((x) => +x.dataset.t);
    const picks = ticked.length ? ticked : tags.map((t) => t.i);
    const lines = tags.filter((t) => picks.includes(t.i)).map((t) => t.title);
    flowIt(hit, b.dataset.send === '1', null, lines.length ? lines : null, ticked.length && ticked.length < tags.length ? ticked : null);
  });

  /**
   * Put a card's tag in the flow — and, when asked, the card itself in
   * Evidence's send list, so the speech doc and the flow are built by the
   * same keystroke.
   */
  async function flowIt(hit, alsoSend, target, lines, picks) {
    const t = target || (A.sel && { r: A.sel.r, c: A.sel.c });
    if (!t || !rows()[t.r] || !rows()[t.r].c) return toast('Pick a cell on the flow first');
    if (editing) commit();
    snap();
    // one box per card, down the column
    const { r, born } = placeDown(t, lines && lines.length ? lines : [hit.text]);
    render(born);
    setSel(r, t.c, false);
    popIn(t.r, r, t.c);
    save(); pushRows(sheetOf());
    const n = lines && lines.length ? lines.length : 0;
    const what = n ? `${n} tag${n === 1 ? '' : 's'}` : 'The header';
    if (!alsoSend) return toast(`${what} into ${colsOf()[t.c].key}`, true);
    const ok = await sendToEvidence(OWNER, hit, picks || undefined);
    if (ok) { BUS.post({ kind: 'send-changed', title: hit.title }); toast(`${what} flowed — and ${picks ? (picks.length === 1 ? 'that card is' : 'those cards are') : 'the block is'} in your send doc`, true); }
    else toast('Flowed — Evidence could not find that card to send', true);
  }

  /**
   * Lines down a column, one box each, from a cell. The first goes in that
   * cell if it is empty, or in a new row under it if not; each one after
   * takes the row below only when that whole row is empty, and otherwise a
   * new row is made there. What was already written is pushed down, never
   * jumped over — so every card lands beside the argument it answers, and
   * the next argument still sits under its own answers.
   */
  function placeDown(t, lines) {
    const rs = rows();
    const c = t.c;
    let r = t.r;
    const born = [];
    const emptyRow = (row) => !!(row && row.c && row.c.every((x) => !x.trim()));
    lines.forEach((ln, i) => {
      if (i === 0 && rs[r] && rs[r].c && !rs[r].c[c].trim()) { rs[r].c[c] = ln; return; }
      const n = r + 1;
      if (!emptyRow(rs[n])) { rs.splice(n, 0, { id: uid('r'), c: blankC() }); born.push(n); }
      r = n;
      rs[r].c[c] = ln;
    });
    return { r, born };
  }
  /** The boxes that were just filled, popping in one after another. */
  function popIn(r0, r1, c) {
    for (let r = r0, k = 0; r <= r1; r++, k++) {
      const el = cellEl(r, c);
      if (!el || !el.textContent.trim()) continue;
      el.style.animationDelay = k * 45 + 'ms';
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
      if (k === 0) flash(el);
    }
  }

  /* ---------- the other team's case, off SpeechDrop ----------
     Look in the room they uploaded to, pick their case, and its tags go down
     a column, one box each — under a heading row for each contention, the
     way a flow is written. It reads the document the way the Doc viewer
     does: Verbatim's headings, the tags at the bottom of them. */

  const SD_KEY = scoped('flow.sdroom', OWNER);
  const sd = { code: '', files: null, err: '', busy: false, file: null, read: null, off: new Set(), sheet: -1, col: 0, heads: true };
  const sdKind = (n) => (/\.docx$/i.test(n) ? 'docx' : /\.html?$/i.test(n) ? 'html' : /\.pdf$/i.test(n) ? 'pdf' : 'other');
  const sdTime = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

  function openSd() {
    if (editing) commit();
    if (!sd.code) { try { sd.code = localStorage.getItem(SD_KEY) || ''; } catch { /* private browsing */ } }
    $('#sdbox').hidden = false;
    paintSd();
    if (sd.code && !sd.files && !sd.read) listSd(sd.code);
    setTimeout(() => { const i = $('#sd-code'); if (i && !sd.read) i.focus(); }, 30);
  }
  function closeSd() { $('#sdbox').hidden = true; A.flow.focus({ preventScroll: true }); }

  async function listSd(raw) {
    const code = String(raw || '').trim().replace(/^https?:\/\/[^/]+\//i, '').replace(/\/.*$/, '');
    if (!code) return;
    sd.code = code; sd.busy = true; sd.err = ''; sd.files = null; sd.read = null;
    try { localStorage.setItem(SD_KEY, code); } catch { /* private browsing */ }
    paintSd();
    try {
      const r = await fetch('/api/tools/speechdrop?room=' + encodeURIComponent(code), { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'SpeechDrop said ' + r.status);
      sd.files = j.files.slice().reverse();
    } catch (e) { sd.err = String(e && e.message || e); }
    sd.busy = false;
    paintSd();
  }

  async function pickSd(i) {
    const f = (sd.files || []).find((x) => x.i === i);
    if (!f) return;
    sd.busy = true; sd.err = ''; paintSd();
    try {
      const r = await fetch('/api/tools/speechdrop?room=' + encodeURIComponent(sd.code) + '&i=' + f.i, { cache: 'no-store' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'SpeechDrop said ' + r.status); }
      const read = await readCase(await r.blob(), f.name);
      if (!read.tags) throw new Error('No tags in “' + f.name + '” — its headings are not styled as headings');
      sd.file = f; sd.read = read; sd.off = new Set();
      // their case goes on their sheet: the first sheet that is not our side's
      const ours = S.meta && S.meta.side ? S.meta.side : null;
      const theirs = ours ? S.sheets.findIndex((sh) => sh.side !== ours) : -1;
      sd.sheet = theirs >= 0 ? theirs : A.cur;
      sd.col = 0;
    } catch (e) { sd.err = String(e && e.message || e); }
    sd.busy = false;
    paintSd();
  }

  const sdChosen = () => {
    if (!sd.read) return [];
    return sd.read.parts.map((p, pi) => ({ section: p.section, tags: p.tags.filter((_, ti) => !sd.off.has(pi + ':' + ti)) })).filter((p) => p.tags.length);
  };

  function paintSd() {
    const box = $('#sd-in-box');
    if (!box) return;
    if (sd.read) {
      const n = sdChosen().reduce((k, p) => k + p.tags.length, 0);
      const sheet = S.sheets[sd.sheet] || sheetOf();
      box.innerHTML =
        `<div class="sd-head"><button type="button" class="btn" data-sdback>‹ Files</button><span><b>${esc(sd.file.name)}</b>` +
        `<small class="small">${sd.read.parts.length} section${sd.read.parts.length === 1 ? '' : 's'} · ${sd.read.tags} tag${sd.read.tags === 1 ? '' : 's'}</small></span></div>` +
        `<div class="sd-target"><label><span class="small">Into</span><select id="sd-sheet">${S.sheets.map((sh, i) => `<option value="${i}"${i === sd.sheet ? ' selected' : ''}>${esc(sh.name)}</option>`).join('')}</select></label>` +
        `<label><span class="small">Column</span><select id="sd-col">${colsOn(sheet).map((c, i) => `<option value="${i}"${i === sd.col ? ' selected' : ''}>${esc(c.long)}</option>`).join('')}</select></label>` +
        `<label class="sd-chk"><input type="checkbox" id="sd-heads"${sd.heads ? ' checked' : ''}> <span class="small">Contentions as heading rows</span></label></div>` +
        '<div class="sd-parts">' + sd.read.parts.map((p, pi) =>
          '<div class="sd-sec">' +
          (p.section ? `<label class="sd-sech"><input type="checkbox" data-sdsec="${pi}"${p.tags.every((_, ti) => !sd.off.has(pi + ':' + ti)) ? ' checked' : ''}> <b>${esc(p.section)}</b></label>` : '') +
          p.tags.map((t, ti) => `<label class="sd-tag"><input type="checkbox" data-sdtag="${pi}:${ti}"${sd.off.has(pi + ':' + ti) ? '' : ' checked'}> <span>${esc(t)}</span></label>`).join('') +
          '</div>').join('') + '</div>' +
        `<div class="sd-out"><button type="button" class="btn go" data-sdgo${n ? '' : ' disabled'}>Flow ${n} tag${n === 1 ? '' : 's'} into ${esc(colsOn(sheet)[sd.col].key)}</button>` +
        `<span class="small">One box each, below what is already on ${esc(sheet.name)}.</span></div>`;
      return;
    }
    box.innerHTML =
      '<p class="small sd-blurb">When they upload their case to SpeechDrop, open it here and its tags go down a column of your flow, one box each, under their contentions.</p>' +
      `<form class="sd-row" data-sdform><input id="sd-code" value="${esc(sd.code)}" placeholder="SpeechDrop room code" autocomplete="off" spellcheck="false">` +
      `<button type="submit" class="btn go">${sd.busy && !sd.files ? 'Looking…' : 'Look'}</button></form>` +
      (sd.err ? `<p class="sd-err">${esc(sd.err)}</p>` : '') +
      (sd.busy && sd.files ? '<p class="small">Reading it…</p>' : '') +
      (sd.files ? (sd.files.length
        ? '<ul class="sd-files">' + sd.files.map((f) => {
          const k = sdKind(f.name);
          const ok = k === 'docx' || k === 'html';
          return `<li><button type="button" data-sdfile="${f.i}"${ok ? '' : ' disabled title="Only a .docx has headings to read"'}><span class="k ${k}">${k === 'other' ? 'file' : k}</span><span class="n">${esc(f.name)}</span><small>${sdTime(f.ctime)}</small></button></li>`;
        }).join('') + '</ul>'
        : `<p class="small">Nothing in room ${esc(sd.code)} yet.</p>`) : '') +
      (sd.files ? `<button type="button" class="btn sd-again" data-sdagain>Look again</button>` : '');
  }

  /** Their tags, into the sheet: a heading row per contention, one box per tag, after what is there. */
  function flowSd() {
    const parts = sdChosen();
    const sheet = S.sheets[sd.sheet];
    if (!sheet || !parts.length) return;
    snap();
    const rs = sheet.rows;
    const blank = (r) => r.c && r.c.every((x) => !x.trim());
    let at = rs.length;
    while (at > 0 && blank(rs[at - 1])) at--;
    const add = [];
    parts.forEach((p) => {
      if (sd.heads && p.section) add.push(Object.assign({ id: uid('r') }, splitHeading(p.section)));
      p.tags.forEach((t) => { const c = blankC(); c[sd.col] = t; add.push({ id: uid('r'), c }); });
    });
    rs.splice(at, 0, ...add);
    let tail = 0;
    for (let i = rs.length - 1; i >= 0 && blank(rs[i]); i--) tail++;
    for (; tail < 3; tail++) rs.push({ id: uid('r'), c: blankC() });
    const n = parts.reduce((k, p) => k + p.tags.length, 0);
    closeSd();
    if (A.cur !== sd.sheet) { A.cur = sd.sheet; A.anchor = null; }
    const born = add.map((_, i) => at + i);
    render(born);
    const first = add.findIndex((r) => r.c);
    if (first >= 0) setSel(at + first, sd.col, false);
    save(); pushRows(sheet);
    toast(`${n} tag${n === 1 ? '' : 's'} from ${sd.file.name} into ${colsOn(sheet)[sd.col].key}`, true);
  }

  on($('#sd-x'), 'click', closeSd);
  on($('#sdbox'), 'click', (e) => {
    if (e.target.id === 'sdbox') return closeSd();
    const f = e.target.closest('[data-sdfile]');
    if (f && !f.disabled) return pickSd(+f.dataset.sdfile);
    if (e.target.closest('[data-sdback]')) { sd.read = null; return paintSd(); }
    if (e.target.closest('[data-sdagain]')) return listSd(sd.code);
    if (e.target.closest('[data-sdgo]')) return flowSd();
  });
  on($('#sdbox'), 'submit', (e) => { e.preventDefault(); listSd(($('#sd-code') || {}).value); });
  on($('#sdbox'), 'change', (e) => {
    const t = e.target;
    if (t.id === 'sd-sheet') { sd.sheet = +t.value; sd.col = 0; return paintSd(); }
    if (t.id === 'sd-col') { sd.col = +t.value; return paintSd(); }
    if (t.id === 'sd-heads') { sd.heads = t.checked; return; }
    if (t.dataset.sdsec !== undefined) {
      const pi = +t.dataset.sdsec;
      sd.read.parts[pi].tags.forEach((_, ti) => { if (t.checked) sd.off.delete(pi + ':' + ti); else sd.off.add(pi + ':' + ti); });
      return paintSd();
    }
    if (t.dataset.sdtag !== undefined) { if (t.checked) sd.off.delete(t.dataset.sdtag); else sd.off.add(t.dataset.sdtag); return paintSd(); }
  });
  on($('#sdbox'), 'keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSd(); } });

  /* ---------- what Evidence just sent ---------- */

  const INBOX = [];
  function paintInbox() {
    const box = $('#inbox');
    if (!INBOX.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<span class="small">Just sent in Evidence</span>' + INBOX.map((s, i) =>
      `<article class="card sent" style="--i:${i}"><span class="ctag">${esc(s.title)}</span>` +
      `<span class="tags">${s.tags.map((t, j) => `<button type="button" class="tagbtn" data-s="${i}" data-t="${j}">${esc(t)}</button>`).join('')}</span>` +
      `<span class="acts"><button class="ins go" type="button" data-all="${i}">Flow every tag down the column</button></span></article>`).join('');
  }
  on($('#inbox'), 'click', (e) => {
    const one = e.target.closest('.tagbtn');
    if (one) { const s = INBOX[+one.dataset.s]; if (s) flowIt({ text: s.tags[+one.dataset.t] }, false); return; }
    const all = e.target.closest('[data-all]');
    if (all) {
      const s = INBOX[+all.dataset.all];
      if (!s || !A.sel) return toast('Pick a cell on the flow first');
      if (editing) commit();
      pasteLines(s.tags.join('\n'));
    }
  });

  const BUS = openBus(OWNER, (m) => {
    if (m.kind === 'senddoc') { receiveDoc(m, 'tab'); return; }
    if (m.kind !== 'sent') return;
    INBOX.unshift({ title: m.title, trigger: m.trigger, tags: (m.tags || []).filter(Boolean) });
    INBOX.length = Math.min(INBOX.length, 6);
    paintInbox();
    const btn = $('#drawer-btn');
    btn.classList.remove('ping'); void btn.offsetWidth; btn.classList.add('ping');
    toast('From Evidence: ' + m.title + ' — its tags are in Cards');
  });
  offs.push(() => BUS.close());

  /* ---------- the send doc, as it is being built ----------
     Evidence publishes its send doc as an outline — blocks and their tags —
     to this account's own tabs over the bus, and into the room when a
     partner shares theirs there. Both are kept; the partner's is shown
     first, with a switch when there are two. A tag goes into the next empty
     cell down the column you are in; a block puts its header and every tag
     there, one per row. */
  const DOCS = { room: null, tab: null };
  let docShown = 'room';
  const seenDocFrom = new Set();
  const currentDoc = () => DOCS[docShown] || DOCS.room || DOCS.tab;

  function receiveDoc(d, from) {
    if (!d || !Array.isArray(d.blocks)) return;
    // Your own Evidence reaches this tab twice — over the bus and through the
    // room. The room's copy of your own send doc is not someone else's.
    if (from === 'room' && d.uid && d.uid === OWNER) return;
    const was = DOCS[from];
    DOCS[from] = { by: d.by || 'Partner', at: d.at || Date.now(), blocks: d.blocks, from };
    if (!DOCS[docShown]) docShown = from;
    paintSendDoc();
    if (!was || d.blocks.length > was.blocks.length) {
      const btn = $('#drawer-btn');
      btn.classList.remove('ping'); void btn.offsetWidth; btn.classList.add('ping');
    }
    const who = from + ':' + DOCS[from].by;
    if (!seenDocFrom.has(who) && d.blocks.length) {
      seenDocFrom.add(who);
      toast(from === 'room' ? `${DOCS[from].by}'s send doc is here — Drawer › Send doc` : 'Your send doc is here too — Drawer › Send doc');
    }
  }

  function paintSendDoc() {
    const box = $('#sdoc');
    if (!box) return;
    const doc = currentDoc();
    if (!doc || !doc.blocks.length) {
      box.innerHTML =
        '<p class="sdwait">No send doc yet.</p>' +
        '<p class="sdhow">When your partner builds the send doc in <b>Evidence</b>, it turns up here as they write it — ' +
        'blocks and tags, ready to flow. Send them the Evidence link for this room; they press <b>Room</b> there if they are already in. ' +
        'Your own Evidence tab shows up here too.</p>' +
        (live ? `<button class="btn" type="button" data-sd-link>Copy the Evidence link for room ${esc(live.code)}</button>` : '<p class="sdhow">Start or join a room first (<b>Not shared</b>, up top).</p>');
      return;
    }
    const when = new Date(doc.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    // Two send docs only when they differ: a shared send doc is the same on both sides.
    const both = DOCS.room && DOCS.tab && JSON.stringify(DOCS.room.blocks) !== JSON.stringify(DOCS.tab.blocks);
    let html = '<div class="sdhead">' +
      (both ? `<span class="sdswitch"><button type="button" data-sd-show="room" aria-pressed="${doc.from === 'room'}">${esc(DOCS.room.by)}</button>` +
              `<button type="button" data-sd-show="tab" aria-pressed="${doc.from === 'tab'}">Mine</button></span>` : '') +
      `<span class="small">${doc.from === 'room' ? esc(doc.by) + '’s' : 'Your'} send doc · ${when} · ${doc.blocks.length} block${doc.blocks.length === 1 ? '' : 's'}</span>` +
      // every word of it, not just the outline: the Doc viewer reads it from the same room
      (doc.from === 'room' && live ? `<a class="sdview" href="/tools/viewer?room=${encodeURIComponent(live.code)}" target="break-viewer" title="Read every word of it, with search and an outline">Read it ↗</a>` : '') +
      '</div>';
    let section = null;
    doc.blocks.forEach((b, i) => {
      if (b.section && b.section !== section) { html += `<div class="sdsec">${esc(b.section)}</div>`; section = b.section; }
      html += `<section class="sdblock" style="--i:${Math.min(i, 12)}"><div class="sdh"><b>${esc(b.head || 'Untitled block')}</b>` +
        `<button type="button" class="ins go" data-sd-block="${i}" title="The header and every tag, down the column you are in">Flow ↓</button></div>` +
        `<ol class="sdtags">${b.tags.map((t, j) =>
          `<li><button type="button" class="sdtag" data-sd="${i}:${j}" title="Into the next empty cell down this column"><span>${esc(t.tag)}</span>${t.cite ? `<small>${esc(t.cite)}</small>` : ''}</button></li>`).join('')}</ol></section>`;
    });
    box.innerHTML = html;
  }
  on($('#sdoc'), 'click', (e) => {
    const show = e.target.closest('[data-sd-show]');
    if (show) { docShown = show.dataset.sdShow; paintSendDoc(); return; }
    const doc = currentDoc();
    const tagBtn = e.target.closest('[data-sd]');
    if (tagBtn && doc) {
      const [i, j] = tagBtn.dataset.sd.split(':').map(Number);
      const t = doc.blocks[i] && doc.blocks[i].tags[j];
      if (t) flowLines([t.tag]);
      return;
    }
    const blk = e.target.closest('[data-sd-block]');
    if (blk && doc) {
      const b = doc.blocks[+blk.dataset.sdBlock];
      if (b) flowLines([b.head, ...b.tags.map((t) => t.tag)].filter(Boolean));
      return;
    }
    if (e.target.closest('[data-sd-link]')) copyEvidenceLink();
  });

  /**
   * Lines into the flow, down the column you are in: each into the next
   * empty cell from here, with a new row made before a heading or at the
   * end rather than writing over anything. The cell after the last is
   * left selected, ready for whatever comes next.
   */
  function flowLines(lines) {
    if (!A.sel || !rows()[A.sel.r] || !rows()[A.sel.r].c) return toast('Pick a cell on the flow first');
    if (!lines.length) return;
    if (editing) commit();
    snap();
    const c = A.sel.c, from = A.sel.r;
    const { r, born } = placeDown({ r: from, c }, lines);
    render(born);
    setSel(r, c, false);
    popIn(from, r, c);
    save(); pushRows(sheetOf());
    toast(lines.length > 1 ? `${lines.length} lines down ${colsOf()[c].key}` : 'Into ' + colsOf()[c].key, true);
  }

  // The partner building the send doc gets sent to Evidence with this room in the link.
  const evidenceLink = () => `${location.origin}/tools/evidence?room=${live ? live.code : ''}`;
  async function copyEvidenceLink() {
    if (!live) return toast('Start or join a room first');
    try { await navigator.clipboard.writeText(evidenceLink()); toast('Evidence link copied — your partner opens it to share their send doc'); }
    catch { toast('The clipboard said no'); }
  }

  /* ================================================================
     11. Round vision

     The speech you mean to give, as a path through the flow. Mark the cells
     you are going for — on any sheet, in any column — give each a name, and
     in the speech walk them in order: each stop takes you to its sheet, its
     cell, and lights it. Alt+1–9 goes straight to a stop; a presentation
     clicker's page keys walk them while you are speaking.
     ================================================================ */

  let speaking = false;
  let visionAt = -1;

  const stopAt = (sel) => {
    if (!sel || !rows()[sel.r] || !rows()[sel.r].c) return null;
    const sheet = sheetOf(), row = rows()[sel.r];
    return S.vision.find((v) => v.sheet === sheet.id && v.row === row.id && v.col === sel.c) || null;
  };
  /** Where a stop points, or null if the cell has gone. */
  function resolveStop(v) {
    if (!v || !v.sheet) return null;
    const si = S.sheets.findIndex((s) => s.id === v.sheet);
    if (si < 0) return null;
    const r = rowIndex(S.sheets[si], v.row);
    if (r < 0 || !S.sheets[si].rows[r].c) return null;
    return { si, r, c: v.col, sheet: S.sheets[si] };
  }
  const cleanText = (t) => String(t || '').replace(TAGS, '').replace(/^[\s→>-]+/, '').replace(/\s+/g, ' ').trim();

  async function toggleStop() {
    if (!A.sel) return;
    const had = stopAt(A.sel);
    if (had) {
      S.vision = S.vision.filter((v) => v !== had);
      afterVision();
      return toast('Taken out of round vision');
    }
    const row = rows()[A.sel.r];
    const text = cleanText(row.c[A.sel.c]) || cleanText(row.c.find(Boolean));
    const guess = (text.length > 34 ? text.slice(0, 33).trim() + '…' : text) || `${colsOf()[A.sel.c].key}, row ${A.sel.r + 1}`;
    const name = await ask('Name this stop', guess, cellEl(A.sel.r, A.sel.c), 'What you will call it in the speech');
    if (name === null) return;
    S.vision.push({ id: uid('v'), name: name.trim() || guess, sheet: sheetOf().id, row: row.id, col: A.sel.c });
    afterVision();
    const n = S.vision.length;
    const cell = cellEl(A.sel.r, A.sel.c);
    if (cell) spotlight(cell);
    toast(`Stop ${n} — ${name.trim() || guess}${n <= 9 && keyOf('stop.' + n) ? ' · ' + keyOf('stop.' + n) : ''}`);
  }
  function afterVision() {
    paintVision(); visible().forEach(paintStops); paintSpeak(); save(); pushVision();
  }

  /** Go to a stop: its sheet, its cell, and a light on it. */
  function goStop(i) {
    const v = S.vision[i];
    if (!v) return toast(S.vision.length ? `There is no stop ${i + 1}` : `No round vision yet — ${keyOf('stop.toggle') || 'the command panel'} marks a cell`);
    const at = resolveStop(v);
    visionAt = i;
    paintSpeak(); paintVision();
    if (!at) return toast(`“${v.name}” is not on the flow any more`);
    if (editing) commit();
    // Set directly rather than through setSel, whose snap-scroll would cut
    // across the smooth glide below.
    A.anchor = null;
    A.sel = { r: at.r, c: at.c };
    if (A.cur !== at.si) { A.cur = at.si; render(); } else paintRange();
    widths(); placeCursor();
    const el = cellEl(at.r, at.c);
    if (el) { glide(el); spotlight(el); }
    A.flow.focus({ preventScroll: true });
  }
  function stepStop(d) {
    if (!S.vision.length) return toast(`No round vision yet — ${keyOf('stop.toggle') || 'the command panel'} marks a cell`);
    const next = visionAt < 0 ? (d > 0 ? 0 : S.vision.length - 1) : visionAt + d;
    if (next < 0 || next >= S.vision.length) return toast(d > 0 ? 'That was the last stop' : 'That was the first stop');
    goStop(next);
  }

  /** Scroll to a cell smoothly, rather than jumping, so the eye can follow. */
  function glide(el, p = A) {
    const f = p.flow, a = el.getBoundingClientRect(), b = f.getBoundingClientRect();
    const top = f.scrollTop + (a.top - b.top) - Math.max(60, (b.height - a.height) / 3);
    const left = a.left < b.left + 26 || a.right > b.right ? f.scrollLeft + (a.left - b.left) - 60 : f.scrollLeft;
    f.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior: RM ? 'auto' : 'smooth' });
  }
  /** A ring that opens out from a cell, so a jump lands somewhere you can see. */
  // The ring and the numbered marks both belong to the cell rather than
  // floating over it at a pixel position: the columns change width whenever
  // the selection moves, and anything placed by coordinates is left behind.
  function spotlight(el) {
    if (RM) return flash(el);
    el.classList.remove('spot'); void el.offsetWidth; el.classList.add('spot');
    el.addEventListener('animationend', (e) => { if (e.animationName === 'flwSpot') el.classList.remove('spot'); });
  }

  /** Which stop, if any, a cell is — numbered from 1. */
  function stopNumber(sheetId, rowId, col) {
    const i = S.vision.findIndex((v) => v.sheet === sheetId && v.row === rowId && v.col === col);
    return i < 0 ? 0 : i + 1;
  }
  /** The numbered marks on the cells that are stops, without redrawing the grid. */
  function paintStops(p = A) {
    const sheet = sheetOf(p);
    p.grid.querySelectorAll('.c[data-stop]').forEach((el) => { el.removeAttribute('data-stop'); el.classList.remove('stopnow'); });
    S.vision.forEach((v, i) => {
      if (v.sheet !== sheet.id) return;
      const r = rowIndex(sheet, v.row);
      const el = r >= 0 && cellEl(r, v.col, p);
      if (!el) return;
      el.dataset.stop = String(i + 1);
      el.classList.toggle('stopnow', i === visionAt && speaking);
    });
  }

  /* the list in the drawer */
  function paintVision() {
    const list = $('#vlist');
    if (!list) return;
    if (!S.vision.length) {
      list.innerHTML = `<li class="none"><span class="small">Nothing yet. Select a cell you mean to go for and press ${keyOf('stop.toggle') || 'the command panel'}.</span></li>`;
    } else {
      list.innerHTML = S.vision.map((v, i) => {
        const at = resolveStop(v);
        const where = at ? `${at.sheet.name} · ${(colsOn(at.sheet)[v.col] || colsOn(at.sheet)[0]).key}` : 'not on the flow';
        return `<li class="vs${i === visionAt ? ' now' : ''}${at ? '' : ' gone'}" draggable="true" data-i="${i}" style="--i:${Math.min(i, 10)}">` +
          `<span class="n">${i + 1}</span><span class="nm"><b>${esc(v.name)}</b><span class="where">${esc(where)}</span></span>` +
          `${i < 9 && keyOf('stop.' + (i + 1)) ? `<kbd>${keyOf('stop.' + (i + 1))}</kbd>` : '<span></span>'}<button type="button" class="x" data-x="${i}" aria-label="Remove">×</button></li>`;
      }).join('');
    }
    $('#v-count').textContent = S.vision.length ? `${S.vision.length} stop${S.vision.length === 1 ? '' : 's'}` : '';
  }
  on($('#vlist'), 'click', (e) => {
    const x = e.target.closest('[data-x]');
    if (x) { S.vision.splice(+x.dataset.x, 1); if (visionAt >= S.vision.length) visionAt = S.vision.length - 1; afterVision(); return; }
    const li = e.target.closest('.vs');
    if (li) goStop(+li.dataset.i);
  });
  on($('#vlist'), 'dblclick', async (e) => {
    const li = e.target.closest('.vs');
    if (!li) return;
    const v = S.vision[+li.dataset.i];
    const name = await ask('Rename this stop', v.name, li);
    if (name === null) return;
    v.name = name.trim() || v.name;
    afterVision();
  });
  /* reorder by dragging a stop up or down the list */
  let dragStop = null;
  on($('#vlist'), 'dragstart', (e) => {
    const li = e.target.closest('.vs');
    if (!li) return;
    dragStop = +li.dataset.i;
    li.classList.add('lift');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(dragStop)); } catch { /* old browsers */ }
  });
  on($('#vlist'), 'dragover', (e) => {
    if (dragStop === null) return;
    e.preventDefault();
    $$('#vlist .vs').forEach((x) => x.classList.remove('over'));
    const li = e.target.closest('.vs');
    if (li) li.classList.add('over');
  });
  on($('#vlist'), 'drop', (e) => {
    e.preventDefault();
    const li = e.target.closest('.vs');
    if (dragStop === null || !li) return;
    const to = +li.dataset.i;
    const [moved] = S.vision.splice(dragStop, 1);
    S.vision.splice(to, 0, moved);
    dragStop = null;
    afterVision();
  });
  on($('#vlist'), 'dragend', () => { dragStop = null; $$('#vlist .vs').forEach((x) => x.classList.remove('over', 'lift')); });
  on($('#v-add'), 'click', () => toggleStop());
  on($('#v-speak'), 'click', () => speak(!speaking));

  /* ---------- speaking through it ---------- */
  function speak(onNow) {
    if (onNow && !S.vision.length) return toast(`No round vision yet — ${keyOf('stop.toggle') || 'the command panel'} marks a cell`);
    speaking = onNow;
    root.classList.toggle('speaking', speaking);
    $('#speak').hidden = !speaking;
    $('#v-speak').textContent = speaking ? 'Stop' : 'Speak ▸';
    if (speaking) { toggleDrawer(false); goStop(visionAt >= 0 ? visionAt : 0); toast('Page Down or Space for the next stop · Esc to stop'); }
    else { visible().forEach(paintStops); paintVision(); }
  }
  function paintSpeak() {
    if (!speaking) return;
    const v = S.vision[visionAt];
    const at = v && resolveStop(v);
    $('#sp-n').textContent = `${visionAt + 1} / ${S.vision.length}`;
    $('#sp-name').textContent = v ? v.name : '—';
    $('#sp-where').textContent = at ? `${at.sheet.name} · ${(colsOn(at.sheet)[v.col] || colsOn(at.sheet)[0]).key}` : '';
    $('#sp-bar').style.transform = `scaleX(${S.vision.length ? (visionAt + 1) / S.vision.length : 0})`;
    const card = $('#speak .spk');
    card.classList.remove('turn'); void card.offsetWidth; card.classList.add('turn');
    visible().forEach(paintStops);
  }
  on($('#sp-prev'), 'click', () => stepStop(-1));
  on($('#sp-next'), 'click', () => stepStop(1));
  on($('#sp-x'), 'click', () => speak(false));

  /* ---------- the little box that asks for a name ----------
     In place of the browser's prompt(), which stops the page, looks like
     nothing else here, and cannot be placed next to what it is naming. */
  let asking = null;
  function ask(title, value, anchor, hint) {
    if (asking) asking(null);
    const box = $('#namer'), input = $('#namer-in');
    $('#namer-t').textContent = title;
    $('#namer-h').textContent = hint || 'Enter to keep · Esc to cancel';
    input.value = value || '';
    box.hidden = false;
    const r = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : { left: innerWidth / 2 - 160, bottom: innerHeight / 3, top: innerHeight / 3 };
    const w = box.offsetWidth, h = box.offsetHeight;
    let top = r.bottom + 8;
    if (top + h > innerHeight - 12) top = Math.max(12, r.top - h - 8);
    box.style.left = Math.max(12, Math.min(r.left, innerWidth - w - 12)) + 'px';
    box.style.top = top + 'px';
    input.focus(); input.select();
    return new Promise((resolve) => {
      asking = (v) => { asking = null; box.hidden = true; resolve(v); if (!editing) A.flow.focus({ preventScroll: true }); };
    });
  }
  on($('#namer-in'), 'keydown', (e) => {
    if (!asking) return;
    if (e.key === 'Enter') { e.preventDefault(); asking($('#namer-in').value); }
    if (e.key === 'Escape') { e.preventDefault(); asking(null); }
  });
  on(window, 'pointerdown', (e) => { if (asking && !$('#namer').contains(e.target)) asking(null); }, true);

  /* ================================================================
     12. View controls and the command panel
     ================================================================ */

  on($('#v-focus'), 'click', function () { focusOn = !focusOn; this.setAttribute('aria-pressed', String(focusOn)); visible().forEach((p) => widths(p)); });
  on($('#v-compact'), 'click', function () {
    const nowOn = root.classList.toggle('compact');
    this.setAttribute('aria-pressed', String(nowOn));
    fs = nowOn ? 13 : 15;
    root.style.removeProperty('--flw-fs');
    visible().forEach((p) => placeCursor(p, true));
  });
  on($('#v-minus'), 'click', () => { fs = Math.max(11, fs - 0.5); root.style.setProperty('--flw-fs', fs + 'px'); visible().forEach((p) => placeCursor(p, true)); });
  on($('#v-plus'), 'click', () => { fs = Math.min(20, fs + 0.5); root.style.setProperty('--flw-fs', fs + 'px'); visible().forEach((p) => placeCursor(p, true)); });
  on($('#v-split'), 'click', () => setSplit(split === 'side' ? null : 'side'));
  on($('#v-stack'), 'click', () => setSplit(split === 'stack' ? null : 'stack'));
  on(window, 'resize', () => visible().forEach((p) => { placeCursor(p, true); paintStops(p); paintPeers(p); }));

  /**
   * The command panel.
   *
   * Everything the tool can do, found by typing a few letters of it — and two
   * other kinds of thing besides commands: places (every sheet, every round
   * vision stop, every speech on the clock) and evidence. A query that starts
   * with / searches this account's Evidence library instead, and Ctrl+/ opens it
   * already searching for whatever answers the argument you are on.
   */
  const CMDS = [
    ['Editing', 'Undo', '@undo', undo],
    ['Editing', 'Redo', '@redo', redo],
    ['Editing', 'Mark dropped', '@dropped', () => tag('DROPPED')],
    ['Editing', 'Mark extended', '@ext', () => tag('EXT')],
    ['Editing', 'Mark turn', '@turn', () => tag('TURN')],
    ['Editing', 'Insert row below', '@row.below', () => A.sel && insertRow(A.sel.r + 1, A.sel.c, true)],
    ['Editing', 'Insert a heading', '@heading', () => A.sel && insertHeading(A.sel.r)],
    ['Editing', 'Clear the selected cells', kb('back'), () => A.sel && clearCells(A.anchor ? rangeCells() : [A.sel])],
    ['Editing', 'Delete row', '@row.del', () => A.sel && deleteRows(A.anchor ? rangeCells().map((x) => x.r) : [A.sel.r])],
    ['Editing', 'Delete cell, shift the column up', '@cell.up', () => A.sel && deleteCellUp(A.sel.r, A.sel.c)],
    ['Editing', 'Respond in the next column', kb('tab'), () => A.sel && setSel(A.sel.r, Math.min(LAST, A.sel.c + 1), true)],
    ['Round vision', 'Add this cell to round vision', '@stop.toggle', () => toggleStop()],
    ['Round vision', 'Speak through round vision', '@speak', () => speak(true)],
    ['Round vision', 'Next stop', '@stop.next', () => stepStop(1)],
    ['Round vision', 'Previous stop', '@stop.prev', () => stepStop(-1)],
    ['Round vision', 'Open the round vision list', '', () => toggleDrawer(true, 'vision')],
    ['Round vision', 'Clear round vision', '', () => { if (confirm('Clear every round vision stop?')) { S.vision = []; visionAt = -1; afterVision(); } }],
    ['Evidence', 'Find evidence that answers this', '@answer', () => answerFromEvidence()],
    ['Evidence', 'Search the library', '/', () => openPal('/')],
    ['Evidence', 'Open Evidence', '', () => window.open('/tools/evidence', 'break-evidence')],
    ['Flows', 'New Pro flow', '@flow.newpro', () => addSheet('pro')],
    ['Flows', 'New Con flow', '@flow.newcon', () => addSheet('con')],
    ['Flows', 'Rename this flow', '@flow.rename', () => renameSheet()],
    ['Flows', 'Delete this flow', '@flow.delete', () => deleteSheet()],
    ['Flows', 'Copy this flow as text', '@flow.copy', () => copyText(false)],
    ['Flows', 'Copy every flow as text', '', () => copyText(true)],
    ['Clock', 'Start / pause the clock', '@clock', toggleTimer],
    ['Clock', 'Flip who speaks first', '', flipFirst],
    ...PREP_CHOICES.map((s) => ['Clock', `Prep time — ${clock(s)} each`, '', () => setPrep(s)]),
    ['View', 'Split screen', '@split', () => setSplit(split === 'side' ? null : 'side')],
    ['View', 'Stack screens', '', () => setSplit(split === 'stack' ? null : 'stack')],
    ['View', 'Switch screen', '@swap', swapScreens],
    ['View', 'Widen the column I am in', '', () => $('#v-focus').click()],
    ['View', 'Tighter rows', '', () => $('#v-compact').click()],
    ['View', 'Notes, cards, round vision and send doc', '@drawer', () => toggleDrawer()],
    ['View', 'Keyboard shortcuts…', '@keys', () => openKeys()],
    ['Together', 'Flow with your partner', '', openShare],
    ['Round', 'Start a new round — this one is kept in Past flows', '', newRound],
    ['Round', 'Past flows — every round you have flowed', '', () => { location.href = '/tools/flows'; }],
    ['Round', 'Their case from SpeechDrop — tags down a column', '', () => openSd()],
  ];

  /** Places, built fresh each time: they change as the round does. */
  function places() {
    const out = [];
    S.vision.forEach((v, i) => out.push(['Round vision', `Go to · ${v.name}`, i < 9 ? '@stop.' + (i + 1) : '', () => goStop(i),
      (() => { const at = resolveStop(v); return at ? `${at.sheet.name} · ${(colsOn(at.sheet)[v.col] || colsOn(at.sheet)[0]).key}` : 'not on the flow'; })()]));
    S.sheets.forEach((s, i) => out.push(['Flows', `Go to · ${s.name}`, '', () => {
      if (editing) commit(); A.cur = i; A.sel = firstSel(); A.anchor = null; render(); A.flow.scrollTo(0, 0);
    }, s.side]));
    SP.forEach((sp, i) => out.push(['Clock', `Clock to · ${sp.long}`, '', () => setSpeech(i, true), clock(sp.secs)]));
    colsOf().forEach((col, i) => out.push(['Editing', `Write in · ${col.long}`, '@col.' + (i + 1), () => jumpCol(i), '']));
    INBOX.forEach((m) => m.tags.forEach((t) => out.push(['From Evidence', `Flow · ${t}`, '', () => flowIt({ text: t }, false), m.title])));
    return out;
  }

  /**
   * Letters in order, anywhere, with a bonus for the start of a word — and a
   * much bigger one for the letters appearing together. Typing "flip" means
   * the command with "flip" in it, not one whose f, l, i and p happen to fall
   * on four different words.
   */
  function fuzzy(q, s) {
    const t = s.toLowerCase();
    const bare = t.replace(/\s/g, '');
    const at = t.indexOf(q);
    if (at >= 0) {
      const start = at === 0 || /[\s·—(/-]/.test(t[at - 1]);
      return { score: 100 + (start ? 40 : 0) - at - t.length * 0.02, hits: [...q].map((_, i) => at + i) };
    }
    let qi = 0, score = 0, last = -2;
    const hits = [];
    for (let i = 0; i < t.length && qi < q.length; i++) {
      if (t[i] !== q[qi]) continue;
      hits.push(i);
      score += (i === last + 1 ? 4 : 1) + (i === 0 || /[\s·—(/-]/.test(t[i - 1]) ? 3 : 0);
      last = i; qi++;
    }
    if (qi !== q.length) return null;
    return { score: score + (bare.includes(q) ? 30 : 0) - t.length * 0.02, hits };
  }
  const lit = (s, hits) => {
    if (!hits || !hits.length) return esc(s);
    const set = new Set(hits);
    return [...s].map((ch, i) => (set.has(i) ? `<u>${esc(ch)}</u>` : esc(ch))).join('');
  };

  const pal = { items: [], idx: 0, mode: 'cmd', target: null, source: '', pick: null };

  function openPal(prefill, target, source) {
    if (editing) commit();
    if (asking) asking(null);
    pal.target = target || null;
    pal.source = source || '';
    $('#scrim').hidden = false;
    $('#pal-q').value = prefill || '';
    pal.idx = 0;
    INDEX = null;
    listPal();
    $('#pal-q').focus();
    const q = $('#pal-q'); q.setSelectionRange(q.value.length, q.value.length);
  }
  function closePal() {
    $('#scrim').hidden = true; pal.target = null; pal.source = ''; pal.pick = null; $('#pal-bins').hidden = true;
    $('#pal').classList.remove('pick');
    $('#pal-q').placeholder = 'Run a command, go somewhere — or / to search your evidence';
    A.flow.focus({ preventScroll: true });
  }

  /**
   * A block chosen in the palette opens to its cards: scroll them, Enter takes
   * the one you are on, Space or Tab picks several, and the first row takes
   * every card. Esc goes back to the results.
   */
  async function pickFrom(hit, withSend) {
    const tags = await blockTags(OWNER, hit.id);
    if (!tags.length) { const target = pal.target; closePal(); return flowIt(hit, withSend, target); }
    pal.pick = { hit, tags, sel: new Set(), back: $('#pal-q').value, backIdx: pal.idx };
    $('#pal-q').value = '';
    $('#pal-q').placeholder = 'Filter the cards in this block';
    $('#pal').classList.add('pick');
    pal.idx = 1;
    listPal();
    $('#pal-q').focus();
  }
  function unpick() {
    const P = pal.pick;
    if (!P) return;
    pal.pick = null;
    $('#pal').classList.remove('pick');
    $('#pal-q').placeholder = 'Run a command, go somewhere — or / to search your evidence';
    $('#pal-q').value = P.back;
    listPal().then(() => { pal.idx = P.backIdx; moveHl(true); });
  }
  function togglePick() {
    const P = pal.pick, it = pal.items[pal.idx];
    if (!P || !it) return;
    if (it.all) { if (P.sel.size === P.tags.length) P.sel.clear(); else P.tags.forEach((t) => P.sel.add(t.i)); }
    else if (it.tag) { if (P.sel.has(it.tag.i)) P.sel.delete(it.tag.i); else P.sel.add(it.tag.i); }
    const keep = pal.idx;
    listPal().then(() => { pal.idx = keep; moveHl(true); });
  }
  function commitPick(withSend) {
    const P = pal.pick, it = pal.items[pal.idx];
    if (!P) return;
    let picks = [...P.sel];
    if (!picks.length && it) picks = it.all ? P.tags.map((t) => t.i) : it.tag ? [it.tag.i] : [];
    if (!picks.length) return;
    picks.sort((a, b) => a - b);
    const target = pal.target;
    const lines = picks.map((i) => P.tags.find((t) => t.i === i).title);
    closePal();
    flowIt(P.hit, withSend, target, lines, picks.length === P.tags.length ? null : picks);
  }

  /**
   * The Evidence bins, switchable from the search itself — so a round's
   * piles can be put in or left out without leaving the flow.
   */
  async function paintPalBins(show) {
    const box = $('#pal-bins');
    if (!show) { box.hidden = true; return; }
    const { bins, counts } = await readBins(OWNER);
    if (!bins.list.length || pal.pick || $('#scrim').hidden) { box.hidden = true; return; }
    const chip = (id, name, on) => `<button type="button" class="pbin${on ? ' on' : ''}" data-pbin="${esc(id)}" data-on="${on ? 1 : 0}" title="${on ? 'Searched this round — click to leave it out' : 'Left out — click to search it'}"><i></i>${esc(name)}<em>${counts[id] || 0}</em></button>`;
    box.innerHTML = '<span class="pb-l">Bins this round</span>' + bins.list.map((b) => chip(b.id, b.name, b.on)).join('') + (counts[''] ? chip('', 'Unsorted', bins.loose) : '');
    box.hidden = false;
  }

  async function listPal() {
    const raw = $('#pal-q').value;
    paintPalBins(!pal.pick && raw.startsWith('/'));
    if (pal.pick) {
      const P = pal.pick;
      const f = raw.trim().toLowerCase();
      const tags = P.tags.filter((t) => !f || (t.title + ' ' + t.cite).toLowerCase().includes(f));
      pal.items = [{ all: true, label: `Every card in the block — all ${P.tags.length}`, sub: P.hit.title }]
        .concat(tags.map((t) => ({ tag: t, label: t.title, sub: t.cite })));
      $('#pal-src').hidden = false;
      $('#pal-src').innerHTML = `<b>${esc(P.hit.title)}</b> · ${P.sel.size ? `${P.sel.size} picked` : 'Enter takes the card you are on'}` +
        (pal.source ? ` · answering ${esc(pal.source)}` : '');
      $('#pal-foot').innerHTML = `<span><kbd>Space</kbd> or <kbd>Tab</kbd> pick more than one</span>` +
        `<button type="button" class="pf-go" data-send="1"><kbd>${kb('enter')}</kbd> flow + send${P.sel.size ? ` ${P.sel.size}` : ''}</button>` +
        `<button type="button" class="pf-go" data-send="0"><kbd>${kb('shift+enter')}</kbd> flow only</button>` +
        `<span><kbd>${kb('esc')}</kbd> back to the blocks</span>`;
      paintPal(tags.length ? '' : '');
      return;
    }
    pal.mode = raw.startsWith('/') ? 'ev' : 'cmd';
    const q = raw.replace(/^\//, '').trim().toLowerCase().replace(/\s+/g, ' ');
    $('#pal').classList.toggle('ev', pal.mode === 'ev');
    $('#pal .glyph').textContent = pal.mode === 'ev' ? '/' : '›';
    $('#pal-src').hidden = !(pal.mode === 'ev' && pal.source);
    $('#pal-src').innerHTML = pal.source ? `Answering <b>${esc(pal.source)}</b>` : '';
    $('#pal-foot').innerHTML = pal.mode === 'ev'
      ? `<span><kbd>${kb('enter')}</kbd> open the block's cards</span><span><kbd>${kb('esc')}</kbd> close</span>`
      : `<span><kbd>↑↓</kbd> move</span><span><kbd>${kb('enter')}</kbd> run</span><span><kbd>/</kbd> search your evidence</span><span><kbd>${kb('esc')}</kbd> close</span>`;

    if (pal.mode === 'ev') {
      await loadIndex();
      if (!INDEX.length) { pal.items = []; paintPal('<li class="empty">Nothing in your Evidence library yet.</li>'); return; }
      if (!q) { pal.items = []; paintPal(`<li class="empty">${INDEX.length} blocks. Type what you are looking for.</li>`); return; }
      const hits = find(INDEX, q, 30);
      pal.items = hits.map((h) => ({ group: 'Evidence', label: h.title, sub: `/${h.trigger}${h.path ? ' · ' + h.path : ''}${cardsIn(h)}`, hit: h }));
      if (!pal.items.length) { paintPal('<li class="empty">Nothing matches.</li>'); return; }
      paintPal();
      return;
    }

    const keyed = (k) => (k && k[0] === '@' ? keyOf(k.slice(1)) : k);
    const all = CMDS.map((c) => ({ group: c[0], label: c[1], key: keyed(c[2]), run: c[3], sub: '' }))
      .concat(places().map((c) => ({ group: c[0], label: c[1], key: keyed(c[2]), run: c[3], sub: c[4] || '' })));
    if (!q) {
      // Nothing typed: the places you are most likely to want, then the rest,
      // grouped the way they are listed above.
      const order = ['Round vision', 'From Evidence', 'Evidence', 'Editing', 'Flows', 'Clock', 'View', 'Together', 'Round'];
      pal.items = all.filter((x) => !(x.group === 'Clock' && x.label.startsWith('Clock to')))
        .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
    } else {
      const qq = q.replace(/\s/g, '');
      pal.items = all.map((x) => { const f = fuzzy(qq, x.label); return f ? Object.assign({}, x, { score: f.score, hits: f.hits }) : null; })
        .filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 40);
    }
    paintPal(pal.items.length ? '' : '<li class="empty">No command by that name. Start with / to search your evidence.</li>');
  }

  function paintPal(empty) {
    pal.idx = Math.min(pal.idx, Math.max(0, pal.items.length - 1));
    const typed = !!$('#pal-q').value.replace(/^\//, '').trim();
    let html = '', lastGroup = null;
    pal.items.forEach((it, j) => {
      if (!typed && it.group && it.group !== lastGroup) { html += `<li class="grp">${esc(it.group)}</li>`; lastGroup = it.group; }
      const P = pal.pick;
      const ticked = P && (it.all ? P.sel.size === P.tags.length : it.tag && P.sel.has(it.tag.i));
      html += `<li class="it${j === pal.idx ? ' on' : ''}${it.all ? ' all' : ''}" data-j="${j}" style="--i:${Math.min(j, 14)}">` +
        `${P ? `<span class="ck${ticked ? ' on' : ''}" data-ck="${j}" aria-hidden="true"></span>` : ''}` +
        `<span class="lb">${lit(it.label, it.hits)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>` +
        `${typed && it.group !== 'Evidence' ? `<span class="gtag">${esc(it.group)}</span>` : ''}` +
        `${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</li>`;
    });
    const list = $('#pal-list');
    list.innerHTML = (empty || '') + html + '<li class="hl" aria-hidden="true"></li>';
    moveHl(true);
  }
  /** The highlight slides between rows rather than jumping. */
  function moveHl(instant) {
    const list = $('#pal-list');
    const on = list.querySelector('.it.on');
    const hl = list.querySelector('.hl');
    list.querySelectorAll('.it').forEach((x) => x.classList.toggle('on', +x.dataset.j === pal.idx));
    const cur = list.querySelector(`.it[data-j="${pal.idx}"]`) || on;
    if (!hl) return;
    if (!cur) { hl.style.opacity = '0'; return; }
    if (instant) hl.style.transition = 'none';
    hl.style.opacity = '1';
    hl.style.transform = `translateY(${cur.offsetTop}px)`;
    hl.style.height = cur.offsetHeight + 'px';
    if (instant) { void hl.offsetWidth; hl.style.transition = ''; }
    const top = cur.offsetTop, bottom = top + cur.offsetHeight;
    if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 6;
    if (top < list.scrollTop) list.scrollTop = top - 30;
  }
  function runPal(j, withSend) {
    const it = pal.items[j];
    if (!it) return;
    if (pal.pick) { pal.idx = j; return commitPick(!!withSend); }
    if (it.hit) return pickFrom(it.hit, !!withSend);
    closePal();
    if (it.run) it.run();
  }
  function palKeys(e) {
    if (pal.pick) {
      if (e.key === 'Escape') { e.preventDefault(); unpick(); return; }
      if (e.key === 'Tab' || (e.key === ' ' && !$('#pal-q').value)) { e.preventDefault(); togglePick(); return; }
    }
    if (e.key === 'Escape') { e.preventDefault(); closePal(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!pal.items.length) return;
      pal.idx = (pal.idx + (e.key === 'ArrowDown' ? 1 : -1) + pal.items.length) % pal.items.length;
      moveHl();
      return;
    }
    // Enter flows it and sends the block; Shift+Enter only flows it.
    if (e.key === 'Enter') { e.preventDefault(); runPal(pal.idx, !e.shiftKey); }
  }
  let palTimer = null;
  on($('#pal-q'), 'input', () => { pal.idx = pal.pick ? 1 : 0; clearTimeout(palTimer); palTimer = setTimeout(listPal, $('#pal-q').value.startsWith('/') ? 90 : 0); });
  on($('#pal-list'), 'click', (e) => {
    const li = e.target.closest('.it');
    if (!li) return;
    if (pal.pick && (e.target.closest('.ck') || e.ctrlKey)) { pal.idx = +li.dataset.j; togglePick(); return; }
    runPal(+li.dataset.j, !e.shiftKey);
  });
  on($('#pal-bins'), 'mousedown', (e) => e.preventDefault());
  on($('#pal-bins'), 'click', async (e) => {
    const b = e.target.closest('[data-pbin]');
    if (!b) return;
    await setBinUse(OWNER, b.dataset.pbin, b.dataset.on !== '1');
    BUS.post({ kind: 'bins-changed' });
    INDEX = null;
    await listPal();
    $('#pal-q').focus();
  });
  on($('#pal-foot'), 'click', (e) => { const b = e.target.closest('.pf-go'); if (b && pal.pick) commitPick(b.dataset.send === '1'); });
  on($('#pal-list'), 'pointermove', (e) => { const li = e.target.closest('.it'); if (li && +li.dataset.j !== pal.idx) { pal.idx = +li.dataset.j; moveHl(); } });
  on($('#scrim'), 'click', (e) => { if (e.target.id === 'scrim') closePal(); });
  on($('#cmd-btn'), 'click', () => openPal());

  /**
   * Evidence that answers the argument you are on.
   *
   * On their argument, the answer goes in the next column; on an empty cell
   * beside it, the answer goes where you are. Either way the search is for
   * the words of their argument, and Enter puts the tag where it belongs.
   */
  function answerFromEvidence() {
    if (!A.sel) return openPal('/');
    if (editing) commit();
    const row = rows()[A.sel.r];
    const here = cleanText(row.c[A.sel.c]);
    const left = A.sel.c > 0 ? cleanText(row.c[A.sel.c - 1]) : '';
    const source = here || left;
    const target = here && A.sel.c < LAST ? { r: A.sel.r, c: A.sel.c + 1 } : { r: A.sel.r, c: A.sel.c };
    openPal('/' + source.slice(0, 80), target, source.slice(0, 60));
  }

  function newRound() {
    const had = gridHasWriting(S);
    archiveNow();
    const fresh = freshDoc();
    fresh.first = S.first; fresh.prep = S.prep;
    Object.assign(S, fresh);
    afterSwap();
    toast(had ? 'New round — the last one is in Past flows' : 'New round');
  }

  /** A round out of Past flows, in place of this one — which is kept there first. */
  function openRound(d, name) {
    const r = repair(JSON.parse(JSON.stringify(d)));
    if (!r) return toast('That round could not be read');
    archiveNow();
    Object.assign(S, freshDoc(), r);
    afterSwap();
    toast(`Opened “${name || 'a past round'}”`);
  }

  function afterSwap() {
    SP = speechesFor(S.first);
    left = SP.map((s) => s.secs); ti = 0; run = false; tmode = 'sp';
    prep.pro = S.prep; prep.con = S.prep;
    UNDO.length = 0; REDO.length = 0;
    visionAt = -1; if (speaking) speak(false);
    PANES.forEach((p, i) => { p.cur = Math.min(i, S.sheets.length - 1); p.sel = null; p.anchor = null; });
    $('#notes').value = S.notes || ''; render(); paintT(); paintVision(); save(); pushDoc(); pushVision();
  }

  /* toast, with Undo on anything that took something away */
  let tt = null;
  function toast(m, withUndo) {
    const t = $('#toast');
    t.innerHTML = esc(m) + (withUndo ? '<button type="button" class="undo">Undo</button>' : '');
    t.classList.toggle('act', !!withUndo);
    t.style.setProperty('--life', (withUndo ? 3400 : 1600) + 'ms');
    t.classList.remove('on'); void t.offsetWidth; t.classList.add('on');
    clearTimeout(tt);
    tt = setTimeout(() => t.classList.remove('on', 'act'), withUndo ? 3400 : 1600);
    const u = t.querySelector('.undo');
    if (u) u.onclick = () => { t.classList.remove('on', 'act'); undo(); };
  }
  offs.push(() => clearTimeout(tt));

  /* ================================================================
     12. Flowing together
     ================================================================ */

  let live = null;          // the session, once there is one
  let applying = false;     // true while a change from the other side is landing
  let peers = [];
  let caretTimer = null;

  const meName = () => {
    try { return localStorage.getItem(scoped(NAME_KEY, OWNER)) || opts.me || ''; } catch { return opts.me || ''; }
  };

  function pushCell(sheetId, rowId, col, text) { if (live && !applying) live.send('cell', { s: sheetId, r: rowId, c: col, t: text }); }
  function pushRows(sheet) { if (live && !applying) live.send('rows', { s: sheet.id, rows: sheet.rows }); }
  function pushDoc() { if (live && !applying) live.send('doc', { layout: 2, sheets: S.sheets, first: S.first, prep: S.prep }); }
  function pushNotes() { if (live && !applying) live.send('notes', { t: S.notes }); }
  // The round vision is the pair's plan for the next speech, so it travels too.
  function pushVision() { if (live && !applying) live.send('vision', { v: S.vision }); }
  function pushTimer() { if (live && !applying) live.send('timer', { i: ti, left: left[ti], run, mode: tmode, prep }); }
  function pushCaret() {
    if (!live || applying || !A.sel) return;
    clearTimeout(caretTimer);
    caretTimer = setTimeout(() => {
      const sheet = sheetOf(), row = rows()[A.sel.r];
      if (row) live.send('caret', { sheet: sheet.id, row: row.id, col: A.sel.c });
    }, 90);
  }

  function applyEvent(type, d) {
    applying = true;
    try {
      if (type === 'cell') {
        const sheet = sheetById(d.s);
        if (!sheet) return;
        const row = sheet.rows.find((r) => r.id === d.r);
        if (!row || !row.c) return;
        row.c[d.c] = d.t;
        visible().forEach((p) => { if (sheetOf(p) === sheet) { const el = cellEl(sheet.rows.indexOf(row), d.c, p); if (el && el !== editing) { el.innerHTML = fmt(d.t); flash(el); } marks(p); } });
        save();
        return;
      }
      if (type === 'rows') {
        const sheet = sheetById(d.s);
        if (!sheet) return;
        sheet.rows = d.rows;
        renderAll(); save();
        return;
      }
      if (type === 'doc' || type === 'full') {
        const doc = type === 'full' ? d.doc : d;
        if (!doc || !Array.isArray(doc.sheets)) return;
        if (doc.layout !== 2 && doc.sheets.some((sh) => (sh.rows || []).some((r) => r.c && r.c.length === 8))) {
          doc.first = doc.first === 'con' ? 'con' : 'pro';
          doc.sheets.forEach((sh) => { sh.side = sh.side === 'con' ? 'con' : 'pro'; });
          relayout(doc);
        }
        S.sheets = doc.sheets;
        if (doc.first && doc.first !== S.first) { S.first = doc.first; SP = speechesFor(S.first); left = SP.map((s) => s.secs); }
        if (doc.prep) S.prep = doc.prep;
        if (type === 'full' && typeof doc.notes === 'string') { S.notes = doc.notes; $('#notes').value = doc.notes; }
        if (type === 'full' && Array.isArray(doc.vision)) { S.vision = doc.vision; visionAt = -1; paintVision(); }
        PANES.forEach((p) => { p.cur = Math.min(p.cur, S.sheets.length - 1); p.sel = null; p.anchor = null; });
        renderAll(); paintT(); save();
        if (type === 'full') toast('Flow received');
        return;
      }
      if (type === 'notes') { S.notes = d.t; $('#notes').value = d.t; save(); return; }
      if (type === 'senddoc') { receiveDoc(d, 'room'); return; }
      if (type === 'vision') {
        S.vision = Array.isArray(d.v) ? d.v : [];
        if (visionAt >= S.vision.length) visionAt = S.vision.length - 1;
        paintVision(); visible().forEach(paintStops); paintSpeak(); save();
        return;
      }
      if (type === 'timer') {
        ti = d.i; left[ti] = d.left; run = d.run; tmode = d.mode;
        if (d.prep) { prep.pro = d.prep.pro; prep.con = d.prep.con; }
        paintT();
        return;
      }
    } finally { applying = false; }
  }

  /** Where the other person is working, drawn over the grid. */
  /**
   * Your partner's cursor, as a mark on the cell it is in. It used to be a box
   * laid over the grid by position, which was left behind whenever the column
   * widths moved under it (Focus widens the column you are in) or a row grew
   * as someone typed. On the cell it goes wherever the cell goes.
   */
  function paintPeers(p = A) {
    p.grid.querySelectorAll('.c.peer').forEach((x) => { x.classList.remove('peer'); x.removeAttribute('data-peer'); x.style.removeProperty('--hue'); });
    const sheet = sheetOf(p);
    peers.forEach((peer) => {
      if (!peer.caret || peer.caret.sheet !== sheet.id) return;
      const ri = rowIndex(sheet, peer.caret.row);
      if (ri < 0) return;
      const el = cellEl(ri, peer.caret.col, p);
      if (!el) return;
      el.classList.add('peer');
      el.setAttribute('data-peer', peer.name);
      el.style.setProperty('--hue', String(peer.hue));
    });
  }

  function paintShare() {
    const on = !!live;
    $('#share-btn').classList.toggle('on', on);
    $('#share-btn').setAttribute('aria-pressed', String(on));
    $('#share-state').textContent = !on ? 'Not shared'
      : peers.length ? `${peers.filter((p) => p.kind === 'flow').length + 1} flowing${peers.some((p) => p.kind === 'evidence') ? ' · send doc' : ''}${peers.some((p) => p.kind === 'viewer') ? ' · reading' : ''}` : 'Waiting for your partner';
    $('#share-dot').className = 'dot' + (on ? (peers.length ? ' live' : ' waiting') : '');
    $('#share-code').textContent = on ? live.code : '—';
    $('#share-leave').hidden = !on;
    $('#share-start').hidden = on;
    $('#share-join').hidden = on;
    $('#share-peers').innerHTML = peers.map((p) =>
      `<span class="peer${p.kind !== 'flow' ? ' evi' : ''}" style="--hue:${p.hue}">${esc(p.name)}${p.kind === 'evidence' ? ' · send doc' : p.kind === 'viewer' ? ' · reading' : ''}</span>`).join('') || '';
    $('#share-evi').hidden = !on;
  }
  function openShare() {
    $('#sharebox').hidden = false;
    $('#share-name').value = meName();
    paintShare();
    setTimeout(() => $(live ? '#share-leave' : '#share-name').focus(), 30);
  }
  function closeShare() { $('#sharebox').hidden = true; }

  function connect(code) {
    const name = ($('#share-name').value || '').trim().slice(0, 24) || 'Partner';
    try { localStorage.setItem(scoped(NAME_KEY, OWNER), name); } catch { /* private browsing */ }
    if (live) live.leave();
    live = joinFlow(code, name, {
      onEvent: applyEvent,
      onPeers: (list) => { peers = list; visible().forEach(paintPeers); paintShare(); },
      onStatus: (status, detail) => {
        if (status === 'error') { toast('Could not share: ' + (detail || 'no connection')); }
        paintShare();
      },
      snapshot: () => ({ layout: 2, sheets: S.sheets, first: S.first, prep: S.prep, notes: S.notes, vision: S.vision }),
    });
    try { localStorage.setItem(scoped('flow.room', OWNER), code); } catch { /* private browsing */ }
    paintShare(); paintSendDoc();
    toast('Room ' + code + ' — copy the link for your partner');
  }
  on($('#share-btn'), 'click', openShare);
  on($('#share-x'), 'click', closeShare);
  on($('#sharebox'), 'click', (e) => { if (e.target.id === 'sharebox') closeShare(); });
  on($('#share-start'), 'click', () => connect(newCode()));
  on($('#share-join'), 'click', () => {
    const code = tidyCode($('#share-in').value);
    if (code.length < 4) return toast('That is not a code');
    connect(code);
  });
  on($('#share-in'), 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#share-join').click(); } });
  on($('#share-leave'), 'click', () => {
    if (live) live.leave();
    live = null; peers = []; DOCS.room = null;
    try { localStorage.removeItem(scoped('flow.room', OWNER)); } catch { /* private browsing */ }
    paintSendDoc();
    visible().forEach(paintPeers); paintShare();
    toast('Flowing on your own again');
  });
  // The link, not the code: a partner without the admin key cannot reach a
  // page to type a code into, but a link carrying one opens the room directly.
  const joinLink = () => `${location.origin}/tools/flow?join=${live.code}`;
  on($('#share-evi'), 'click', copyEvidenceLink);
  on($('#share-copy'), 'click', async () => {
    if (!live) return;
    try { await navigator.clipboard.writeText(joinLink()); toast('Link copied — send it to your partner'); }
    catch { toast('The clipboard said no'); }
  });

  /* ================================================================
     Start
     ================================================================ */

  // Labels written into the page's markup, named for this computer.
  fillKeys();
  PANES[1].root.hidden = true;
  paintActive();
  PANES.forEach((p) => { p.sel = firstSel(p); });
  render(); paintT(); paintVision(); paintInbox(); paintShare();
  if (A.sel) setSel(A.sel.r, A.sel.c, false);
  if (opts.join) { openShare(); $('#share-in').value = opts.join; }
  else if (opts.open) {
    getRound(OWNER, opts.open).then((rec) => {
      try { const u = new URL(location.href); u.searchParams.delete('open'); history.replaceState(null, '', u.toString()); } catch { /* fine */ }
      if (!rec || rec.kind !== 'grid') return toast('That round is not in Past flows any more');
      if (rec.id !== S.id) openRound(rec.data, rec.name);
    });
  }

  return () => {
    archiveNow();
    offs.forEach((f) => f());
    clearTimeout(saveTimer); clearTimeout(caretTimer); clearTimeout(notesTimer); clearTimeout(cardTimer);
    try { localStorage.setItem(scoped(STORE, OWNER), JSON.stringify(S)); } catch { /* private browsing */ }
    if (live) {
      live.leave();
      try { localStorage.removeItem(scoped('flow.room', OWNER)); } catch { /* private browsing */ }
    }
    document.body.classList.remove('flw-dragging');
  };
}
