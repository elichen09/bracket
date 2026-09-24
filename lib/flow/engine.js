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

import { columns as colsFor, speeches as speechesFor, clock, PREP_DEFAULT, PREP_CHOICES } from './format';
import { joinFlow, newCode, tidyCode } from './share';
import { library, find, sendToEvidence } from './cards';
import { scoped, adoptLocal } from '../owner';
import { openBus } from '../toolsBus';

const STORE = 'flow.doc';
const NAME_KEY = 'flow.me';
const RM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Every Ctrl combination the flow answers to — claimed from the browser. */
const CLAIMED = new Set(['k', '/', 'j', '.', '\\', "'", '[', ']', 'b', 'd', 'e', 'z', 'y']);

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

  const blankRows = (n = 6) => Array.from({ length: n }, () => ({ id: uid('r'), c: Array(8).fill('') }));

  const freshDoc = () => ({
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
  let COLS = colsFor(S.first);
  let SP = speechesFor(S.first);

  function load() {
    try {
      const raw = adoptLocal(STORE, OWNER);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.sheets) || !d.sheets.length) return null;
      // Anything written by an older shape is repaired rather than thrown out.
      d.sheets.forEach((s) => {
        s.id = s.id || uid('s');
        s.rows = (s.rows || []).map((r) => Object.assign({ id: r.id || uid('r') }, r,
          r.c ? { c: Array.from({ length: 8 }, (_, i) => (r.c[i] || '')) } : null));
      });
      d.first = d.first === 'con' ? 'con' : 'pro';
      d.prep = Number(d.prep) || PREP_DEFAULT;
      d.meta = d.meta || { tourn: '', round: '', side: 'pro' };
      d.notes = d.notes || '';
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

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(scoped(STORE, OWNER), JSON.stringify(S)); } catch { /* private browsing */ }
    }, 350);
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
  const LAST = 7;

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
    COLS = colsFor(S.first); SP = speechesFor(S.first);
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
    COLS.forEach((col, i) => {
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
          return `<div class="c ${COLS[ci].side}${b}" data-r="${ri}" data-c="${ci}"${n ? ` data-stop="${n}"` : ''}>${fmt(t)}</div>`;
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
      '<button type="button" class="plus" data-add="pro">+ Pro</button><button type="button" class="plus" data-add="con">+ Con</button>';
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
    const c = COLS.findIndex((col) => col.side === sheetOf(p).side);
    return { r: i, c: c < 0 ? 0 : c };
  }

  /**
   * The two marks that make a flow readable at a glance: a red edge on an
   * argument the other side has not answered, and hatching on the cell where
   * that answer should have gone.
   */
  function marks(p = A) {
    const sp = COLS.map((_, i) => spoken(i, p));
    const cells = [...p.grid.querySelectorAll('.c')];
    cells.forEach((el) => {
      const r = +el.dataset.r, c = +el.dataset.c, row = rows(p)[r].c;
      const open = row[c].trim() && c < LAST && sp[c + 1] && !row[c + 1].trim() && !row.slice(c + 2).some((x) => x.trim());
      el.classList.toggle('open', !!open);
      el.title = open ? `No answer in ${COLS[c + 1].key}` : '';
    });
    cells.forEach((el) => {
      const c = +el.dataset.c;
      const prev = c > 0 ? cellEl(+el.dataset.r, c - 1, p) : null;
      el.classList.toggle('miss', !!(prev && prev.classList.contains('open')));
    });
    COLS.forEach((_, i) => {
      const n = rows(p).filter((x) => x.c && x.c[i].trim()).length;
      const h = p.grid.querySelector(`.h[data-col="${i}"] .ct`);
      if (h) h.textContent = n || '';
    });
  }

  /** The column you are in, and the one it answers, get the room. */
  function widths(p = A) {
    const w = COLS.map(() => 1);
    if (focusOn && p.sel) { w[p.sel.c] = 1.8; if (p.sel.c > 0) w[p.sel.c - 1] = 1.35; }
    const narrow = split === 'side';
    const lo = narrow ? 84 : 112, hi = narrow ? 140 : 180;
    p.grid.style.minWidth = narrow ? '820px' : '1080px';
    const next = '24px ' + w.map((x) => `minmax(${x > 1 ? hi : lo}px,${x}fr)`).join(' ');
    if (p.grid.style.gridTemplateColumns !== next) { p.grid.style.gridTemplateColumns = next; follow(p, 420); }
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
    p.cursor.style.width = el.offsetWidth + 1 + 'px';
    p.cursor.style.height = el.offsetHeight + 1 + 'px';
    const ed = p === A && !!editing;
    p.cursor.classList.toggle('editing', ed);
    p.cursor.classList.toggle('range', !!p.anchor);
    // The cursor wears the colour of the side whose column it is in.
    p.cursor.classList.toggle('pro', COLS[p.sel.c].side === 'pro');
    p.cursor.classList.toggle('con', COLS[p.sel.c].side === 'con');
    p.cursor.classList.toggle('top', el.offsetTop < 70);
    p.lab.textContent = COLS[p.sel.c].key + (ed ? ' · editing' : p.anchor ? ` · ${rangeCells(p).length} cells` : '');
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
    rows().splice(at, 0, { id: uid('r'), c: Array(8).fill('') });
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
    if (n >= rs.length || !rs[n].c) { snap(); rs.splice(n, 0, { id: uid('r'), c: Array(8).fill('') }); render([n]); pushRows(sheetOf()); }
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
      if (!rows().length) rows().push({ id: uid('r'), c: Array(8).fill('') });
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
        if (n >= rows().length || !rows()[n].c) { rows().splice(n, 0, { id: uid('r'), c: Array(8).fill('') }); born.push(n); }
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
        return row.c.map((t, i) => (t.trim() ? COLS[i].key + ': ' + t.replace(/\n/g, ' / ') : '')).filter(Boolean).join('  |  ');
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
        ghost.innerHTML = esc(rows(drag.p)[drag.r].c[drag.c]) + `<small>${COLS[drag.c].key}</small>`;
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
      ['Move row up', kb('alt+↑'), () => moveRow(r, -1)], ['Move row down', kb('alt+↓'), () => moveRow(r, 1)],
      ['Move cell left', kb('mod+shift+←'), () => moveCell(r, c, -1)], ['Move cell right', kb('mod+shift+→'), () => moveCell(r, c, 1)], '-',
      ['Mark dropped', kb('mod+D'), () => tag('DROPPED')],
      ['Mark extended', kb('mod+E'), () => tag('EXT')],
      ['Mark turn', '', () => tag('TURN')],
      [stopAt(A.sel) ? 'Take out of round vision' : 'Add to round vision', kb('mod+B'), () => toggleStop()],
      ['Find evidence that answers this', kb('mod+/'), () => answerFromEvidence()],
      [split ? 'Open this flow on the other screen' : 'Open in split screen', kb('mod+\\'), () => openBeside(A.cur)], '-',
      [many ? `Clear ${many.length} cells` : 'Clear cell', kb('back'), () => clearCells(many || [{ r, c }]), 'danger'],
      ['Delete cell, shift column up', kb('shift+back'), () => deleteCellUp(r, c), 'danger'],
      [many ? 'Delete these rows' : 'Delete row', kb('mod+back'), () => deleteRows(many ? many.map((x) => x.r) : [r]), 'danger'],
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

  // Capture phase on the window, so this runs before anything else on the
  // page can take a key — and before the browser acts on one.
  on(window, 'keydown', (e) => {
    if (!root.isConnected) return;
    const inField = e.target.matches && e.target.matches('input,textarea,select');
    // Every Ctrl combination the flow uses is claimed here, first, whatever
    // state the tool is in. Before, a combination was only claimed once the
    // flow got round to acting on it, so any moment it did not — a text box
    // focused, a menu open, Caps Lock turning d into D — the browser had it
    // instead: Ctrl+D bookmarks the page, Ctrl+E jumps to the address bar,
    // Ctrl+J opens downloads. Undo and redo stay native inside a text box.
    // A key the page never sees at all has been taken by an extension;
    // chrome://extensions/shortcuts lists them.
    const low = (e.key || '').toLowerCase();
    if (mod(e) && !e.altKey && CLAIMED.has(low) && !(inField && (low === 'z' || low === 'y'))) e.preventDefault();
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
    // F2 renames the sheet, as it renames things everywhere else on Windows.
    if (e.key === 'F2' && !inField) { e.preventDefault(); renameSheet(); return; }
    if (mod(e) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPal(); return; }
    if (mod(e) && e.key === '/') { e.preventDefault(); answerFromEvidence(); return; }
    if (mod(e) && e.key.toLowerCase() === 'j') { e.preventDefault(); toggleDrawer(); return; }
    if (mod(e) && e.key === '.') { e.preventDefault(); toggleTimer(); return; }
    if (mod(e) && e.key === '\\') { e.preventDefault(); setSplit(split ? null : 'side'); return; }
    if (mod(e) && e.key === "'") { e.preventDefault(); swapScreens(); return; }
    // Ctrl+1–8 alone belongs to the browser (it switches tabs), so the columns
    // take Ctrl+Shift+1–8.
    if (mod(e) && e.shiftKey && /^Digit[1-8]$/.test(e.code)) { e.preventDefault(); jumpCol(+e.code.slice(5) - 1); return; }
    // Round vision: Alt+1–9 goes straight to a stop, Ctrl+] and Ctrl+[ walk them in order.
    if (e.altKey && !mod(e) && /^Digit[1-9]$/.test(e.code)) { e.preventDefault(); goStop(+e.code.slice(5) - 1); return; }
    if (mod(e) && (e.key === ']' || e.key === '[')) { e.preventDefault(); stepStop(e.key === ']' ? 1 : -1); return; }
    if (!$('#scrim').hidden) { palKeys(e); return; }
    if (inField) return;
    // Mid-speech, the keys a presentation clicker sends walk the vision too.
    if (speaking && !editing) {
      if (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) { e.preventDefault(); stepStop(1); return; }
      if (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) { e.preventDefault(); stepStop(-1); return; }
      if (e.key === 'Escape') { e.preventDefault(); speak(false); return; }
    }
    if (mod(e) && e.key.toLowerCase() === 'b') { e.preventDefault(); if (editing) commit(); toggleStop(); return; }
    if (mod(e) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod(e) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (!A.sel) return;
    const { r, c } = A.sel;

    if (editing) {
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
      if (mod(e) && /^[de]$/i.test(e.key)) { e.preventDefault(); tag(e.key.toLowerCase() === 'd' ? 'DROPPED' : 'EXT'); return; }
      if (mod(e) && e.key === 'Backspace') { e.preventDefault(); commit(); deleteRows([r]); return; }
      return;
    }

    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveRow(r, e.key === 'ArrowUp' ? -1 : 1); return; }
    // Alt+← is Back in a Windows browser — the last key to risk mid-round.
    if (mod(e) && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); moveCell(r, c, e.key === 'ArrowLeft' ? -1 : 1); return; }
    if (arrows[e.key]) {
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
    if (mod(e) && e.key === 'Backspace') { e.preventDefault(); deleteRows(A.anchor ? rangeCells().map((x) => x.r) : [r]); return; }
    if (e.shiftKey && e.key === 'Backspace') { e.preventDefault(); deleteCellUp(r, c); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); clearCells(A.anchor ? rangeCells() : [{ r, c }]); return; }
    if (mod(e) && /^[de]$/i.test(e.key)) { e.preventDefault(); tag(e.key.toLowerCase() === 'd' ? 'DROPPED' : 'EXT'); return; }
    if (e.key.length === 1 && !mod(e) && !e.altKey) { e.preventDefault(); startEdit(rows()[r].c[c] ? ' ' + e.key : e.key); return; }
  }, true);

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
    if (r < 0) { if (editing) commit(); rs.push({ id: uid('r'), c: Array(8).fill('') }); r = rs.length - 1; render([r]); pushRows(sheetOf()); }
    setSel(r, c, true);
    toast('Flowing ' + COLS[c].key + (split ? ' · screen ' + (A.i ? 'B' : 'A') : ''));
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
  });
  on($('#tabs'), 'contextmenu', (e) => {
    const t = e.target.closest('button[data-i]');
    if (!t) return;
    e.preventDefault();
    const i = +t.dataset.i;
    const items = [
      ['Rename', 'F2', () => renameSheet(i)],
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
    const col = tmode === 'sp' ? SP[ti].col : -1;
    $$('.h[data-col]').forEach((h) => h.classList.toggle('live', +h.dataset.col === col));
    $$('.c').forEach((el) => el.classList.toggle('livecol', +el.dataset.c === col));
    const nx = SP.slice(ti + 1).find((s) => s.col >= 0);
    const rf = $('#road-for');
    if (rf) rf.textContent = 'Roadmap for ' + (nx ? nx.long : 'the next speech');
  }
  function setSpeech(i, follow) {
    ti = (i + SP.length) % SP.length;
    tmode = 'sp'; run = false; left[ti] = SP[ti].secs;
    paintT(); pushTimer();
    if (follow && SP[ti].col >= 0) jumpCol(SP[ti].col);
  }
  function toggleTimer() {
    run = !run;
    paintT(); pushTimer();
    if (run && tmode === 'sp' && SP[ti].col >= 0 && (!A.sel || A.sel.c !== SP[ti].col)) jumpCol(SP[ti].col);
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
    // The words stay with the side that said them: every pair of columns swaps.
    S.sheets.forEach((s) => s.rows.forEach((row) => {
      if (!row.c) return;
      for (let i = 0; i < 8; i += 2) { const t = row.c[i]; row.c[i] = row.c[i + 1]; row.c[i + 1] = t; }
    }));
    COLS = colsFor(S.first); SP = speechesFor(S.first);
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
    ['notes', 'cards', 'vision'].forEach((p) => { $('#p-' + p).hidden = name !== p; });
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
    `<article class="card" style="--i:${Math.min(i, 10)}"><span class="ctag">${esc(h.title)}</span>` +
    `<span class="cite">/${esc(h.trigger)}${h.path ? ' · ' + esc(h.path) : ''}${cardsIn(h)}</span>` +
    `<span class="acts"><button class="ins go" type="button" data-i="${i}" data-send="1" title="Into the flow, and the whole block into your send doc">Flow + send</button>` +
    `<button class="ins" type="button" data-i="${i}" data-send="0" title="Into the flow only">Flow only</button></span></article>`;

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
    if (!q) { box.innerHTML = `<p class="small">${INDEX.length} blocks in your library. Type to search, or select an argument on the flow and press ${kb('mod+/')}.</p>`; return; }
    const hits = find(INDEX, q);
    box._hits = hits;
    box.innerHTML = hits.length ? hits.map(hitHtml).join('') : '<p class="small">Nothing matches.</p>';
  }
  on($('#q'), 'input', () => { clearTimeout(cardTimer); cardTimer = setTimeout(runCards, 140); });
  on($('#cardlist'), 'click', (e) => {
    const b = e.target.closest('.ins');
    if (!b) return;
    const hit = ($('#cardlist')._hits || [])[+b.dataset.i];
    if (hit) flowIt(hit, b.dataset.send === '1');
  });

  /**
   * Put a card's tag in the flow — and, when asked, the card itself in
   * Evidence's send list, so the speech doc and the flow are built by the
   * same keystroke.
   */
  async function flowIt(hit, alsoSend, target) {
    const t = target || (A.sel && { r: A.sel.r, c: A.sel.c });
    if (!t || !rows()[t.r] || !rows()[t.r].c) return toast('Pick a cell on the flow first');
    if (editing) commit();
    snap();
    const row = rows()[t.r];
    row.c[t.c] = (row.c[t.c] ? row.c[t.c] + '\n' : '') + hit.text;
    const el = cellEl(t.r, t.c);
    if (el) { el.innerHTML = fmt(row.c[t.c]); flash(el); el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
    if (!A.sel || t.r !== A.sel.r || t.c !== A.sel.c) setSel(t.r, t.c, false);
    marks(); placeCursor(A, true); syncOthers(); save();
    pushCell(sheetOf().id, row.id, t.c, row.c[t.c]);
    if (!alsoSend) return toast('Into ' + COLS[t.c].key, true);
    const ok = await sendToEvidence(OWNER, hit);
    if (ok) { BUS.post({ kind: 'send-changed', title: hit.title }); toast('Flowed — and the block is in your send doc', true); }
    else toast('Flowed — Evidence could not find that card to send', true);
  }

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
    if (m.kind !== 'sent') return;
    INBOX.unshift({ title: m.title, trigger: m.trigger, tags: (m.tags || []).filter(Boolean) });
    INBOX.length = Math.min(INBOX.length, 6);
    paintInbox();
    const btn = $('#drawer-btn');
    btn.classList.remove('ping'); void btn.offsetWidth; btn.classList.add('ping');
    toast('From Evidence: ' + m.title + ' — its tags are in Cards');
  });
  offs.push(() => BUS.close());

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
    const guess = (text.length > 34 ? text.slice(0, 33).trim() + '…' : text) || `${COLS[A.sel.c].key}, row ${A.sel.r + 1}`;
    const name = await ask('Name this stop', guess, cellEl(A.sel.r, A.sel.c), 'What you will call it in the speech');
    if (name === null) return;
    S.vision.push({ id: uid('v'), name: name.trim() || guess, sheet: sheetOf().id, row: row.id, col: A.sel.c });
    afterVision();
    const n = S.vision.length;
    const cell = cellEl(A.sel.r, A.sel.c);
    if (cell) spotlight(cell);
    toast(`Stop ${n} — ${name.trim() || guess}${n <= 9 ? ' · ' + kb('alt+' + n) : ''}`);
  }
  function afterVision() {
    paintVision(); visible().forEach(paintStops); paintSpeak(); save(); pushVision();
  }

  /** Go to a stop: its sheet, its cell, and a light on it. */
  function goStop(i) {
    const v = S.vision[i];
    if (!v) return toast(S.vision.length ? `There is no stop ${i + 1}` : `No round vision yet — ${kb('mod+B')} marks a cell`);
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
    if (!S.vision.length) return toast(`No round vision yet — ${kb('mod+B')} marks a cell`);
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
      list.innerHTML = `<li class="none"><span class="small">Nothing yet. Select a cell you mean to go for and press ${kb('mod+B')}.</span></li>`;
    } else {
      list.innerHTML = S.vision.map((v, i) => {
        const at = resolveStop(v);
        const where = at ? `${at.sheet.name} · ${COLS[v.col].key}` : 'not on the flow';
        return `<li class="vs${i === visionAt ? ' now' : ''}${at ? '' : ' gone'}" draggable="true" data-i="${i}" style="--i:${Math.min(i, 10)}">` +
          `<span class="n">${i + 1}</span><span class="nm"><b>${esc(v.name)}</b><span class="where">${esc(where)}</span></span>` +
          `${i < 9 ? `<kbd>${kb('alt+' + (i + 1))}</kbd>` : '<span></span>'}<button type="button" class="x" data-x="${i}" aria-label="Remove">×</button></li>`;
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
    if (onNow && !S.vision.length) return toast(`No round vision yet — ${kb('mod+B')} marks a cell`);
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
    $('#sp-where').textContent = at ? `${at.sheet.name} · ${COLS[v.col].key}` : '';
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
    ['Editing', 'Undo', kb('mod+Z'), undo],
    ['Editing', 'Redo', kb('mod+shift+Z'), redo],
    ['Editing', 'Mark dropped', kb('mod+D'), () => tag('DROPPED')],
    ['Editing', 'Mark extended', kb('mod+E'), () => tag('EXT')],
    ['Editing', 'Mark turn', '', () => tag('TURN')],
    ['Editing', 'Insert row below', '', () => A.sel && insertRow(A.sel.r + 1, A.sel.c, true)],
    ['Editing', 'Insert a heading', '', () => A.sel && insertHeading(A.sel.r)],
    ['Editing', 'Clear the selected cells', kb('back'), () => A.sel && clearCells(A.anchor ? rangeCells() : [A.sel])],
    ['Editing', 'Delete row', kb('mod+back'), () => A.sel && deleteRows(A.anchor ? rangeCells().map((x) => x.r) : [A.sel.r])],
    ['Editing', 'Delete cell, shift the column up', kb('shift+back'), () => A.sel && deleteCellUp(A.sel.r, A.sel.c)],
    ['Editing', 'Respond in the next column', kb('tab'), () => A.sel && setSel(A.sel.r, Math.min(LAST, A.sel.c + 1), true)],
    ['Round vision', 'Add this cell to round vision', kb('mod+B'), () => toggleStop()],
    ['Round vision', 'Speak through round vision', 'PgDn', () => speak(true)],
    ['Round vision', 'Next stop', kb('mod+]'), () => stepStop(1)],
    ['Round vision', 'Previous stop', kb('mod+['), () => stepStop(-1)],
    ['Round vision', 'Open the round vision list', '', () => toggleDrawer(true, 'vision')],
    ['Round vision', 'Clear round vision', '', () => { if (confirm('Clear every round vision stop?')) { S.vision = []; visionAt = -1; afterVision(); } }],
    ['Evidence', 'Find evidence that answers this', kb('mod+/'), () => answerFromEvidence()],
    ['Evidence', 'Search the library', '/', () => openPal('/')],
    ['Evidence', 'Open Evidence', '', () => window.open('/tools/evidence', 'break-evidence')],
    ['Flows', 'New Pro flow', '', () => addSheet('pro')],
    ['Flows', 'New Con flow', '', () => addSheet('con')],
    ['Flows', 'Rename this flow', 'F2', () => renameSheet()],
    ['Flows', 'Delete this flow', '', () => deleteSheet()],
    ['Flows', 'Copy this flow as text', '', () => copyText(false)],
    ['Flows', 'Copy every flow as text', '', () => copyText(true)],
    ['Clock', 'Start / pause the clock', kb('mod+.'), toggleTimer],
    ['Clock', 'Flip who speaks first', '', flipFirst],
    ...PREP_CHOICES.map((s) => ['Clock', `Prep time — ${clock(s)} each`, '', () => setPrep(s)]),
    ['View', 'Split screen', kb('mod+\\'), () => setSplit(split === 'side' ? null : 'side')],
    ['View', 'Stack screens', '', () => setSplit(split === 'stack' ? null : 'stack')],
    ['View', 'Switch screen', kb("mod+'"), swapScreens],
    ['View', 'Widen the column I am in', '', () => $('#v-focus').click()],
    ['View', 'Tighter rows', '', () => $('#v-compact').click()],
    ['View', 'Notes, cards and round vision', kb('mod+J'), () => toggleDrawer()],
    ['Together', 'Flow with your partner', '', openShare],
    ['Round', 'Start a new round', '', newRound],
  ];

  /** Places, built fresh each time: they change as the round does. */
  function places() {
    const out = [];
    S.vision.forEach((v, i) => out.push(['Round vision', `Go to · ${v.name}`, i < 9 ? kb('alt+' + (i + 1)) : '', () => goStop(i),
      (() => { const at = resolveStop(v); return at ? `${at.sheet.name} · ${COLS[v.col].key}` : 'not on the flow'; })()]));
    S.sheets.forEach((s, i) => out.push(['Flows', `Go to · ${s.name}`, '', () => {
      if (editing) commit(); A.cur = i; A.sel = firstSel(); A.anchor = null; render(); A.flow.scrollTo(0, 0);
    }, s.side]));
    SP.forEach((sp, i) => out.push(['Clock', `Clock to · ${sp.long}`, '', () => setSpeech(i, true), clock(sp.secs)]));
    COLS.forEach((col, i) => out.push(['Editing', `Write in · ${col.long}`, kb('mod+shift+' + (i + 1)), () => jumpCol(i), '']));
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

  const pal = { items: [], idx: 0, mode: 'cmd', target: null, source: '' };

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
  function closePal() { $('#scrim').hidden = true; pal.target = null; pal.source = ''; A.flow.focus({ preventScroll: true }); }

  async function listPal() {
    const raw = $('#pal-q').value;
    pal.mode = raw.startsWith('/') ? 'ev' : 'cmd';
    const q = raw.replace(/^\//, '').trim().toLowerCase().replace(/\s+/g, ' ');
    $('#pal').classList.toggle('ev', pal.mode === 'ev');
    $('#pal .glyph').textContent = pal.mode === 'ev' ? '/' : '›';
    $('#pal-src').hidden = !(pal.mode === 'ev' && pal.source);
    $('#pal-src').innerHTML = pal.source ? `Answering <b>${esc(pal.source)}</b>` : '';
    $('#pal-foot').innerHTML = pal.mode === 'ev'
      ? `<span><kbd>${kb('enter')}</kbd> flow it + send the block</span><span><kbd>${kb('shift+enter')}</kbd> flow only</span><span><kbd>${kb('esc')}</kbd> close</span>`
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

    const all = CMDS.map((c) => ({ group: c[0], label: c[1], key: c[2], run: c[3], sub: '' }))
      .concat(places().map((c) => ({ group: c[0], label: c[1], key: c[2], run: c[3], sub: c[4] || '' })));
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
      if (!typed && it.group !== lastGroup) { html += `<li class="grp">${esc(it.group)}</li>`; lastGroup = it.group; }
      html += `<li class="it${j === pal.idx ? ' on' : ''}" data-j="${j}" style="--i:${Math.min(j, 14)}">` +
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
    const target = pal.target;
    closePal();
    if (it.hit) flowIt(it.hit, !!withSend, target);
    else if (it.run) it.run();
  }
  function palKeys(e) {
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
  on($('#pal-q'), 'input', () => { pal.idx = 0; clearTimeout(palTimer); palTimer = setTimeout(listPal, $('#pal-q').value.startsWith('/') ? 90 : 0); });
  on($('#pal-list'), 'click', (e) => { const li = e.target.closest('.it'); if (li) runPal(+li.dataset.j, !e.shiftKey); });
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
    if (!confirm('Start a new round? This flow is cleared from this browser.')) return;
    const fresh = freshDoc();
    fresh.first = S.first; fresh.prep = S.prep;
    Object.assign(S, fresh);
    COLS = colsFor(S.first); SP = speechesFor(S.first);
    left = SP.map((s) => s.secs); ti = 0; run = false; tmode = 'sp';
    prep.pro = S.prep; prep.con = S.prep;
    UNDO.length = 0; REDO.length = 0;
    visionAt = -1; if (speaking) speak(false);
    PANES.forEach((p, i) => { p.cur = Math.min(i, S.sheets.length - 1); p.sel = null; p.anchor = null; });
    $('#notes').value = ''; render(); paintT(); paintVision(); save(); pushDoc(); pushVision();
    toast('New round');
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
  function pushDoc() { if (live && !applying) live.send('doc', { sheets: S.sheets, first: S.first, prep: S.prep }); }
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
        S.sheets = doc.sheets;
        if (doc.first && doc.first !== S.first) { S.first = doc.first; COLS = colsFor(S.first); SP = speechesFor(S.first); left = SP.map((s) => s.secs); }
        if (doc.prep) S.prep = doc.prep;
        if (type === 'full' && typeof doc.notes === 'string') { S.notes = doc.notes; $('#notes').value = doc.notes; }
        if (type === 'full' && Array.isArray(doc.vision)) { S.vision = doc.vision; visionAt = -1; paintVision(); }
        PANES.forEach((p) => { p.cur = Math.min(p.cur, S.sheets.length - 1); p.sel = null; p.anchor = null; });
        renderAll(); paintT(); save();
        if (type === 'full') toast('Flow received');
        return;
      }
      if (type === 'notes') { S.notes = d.t; $('#notes').value = d.t; save(); return; }
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
  function paintPeers(p = A) {
    p.grid.querySelectorAll('.pcaret').forEach((x) => x.remove());
    const sheet = sheetOf(p);
    peers.forEach((peer) => {
      if (!peer.caret || peer.caret.sheet !== sheet.id) return;
      const ri = rowIndex(sheet, peer.caret.row);
      if (ri < 0) return;
      const el = cellEl(ri, peer.caret.col, p);
      if (!el) return;
      const box = document.createElement('div');
      box.className = 'pcaret';
      box.style.setProperty('--hue', String(peer.hue));
      box.style.transform = `translate(${el.offsetLeft}px,${el.offsetTop}px)`;
      box.style.width = el.offsetWidth + 1 + 'px';
      box.style.height = el.offsetHeight + 1 + 'px';
      box.innerHTML = `<span>${esc(peer.name)}</span>`;
      p.grid.appendChild(box);
    });
  }

  function paintShare() {
    const on = !!live;
    $('#share-btn').classList.toggle('on', on);
    $('#share-btn').setAttribute('aria-pressed', String(on));
    $('#share-state').textContent = !on ? 'Not shared'
      : peers.length ? `${peers.length + 1} flowing` : 'Waiting for your partner';
    $('#share-dot').className = 'dot' + (on ? (peers.length ? ' live' : ' waiting') : '');
    $('#share-code').textContent = on ? live.code : '—';
    $('#share-leave').hidden = !on;
    $('#share-start').hidden = on;
    $('#share-join').hidden = on;
    $('#share-peers').innerHTML = peers.map((p) =>
      `<span class="peer" style="--hue:${p.hue}">${esc(p.name)}</span>`).join('') || '';
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
      snapshot: () => ({ sheets: S.sheets, first: S.first, prep: S.prep, notes: S.notes, vision: S.vision }),
    });
    paintShare();
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
    live = null; peers = [];
    visible().forEach(paintPeers); paintShare();
    toast('Flowing on your own again');
  });
  // The link, not the code: a partner without the admin key cannot reach a
  // page to type a code into, but a link carrying one opens the room directly.
  const joinLink = () => `${location.origin}/tools/flow?join=${live.code}`;
  on($('#share-copy'), 'click', async () => {
    if (!live) return;
    try { await navigator.clipboard.writeText(joinLink()); toast('Link copied — send it to your partner'); }
    catch { toast('The clipboard said no'); }
  });

  /* ================================================================
     Start
     ================================================================ */

  // Labels written into the page's markup, named for this computer.
  $$('[data-kb]').forEach((el) => { el.textContent = kb(el.dataset.kb); });
  PANES[1].root.hidden = true;
  paintActive();
  PANES.forEach((p) => { p.sel = firstSel(p); });
  render(); paintT(); paintVision(); paintInbox(); paintShare();
  if (A.sel) setSel(A.sel.r, A.sel.c, false);
  if (opts.join) { openShare(); $('#share-in').value = opts.join; }

  return () => {
    offs.forEach((f) => f());
    clearTimeout(saveTimer); clearTimeout(caretTimer); clearTimeout(notesTimer); clearTimeout(cardTimer);
    try { localStorage.setItem(scoped(STORE, OWNER), JSON.stringify(S)); } catch { /* private browsing */ }
    if (live) live.leave();
    document.body.classList.remove('flw-dragging');
  };
}
