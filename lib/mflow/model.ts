/**
 * Flow: coda's flower, for Public Forum. After ebb (ebb.smodi.net), in coda's
 * own look.
 *
 * A round is a stack of sheets, a sheet per contention, off-case argument or
 * frontline, the way a flow is paper. Every sheet has a column per speech in
 * the order they're given, and the cross-ex sheet is pinned first. A cell is a
 * line of flow: its words, and how it's marked (bold, highlighted, a card, a
 * group, kicked).
 *
 * Everything here is a pure function from a round to a new round, so undo is
 * just keeping the old one, and the same edits can be replayed for a partner.
 */

export type Side = "aff" | "neg";
export type SheetKind = Side | "cx";
/** Who speaks first: the aff (AC first) or the neg (NC first). */
export type Order = "aff" | "neg";

export interface Marks { b?: 1; h?: 1; c?: 1; g?: 1; k?: 1 }
export interface Cell extends Marks { t: string; /** a card it came from, in coda */ src?: string }

export interface Sheet {
  id: string;
  name: string;
  kind: SheetKind;
  /** cells by "col:row" */
  cells: Record<string, Cell>;
}

export interface Info {
  tournament: string; round: string; flight: string; date: string;
  aff: string; neg: string; judge: string;
  /** which side you're on, so what you send lands in your own speeches */
  us: Side | "";
}

export interface Round {
  id: string;
  format: "pf";
  order: Order;
  info: Info;
  sheets: Sheet[];
  rfd: string;
  created: number;
  updated: number;
}

export interface Speech { id: string; name: string; side: Side }

/** The speeches of a PF round, in the order they're given. */
export function speeches(order: Order): Speech[] {
  const a = (n: string): Speech => ({ id: n.toLowerCase(), name: n, side: "aff" });
  const n = (s: string): Speech => ({ id: s.toLowerCase(), name: s, side: "neg" });
  return order === "aff"
    ? [a("AC"), n("NC"), a("AR"), n("NR"), a("AS"), n("NS"), a("AF"), n("NF")]
    : [n("NC"), a("AC"), n("NR"), a("AR"), n("NS"), a("AS"), n("NF"), a("AF")];
}

/** The cross-ex sheet's columns. */
export const CX: { id: string; name: string }[] = [
  { id: "cx1", name: "First" }, { id: "cx2", name: "Second" }, { id: "gcx", name: "Grand" },
];

export const columnsOf = (r: Round, s: Sheet) => (s.kind === "cx" ? CX : speeches(r.order));

export const key = (col: number, row: number) => col + ":" + row;
export const uid = (p = "s") => p + Math.random().toString(36).slice(2, 10);

export function blankInfo(): Info {
  return { tournament: "", round: "", flight: "", date: new Date().toISOString().slice(0, 10), aff: "", neg: "", judge: "", us: "" };
}

export function newRound(order: Order): Round {
  const now = Date.now();
  return {
    id: uid("r"), format: "pf", order, info: blankInfo(), rfd: "", created: now, updated: now,
    sheets: [
      { id: uid(), name: "Cross-examination", kind: "cx", cells: {} },
      { id: uid(), name: "1.", kind: "aff", cells: {} },
      { id: uid(), name: "1.", kind: "neg", cells: {} },
    ],
  };
}

export function title(r: Round): string {
  const a = r.info.aff.trim() || "Aff", n = r.info.neg.trim() || "Neg";
  return `${a} vs ${n}`;
}

/* ------------------------------------------------------------ reading a sheet */

export const cellAt = (s: Sheet, col: number, row: number): Cell | undefined => s.cells[key(col, row)];
export const textAt = (s: Sheet, col: number, row: number) => s.cells[key(col, row)]?.t || "";

/** The last row anything is written in, or -1. */
export function lastRow(s: Sheet, col?: number): number {
  let m = -1;
  for (const k in s.cells) {
    const [c, r] = k.split(":").map(Number);
    if ((col === undefined || c === col) && s.cells[k].t.trim() && r > m) m = r;
  }
  return m;
}

/** Rows to draw: everything written, and room to keep going. */
export const rowsToShow = (s: Sheet) => Math.max(40, lastRow(s) + 24);

/* ------------------------------------------------------------ changing a round (each returns a new round) */

function withSheet(r: Round, id: string, f: (s: Sheet) => Sheet): Round {
  return { ...r, updated: Date.now(), sheets: r.sheets.map((s) => (s.id === id ? f(s) : s)) };
}

const tidy = (c: Cell | undefined): Cell | undefined => {
  if (!c) return undefined;
  const has = c.t !== "" || c.b || c.h || c.c || c.g || c.k;
  return has ? c : undefined;
};

/** Write a cell (its words and/or marks). */
export function setCell(r: Round, sheet: string, col: number, row: number, patch: Partial<Cell>): Round {
  return withSheet(r, sheet, (s) => {
    const k = key(col, row);
    const next = tidy({ ...{ t: "" }, ...s.cells[k], ...patch } as Cell);
    const cells = { ...s.cells };
    if (next) cells[k] = next; else delete cells[k];
    return { ...s, cells };
  });
}

