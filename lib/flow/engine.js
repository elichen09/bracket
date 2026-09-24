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
 *  10  the drawer: notes, cards, roadmap
 *  11  the command palette
 *  12  flowing with your partner
 */

import { columns as colsFor, speeches as speechesFor, clock, PREP_DEFAULT, PREP_CHOICES } from './format';
import { joinFlow, newCode, tidyCode } from './share';
import { library, find } from './cards';

const STORE = 'flow.doc';
const NAME_KEY = 'flow.me';
const RM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const uid = (p) => p + Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);

/** The marks a flow is written in, which become chips as you type them. */
const TAGS = /\b(dropped|ext|turn|perm|nuq|xa|cx)\b/gi;

export function boot(root, opts = {}) {
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
  const mod = (e) => (isMac ? e.metaKey : e.ctrlKey);
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
    road: [],
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
      const raw = localStorage.getItem(STORE);
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
      d.road = d.road || [];
      d.notes = d.notes || '';
      return d;
    } catch { return null; }
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE, JSON.stringify(S)); } catch { /* private browsing */ }
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
  let fs = 13.5;

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
    let html = '<div class="h gh"></div>';
    COLS.forEach((col, i) => {
      html += `<div class="h ${col.side}" data-col="${i}" title="Jump to ${esc(col.long)}">` +
        `<b>${esc(col.key)}</b><span class="lv">live</span><span class="ct"></span></div>`;
    });
    let hi = 0;
    sheet.rows.forEach((row, ri) => {
      const b = born && born.includes(ri) ? ' born' : '';
      if (row.h !== undefined && !row.c) {
        hi++;
        html += `<div class="rh" data-r="${ri}"><span class="k">${String(hi).padStart(2, '0')}</span>` +
          `<span class="hn">${esc(row.h)}</span><em>${esc(row.t || '')}</em></div>`;
        return;
      }
      html += `<div class="r" data-r="${ri}"><div class="g${b}" data-r="${ri}">` +
        '<span class="grip" title="Drag to move this row">⣿</span>' +
        `<button type="button" class="del" data-r="${ri}" title="Delete row" aria-label="Delete row">×</button></div>` +
        row.c.map((t, ci) => `<div class="c ${COLS[ci].side}${b}" data-r="${ri}" data-c="${ci}">${fmt(t)}</div>`).join('') +
        '</div>';
    });
    html += '<div class="end"></div>';
    p.grid.innerHTML = html;

    p.select.innerHTML = S.sheets.map((s, i) => `<option value="${i}"${i === p.cur ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    p.root.querySelector('.pside').textContent = sheet.side;

    if (p.sel && !(sheet.rows[p.sel.r] && sheet.rows[p.sel.r].c)) {
      const r = nearestRow(p.sel.r, p);
      p.sel = r == null ? null : { r, c: p.sel.c };
    }
    if (!p.sel) p.sel = firstSel(p);
    marks(p); widths(p); paintRange(p); placeCursor(p, true); hideHx(p); paintPeers(p);
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
      `<button type="button" role="tab" data-i="${i}" aria-selected="${i === A.cur}">${esc(s.name)}<i>${s.side}</i></button>`).join('') +
      '<button type="button" class="plus" data-add="pro">+ Pro</button><button type="button" class="plus" data-add="con">+ Con</button>';
    $('#crumb').textContent = sheetOf().name + (split ? ' · screen ' + (A.i ? 'B' : 'A') : '');
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
    p.lab.textContent = COLS[p.sel.c].key + (ed ? ' · writing' : p.anchor ? ` · ${rangeCells(p).length} cells` : '');
    if (instant) { p.cursor.getBoundingClientRect(); p.cursor.style.transition = ''; }
    if (p === A) pushCaret();
  }
  function follow(p, ms) {
    if (RM) return placeCursor(p, true);
    const t0 = performance.now();
    (function f() { placeCursor(p, true); if (performance.now() - t0 < ms) requestAnimationFrame(f); })();
  }
  PANES.forEach((p) => {
    const ro = new ResizeObserver(() => placeCursor(p, true));
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
  function insertHeading(at) {
    const name = prompt('Heading for this part of the flow', 'C1');
    if (name === null) return;
    snap();
    rows().splice(at, 0, { id: uid('r'), h: name || 'Untitled', t: '' });
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
      toast(all ? 'Every sheet copied' : 'Sheet copied');
    } catch { toast('The clipboard said no', true); }
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
    const K = isMac ? '⌘' : 'Ctrl+';
    const many = A.anchor ? rangeCells() : null;
    const items = [
      ['Write in this cell', '↵', () => startEdit()],
      ['Insert row above', '', () => insertRow(r, c, true)],
      ['Insert row below', '', () => insertRow(r + 1, c, true)],
      ['Insert heading above', '', () => insertHeading(r)],
      ['Move row up', '⌥↑', () => moveRow(r, -1)], ['Move row down', '⌥↓', () => moveRow(r, 1)],
      ['Move cell left', '⌥←', () => moveCell(r, c, -1)], ['Move cell right', '⌥→', () => moveCell(r, c, 1)], '-',
      ['Mark dropped', K + 'D', () => tag('DROPPED')],
      ['Mark extended', K + 'E', () => tag('EXT')],
      ['Mark turn', '', () => tag('TURN')],
      ['Add to roadmap', '', () => addStop()],
      [split ? 'Open this sheet on the other screen' : 'Open in split screen', K + '\\', () => openBeside(A.cur)], '-',
      [many ? `Clear ${many.length} cells` : 'Clear cell', '⌫', () => clearCells(many || [{ r, c }]), 'danger'],
      ['Delete cell, shift column up', '⇧⌫', () => deleteCellUp(r, c), 'danger'],
      [many ? 'Delete these rows' : 'Delete row', K + '⌫', () => deleteRows(many ? many.map((x) => x.r) : [r]), 'danger'],
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

  on(document, 'keydown', (e) => {
    if (!root.isConnected) return;
    const inField = e.target.matches && e.target.matches('input,textarea,select');
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
    if (mod(e) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPal(); return; }
    if (mod(e) && e.key.toLowerCase() === 'j') { e.preventDefault(); toggleDrawer(); return; }
    if (mod(e) && e.key === '.') { e.preventDefault(); toggleTimer(); return; }
    if (mod(e) && e.key === '\\') { e.preventDefault(); setSplit(split ? null : 'side'); return; }
    if (mod(e) && e.key === "'") { e.preventDefault(); swapScreens(); return; }
    if (mod(e) && /^[1-8]$/.test(e.key)) { e.preventDefault(); jumpCol(+e.key - 1); return; }
    if (!$('#scrim').hidden) { palKeys(e); return; }
    if (inField) return;
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
      if (mod(e) && (e.key === 'd' || e.key === 'e')) { e.preventDefault(); tag(e.key === 'd' ? 'DROPPED' : 'EXT'); return; }
      if (mod(e) && e.key === 'Backspace') { e.preventDefault(); commit(); deleteRows([r]); return; }
      return;
    }

    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveRow(r, e.key === 'ArrowUp' ? -1 : 1); return; }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); moveCell(r, c, e.key === 'ArrowLeft' ? -1 : 1); return; }
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
    if (mod(e) && (e.key === 'd' || e.key === 'e')) { e.preventDefault(); tag(e.key === 'd' ? 'DROPPED' : 'EXT'); return; }
    if (e.key.length === 1 && !mod(e) && !e.altKey) { e.preventDefault(); startEdit(rows()[r].c[c] ? ' ' + e.key : e.key); return; }
  });

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

  on(root, 'click', (e) => {
    const t = e.target.closest('#tabs button[data-i]');
    if (t) {
      if (editing) commit();
      A.cur = +t.dataset.i; A.sel = firstSel(); A.anchor = null;
      render(); A.flow.scrollTo(0, 0);
      return;
    }
    const add = e.target.closest('[data-add]');
    if (add) addSheet(add.dataset.add);
  });
  function addSheet(side) {
    if (editing) commit();
    const n = S.sheets.filter((s) => s.side === side).length + 1;
    snap();
    S.sheets.push({ id: uid('s'), name: (side === 'pro' ? 'Pro ' : 'Con ') + n, side, rows: blankRows(5) });
    A.cur = S.sheets.length - 1; A.sel = firstSel();
    render([0, 1, 2]); setSel(A.sel.r, A.sel.c, false);
    save(); pushDoc();
    toast('New ' + side + ' sheet');
  }
  function renameSheet() {
    const sheet = sheetOf();
    const name = prompt('Name this sheet', sheet.name);
    if (name === null) return;
    snap();
    sheet.name = name.trim() || sheet.name;
    render(); save(); pushDoc();
  }
  function renameHeading(r) {
    const row = rows()[r];
    if (!row || row.c) return;
    const h = prompt('Heading', row.h);
    if (h === null) return;
    snap();
    row.h = h.trim() || row.h;
    render(); save(); pushRows(sheetOf());
  }
  function deleteSheet() {
    if (S.sheets.length < 2) return toast('The last sheet stays', true);
    const sheet = sheetOf();
    if (!confirm(`Delete the sheet “${sheet.name}” and everything on it?`)) return;
    snap();
    S.sheets.splice(A.cur, 1);
    PANES.forEach((p) => { p.cur = Math.min(p.cur, S.sheets.length - 1); p.sel = null; });
    render(); save(); pushDoc();
    toast('Sheet deleted', true);
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
     10. The drawer
     ================================================================ */

  function toggleDrawer(force) {
    const d = $('#drawer');
    const wanted = force != null ? force : !d.classList.contains('open');
    d.classList.toggle('open', wanted);
    $('#drawer-btn').setAttribute('aria-pressed', String(wanted));
    if (wanted) $('#notes').focus({ preventScroll: true });
  }
  on($('#drawer-btn'), 'click', () => toggleDrawer());
  on($('#drawer-x'), 'click', () => toggleDrawer(false));
  $$('.dtabs button[data-p]').forEach((b) => on(b, 'click', () => {
    $$('.dtabs button[data-p]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    ['notes', 'cards', 'road'].forEach((p) => { $('#p-' + p).hidden = b.dataset.p !== p; });
    if (b.dataset.p === 'cards') $('#q').focus({ preventScroll: true });
  }));

  $('#notes').value = S.notes || '';
  on($('#notes'), 'input', () => {
    S.notes = $('#notes').value;
    save();
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => pushNotes(), 400);
  });
  let notesTimer = null;

  /* cards, read out of the Evidence library */
  let INDEX = null;
  async function runCards() {
    const q = $('#q').value.trim();
    const box = $('#cardlist');
    if (INDEX === null) { box.innerHTML = '<p class="small">Looking…</p>'; INDEX = await library(); }
    if (!INDEX.length) {
      box.innerHTML = '<p class="small">No library in this browser yet. Import a cut file in <b>Evidence</b> and it shows up here.</p>';
      return;
    }
    if (!q) { box.innerHTML = `<p class="small">${INDEX.length} blocks in the library. Type to search.</p>`; return; }
    const hits = find(INDEX, q);
    if (!hits.length) { box.innerHTML = '<p class="small">Nothing matches.</p>'; return; }
    box.innerHTML = hits.map((h, i) =>
      `<article class="card"><span class="ctag">${esc(h.title)}</span>` +
      `<span class="cite">/${esc(h.trigger)}${h.path ? ' · ' + esc(h.path) : ''}</span>` +
      `<button class="ins" type="button" data-i="${i}">Put in the flow</button></article>`).join('');
    box._hits = hits;
  }
  on($('#q'), 'input', () => { clearTimeout(cardTimer); cardTimer = setTimeout(runCards, 160); });
  let cardTimer = null;
  on($('#cardlist'), 'click', (e) => {
    const b = e.target.closest('.ins');
    if (!b || !A.sel) return;
    const hit = ($('#cardlist')._hits || [])[+b.dataset.i];
    if (!hit) return;
    if (editing) commit();
    snap();
    const row = rows()[A.sel.r];
    row.c[A.sel.c] = (row.c[A.sel.c] ? row.c[A.sel.c] + '\n' : '') + hit.text;
    const el = cellEl(A.sel.r, A.sel.c);
    el.innerHTML = fmt(row.c[A.sel.c]);
    flash(el); marks(); placeCursor(A, true); syncOthers(); save();
    pushCell(sheetOf().id, row.id, A.sel.c, row.c[A.sel.c]);
    toast('Into ' + COLS[A.sel.c].key, true);
  });

  /* the roadmap */
  function paintRoad() {
    $('#road').innerHTML = S.road.map((s, i) =>
      `<li><span class="n">${String(i + 1).padStart(2, '0')}</span><span>${esc(s)}</span>` +
      `<button type="button" class="x" data-i="${i}" aria-label="Remove">×</button></li>`).join('') ||
      '<li class="none"><span class="small">Nothing yet. Add the cells you mean to go for.</span></li>';
  }
  on($('#road'), 'click', (e) => {
    const b = e.target.closest('.x');
    if (!b) return;
    S.road.splice(+b.dataset.i, 1);
    paintRoad(); save();
  });
  function addStop() {
    if (!A.sel) return;
    const row = rows()[A.sel.r];
    const t = (row.c && (row.c[A.sel.c] || row.c.find(Boolean))) || '';
    S.road.push(sheetOf().name + ' — ' + (t.replace(/^→\s*/, '').slice(0, 40) || 'row ' + (A.sel.r + 1)));
    paintRoad(); save();
    toast('Added to the roadmap');
  }
  on($('#road-add'), 'click', addStop);

  /* ================================================================
     11. View controls and the palette
     ================================================================ */

  on($('#v-focus'), 'click', function () { focusOn = !focusOn; this.setAttribute('aria-pressed', String(focusOn)); visible().forEach((p) => widths(p)); });
  on($('#v-compact'), 'click', function () {
    const nowOn = root.classList.toggle('compact');
    this.setAttribute('aria-pressed', String(nowOn));
    fs = nowOn ? 12.5 : 13.5;
    root.style.removeProperty('--flw-fs');
    visible().forEach((p) => placeCursor(p, true));
  });
  on($('#v-minus'), 'click', () => { fs = Math.max(11, fs - 0.5); root.style.setProperty('--flw-fs', fs + 'px'); visible().forEach((p) => placeCursor(p, true)); });
  on($('#v-plus'), 'click', () => { fs = Math.min(18, fs + 0.5); root.style.setProperty('--flw-fs', fs + 'px'); visible().forEach((p) => placeCursor(p, true)); });
  on($('#v-split'), 'click', () => setSplit(split === 'side' ? null : 'side'));
  on($('#v-stack'), 'click', () => setSplit(split === 'stack' ? null : 'stack'));
  on(window, 'resize', () => visible().forEach((p) => placeCursor(p, true)));

  const K = isMac ? '⌘' : 'Ctrl ';
  const CMDS = [
    ['Split screen — two flows side by side', K + '\\', () => setSplit(split === 'side' ? null : 'side')],
    ['Stack screens — one above the other', '', () => setSplit(split === 'stack' ? null : 'stack')],
    ['Switch screen', K + "'", swapScreens],
    ['Jump to a speech column', K + '1–8', () => {}],
    ['Respond in the next column', '⇥', () => {}],
    ['Next line, same column', '↵', () => {}],
    ['Line break inside a cell', '⇧↵', () => {}],
    ['Undo', K + 'Z', undo],
    ['Redo', K + '⇧Z', redo],
    ['Mark dropped', K + 'D', () => tag('DROPPED')],
    ['Mark extended', K + 'E', () => tag('EXT')],
    ['Mark turn', '', () => tag('TURN')],
    ['Insert row below', '', () => A.sel && insertRow(A.sel.r + 1, A.sel.c, true)],
    ['Insert a heading', '', () => A.sel && insertHeading(A.sel.r)],
    ['Clear the selected cells', '⌫', () => A.sel && clearCells(A.anchor ? rangeCells() : [A.sel])],
    ['Delete row', K + '⌫', () => A.sel && deleteRows(A.anchor ? rangeCells().map((x) => x.r) : [A.sel.r])],
    ['Delete cell, shift the column up', '⇧⌫', () => A.sel && deleteCellUp(A.sel.r, A.sel.c)],
    ['New Pro sheet', '', () => addSheet('pro')],
    ['New Con sheet', '', () => addSheet('con')],
    ['Rename this sheet', '', renameSheet],
    ['Delete this sheet', '', deleteSheet],
    ['Copy this sheet as text', '', () => copyText(false)],
    ['Copy every sheet as text', '', () => copyText(true)],
    ['Start / pause the clock', K + '.', toggleTimer],
    ['Flip who speaks first', '', flipFirst],
    ...PREP_CHOICES.map((s) => [`Prep time — ${clock(s)} each`, '', () => setPrep(s)]),
    ['Notes, cards and roadmap', K + 'J', () => toggleDrawer()],
    ['Flow with your partner', '', openShare],
    ['Widen the column I am in', '', () => $('#v-focus').click()],
    ['Tighter rows', '', () => $('#v-compact').click()],
    ['Start a new round', '', newRound],
  ];
  let palIdx = 0, palItems = [];
  function openPal() {
    if (editing) commit();
    $('#scrim').hidden = false;
    $('#pal-q').value = ''; palIdx = 0; listPal();
    $('#pal-q').focus();
  }
  function closePal() { $('#scrim').hidden = true; A.flow.focus({ preventScroll: true }); }
  function listPal() {
    const q = $('#pal-q').value.toLowerCase();
    palItems = CMDS.map((c, i) => i).filter((i) => CMDS[i][0].toLowerCase().includes(q));
    palIdx = Math.min(palIdx, Math.max(0, palItems.length - 1));
    $('#pal-list').innerHTML = palItems.map((i, j) =>
      `<li data-i="${i}" class="${j === palIdx ? 'on' : ''}"><span>${esc(CMDS[i][0])}</span>${CMDS[i][1] ? `<kbd>${esc(CMDS[i][1])}</kbd>` : ''}</li>`).join('');
  }
  function palKeys(e) {
    if (e.key === 'Escape') { e.preventDefault(); closePal(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      palIdx = (palIdx + (e.key === 'ArrowDown' ? 1 : -1) + palItems.length) % palItems.length;
      listPal();
    }
    if (e.key === 'Enter') { e.preventDefault(); const i = palItems[palIdx]; closePal(); if (i != null) CMDS[i][2](); }
  }
  on($('#pal-q'), 'input', () => { palIdx = 0; listPal(); });
  on($('#pal-list'), 'click', (e) => { const li = e.target.closest('li'); if (!li) return; closePal(); CMDS[+li.dataset.i][2](); });
  on($('#scrim'), 'click', (e) => { if (e.target.id === 'scrim') closePal(); });

  function newRound() {
    if (!confirm('Start a new round? This flow is cleared from this browser.')) return;
    const fresh = freshDoc();
    fresh.first = S.first; fresh.prep = S.prep;
    Object.assign(S, fresh);
    COLS = colsFor(S.first); SP = speechesFor(S.first);
    left = SP.map((s) => s.secs); ti = 0; run = false; tmode = 'sp';
    prep.pro = S.prep; prep.con = S.prep;
    UNDO.length = 0; REDO.length = 0;
    PANES.forEach((p, i) => { p.cur = Math.min(i, S.sheets.length - 1); p.sel = null; p.anchor = null; });
    $('#notes').value = ''; paintRoad(); render(); paintT(); save(); pushDoc();
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
    try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
  };

  function pushCell(sheetId, rowId, col, text) { if (live && !applying) live.send('cell', { s: sheetId, r: rowId, c: col, t: text }); }
  function pushRows(sheet) { if (live && !applying) live.send('rows', { s: sheet.id, rows: sheet.rows }); }
  function pushDoc() { if (live && !applying) live.send('doc', { sheets: S.sheets, first: S.first, prep: S.prep }); }
  function pushNotes() { if (live && !applying) live.send('notes', { t: S.notes }); }
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
        if (type === 'full' && Array.isArray(doc.road)) { S.road = doc.road; paintRoad(); }
        PANES.forEach((p) => { p.cur = Math.min(p.cur, S.sheets.length - 1); p.sel = null; p.anchor = null; });
        renderAll(); paintT(); save();
        if (type === 'full') toast('Flow received');
        return;
      }
      if (type === 'notes') { S.notes = d.t; $('#notes').value = d.t; save(); return; }
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
    try { localStorage.setItem(NAME_KEY, name); } catch { /* private browsing */ }
    if (live) live.leave();
    live = joinFlow(code, name, {
      onEvent: applyEvent,
      onPeers: (list) => { peers = list; visible().forEach(paintPeers); paintShare(); },
      onStatus: (status, detail) => {
        if (status === 'error') { toast('Could not share: ' + (detail || 'no connection'), true); }
        paintShare();
      },
      snapshot: () => ({ sheets: S.sheets, first: S.first, prep: S.prep, notes: S.notes, road: S.road }),
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
    if (code.length < 4) return toast('That is not a code', true);
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
    catch { toast('The clipboard said no', true); }
  });

  /* ================================================================
     Start
     ================================================================ */

  PANES[1].root.hidden = true;
  paintActive();
  PANES.forEach((p) => { p.sel = firstSel(p); });
  render(); paintT(); paintRoad(); paintShare();
  if (A.sel) setSel(A.sel.r, A.sel.c, false);
  if (opts.join) { openShare(); $('#share-in').value = opts.join; }

  return () => {
    offs.forEach((f) => f());
    clearTimeout(saveTimer); clearTimeout(caretTimer); clearTimeout(notesTimer); clearTimeout(cardTimer);
    try { localStorage.setItem(STORE, JSON.stringify(S)); } catch { /* private browsing */ }
    if (live) live.leave();
    document.body.classList.remove('flw-dragging');
  };
}