/** Shift a column's cells from `row` down by `n` (n < 0: up, the cell at row dropped). */
function shiftCol(cells: Record<string, Cell>, col: number, row: number, n: number): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const k in cells) {
    const [c, rr] = k.split(":").map(Number);
    if (c !== col || rr < row) { out[k] = cells[k]; continue; }
    if (n < 0 && rr < row - n) continue;          // the ones being removed
    out[key(c, rr + n)] = cells[k];
  }
  return out;
}

/** A blank cell at (col,row), the column below pushed down. */
export const insertCell = (r: Round, sheet: string, col: number, row: number, n = 1) =>
  withSheet(r, sheet, (s) => ({ ...s, cells: shiftCol(s.cells, col, row, n) }));

/** The cell at (col,row) taken out, the column below pulled up. */
export const deleteCell = (r: Round, sheet: string, col: number, row: number, n = 1) =>
  withSheet(r, sheet, (s) => ({ ...s, cells: shiftCol(s.cells, col, row, -n) }));

/** A blank row across every column. */
export function insertRow(r: Round, sheet: string, row: number, n = 1): Round {
  return withSheet(r, sheet, (s) => {
    let cells = s.cells;
    for (let c = 0; c < columnsOf(r, s).length; c++) cells = shiftCol(cells, c, row, n);
    return { ...s, cells };
  });
}

/** A row taken out of every column. */
export function deleteRow(r: Round, sheet: string, row: number, n = 1): Round {
  return withSheet(r, sheet, (s) => {
    let cells = s.cells;
    for (let c = 0; c < columnsOf(r, s).length; c++) cells = shiftCol(cells, c, row, -n);
    return { ...s, cells };
  });
}

/** Marks turned on (or off) across a range: on if any cell in it lacks the mark. */
export function toggleMark(r: Round, sheet: string, cols: [number, number], rows: [number, number], m: keyof Marks): Round {
  const s = r.sheets.find((x) => x.id === sheet);
  if (!s) return r;
  let on = false;
  for (let c = cols[0]; c <= cols[1]; c++) for (let w = rows[0]; w <= rows[1]; w++) if (!cellAt(s, c, w)?.[m]) on = true;
  let out = r;
  for (let c = cols[0]; c <= cols[1]; c++) for (let w = rows[0]; w <= rows[1]; w++) out = setCell(out, sheet, c, w, { [m]: on ? 1 : undefined } as Partial<Cell>);
  return out;
}

/** Cells cleared across a range (words and marks). */
export function clearRange(r: Round, sheet: string, cols: [number, number], rows: [number, number]): Round {
  return withSheet(r, sheet, (s) => {
    const cells = { ...s.cells };
    for (let c = cols[0]; c <= cols[1]; c++) for (let w = rows[0]; w <= rows[1]; w++) delete cells[key(c, w)];
    return { ...s, cells };
  });
}

/**
 * The next argument number for a cell, counted from the nearest one above in the
 * same column: "AR #1 ", "AR #2 " … (a column with none starts at 1).
 */
export function nextMarker(r: Round, s: Sheet, col: number, row: number): string {
  const name = columnsOf(r, s)[col]?.name || "";
  let n = 0;
  for (let w = row - 1; w >= 0; w--) {
    const m = textAt(s, col, w).match(/#\s*(\d+)/);
    if (m) { n = Number(m[1]); break; }
  }
  return `${name} #${n + 1} `;
}

/** The next speech on the same side after `col` (AC → AR → AS → AF), or -1. */
export function nextSameSide(r: Round, s: Sheet, col: number): number {
  if (s.kind === "cx") return -1;
  const sp = speeches(r.order);
  for (let c = col + 1; c < sp.length; c++) if (sp[c].side === sp[col].side) return c;
  return -1;
}

/**
 * Extend: a run of cells in one column copied into the next speech of the same
 * side, at the same rows, each marked "→ ", the cells already there pushed down.
 */
export function extend(r: Round, sheet: string, col: number, rows: [number, number]): { round: Round; to: number } {
  const s = r.sheets.find((x) => x.id === sheet);
  if (!s) return { round: r, to: -1 };
  const to = nextSameSide(r, s, col);
  if (to < 0) return { round: r, to: -1 };
  const run: (Cell | undefined)[] = [];
  for (let w = rows[0]; w <= rows[1]; w++) run.push(cellAt(s, col, w));
  let out = insertCell(r, sheet, to, rows[0], run.length);
  run.forEach((c, i) => {
    if (!c || !c.t.trim()) return;
    out = setCell(out, sheet, to, rows[0] + i, { ...c, t: c.t.startsWith("→") ? c.t : "→ " + c.t });
  });
  return { round: out, to };
}

/**
 * Move: a block of cells (columns × rows) lifted out and put back `by` rows
 * down (or up), the cells around closing up and making room.
 */
export function moveBlock(r: Round, sheet: string, cols: [number, number], rows: [number, number], by: number): Round {
  if (!by) return r;
  const s = r.sheets.find((x) => x.id === sheet);
  if (!s) return r;
  const h = rows[1] - rows[0] + 1;
  let out = r;
  for (let c = cols[0]; c <= cols[1]; c++) {
    const lifted: (Cell | undefined)[] = [];
    for (let w = rows[0]; w <= rows[1]; w++) lifted.push(cellAt(s, c, w));
    out = deleteCell(out, sheet, c, rows[0], h);
    const at = Math.max(0, rows[0] + by);
    out = insertCell(out, sheet, c, at, h);
    lifted.forEach((cell, i) => { if (cell) out = setCell(out, sheet, c, at + i, cell); });
  }
  return out;
}

/* ------------------------------------------------------------ sheets */

export function addSheet(r: Round, kind: Side, name = ""): { round: Round; id: string } {
  const n = r.sheets.filter((s) => s.kind === kind).length + 1;
  const s: Sheet = { id: uid(), name: name || n + ".", kind, cells: {} };
  return { round: { ...r, updated: Date.now(), sheets: [...r.sheets, s] }, id: s.id };
}

export const renameSheet = (r: Round, id: string, name: string) => withSheet(r, id, (s) => ({ ...s, name }));

export function removeSheet(r: Round, id: string): Round {
  return { ...r, updated: Date.now(), sheets: r.sheets.filter((s) => s.id !== id || s.kind === "cx") };
}

/** A sheet moved up or down among the others (the cross-ex sheet stays first). */
export function moveSheet(r: Round, id: string, by: number): Round {
  const list = r.sheets.slice();
  const i = list.findIndex((s) => s.id === id);
  if (i < 0 || list[i].kind === "cx") return r;
  const j = Math.max(list[0]?.kind === "cx" ? 1 : 0, Math.min(list.length - 1, i + by));
  if (i === j) return r;
  const [s] = list.splice(i, 1);
  list.splice(j, 0, s);
  return { ...r, updated: Date.now(), sheets: list };
}

/** Speaking order swapped: every sheet's columns follow their speeches to their new places. */
export function swapOrder(r: Round): Round {
  const from = speeches(r.order), to = speeches(r.order === "aff" ? "neg" : "aff");
  const map = from.map((sp) => to.findIndex((x) => x.id === sp.id));
  return {
    ...r, order: r.order === "aff" ? "neg" : "aff", updated: Date.now(),
    sheets: r.sheets.map((s) => {
      if (s.kind === "cx") return s;
      const cells: Record<string, Cell> = {};
      for (const k in s.cells) { const [c, w] = k.split(":").map(Number); cells[key(map[c], w)] = s.cells[k]; }
      return { ...s, cells };
    }),
  };
}

/** Words written in a speech's column across the round (cross-ex left out). */
export function wordsIn(r: Round, col: number): number {
  let n = 0;
  for (const s of r.sheets) {
    if (s.kind === "cx") continue;
    for (const k in s.cells) if (Number(k.split(":")[0]) === col) n += (s.cells[k].t.match(/\S+/g) || []).length;
  }
  return n;
}

/**
 * Lines added to a speech's column on a sheet, under what's already there:
 * how coda puts what you send, or a speech doc, onto the flow.
 */
export function appendLines(r: Round, sheet: string, col: number, lines: { t: string; b?: boolean; src?: string }[]): Round {
  const s = r.sheets.find((x) => x.id === sheet);
  if (!s) return r;
  let row = lastRow(s, col) + 1;
  let out = r;
  for (const l of lines) {
    if (!l.t.trim()) continue;
    out = setCell(out, sheet, col, row++, { t: l.t.trim(), b: l.b ? 1 : undefined, src: l.src });
  }
  return out;
}

/** The sheet whose name best matches a block's title (an off-case or contention name), or null. */
export function sheetFor(r: Round, title: string, kind?: Side): Sheet | null {
  const norm = (x: string) => x.toLowerCase().replace(/^(at|a2|answers? to)\s*[:\-—]+\s*/i, "").replace(/[^a-z0-9]+/g, " ").trim();
  const want = norm(title);
  if (!want) return null;
  let best: Sheet | null = null, score = 0;
  for (const s of r.sheets) {
    if (s.kind === "cx" || (kind && s.kind !== kind)) continue;
    const have = norm(s.name);
    if (!have || /^\d+$/.test(have)) continue;
    const a = new Set(want.split(" ")), b = have.split(" ");
    const hits = b.filter((w) => a.has(w)).length;
    const sc = hits / Math.max(b.length, 1);
    if (sc > score) { score = sc; best = s; }
  }
  return score >= 0.5 ? best : null;
}
