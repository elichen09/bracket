"use client";
/**
 * Flow — coda's flower for Public Forum, a mode beside Edit, Split and Speech.
 * After ebb (ebb.smodi.net): sheets of columns, one per speech, flowed from the
 * keyboard; in coda's look, and wired to coda — what you send can land on the
 * flow, a speech doc or their doc can be flowed in one go, and any cell can be
 * answered from your library.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { comboOf, keyLabel } from "@/lib/cutter/keys";
import {
  newRound, title, columnsOf, speeches, cellAt, textAt, lastRow, rowsToShow, setCell, insertCell, deleteCell, insertRow, deleteRow,
  toggleMark, clearRange, nextMarker, extend, moveBlock, addSheet, renameSheet, removeSheet, moveSheet, swapOrder, wordsIn,
  appendLines, sheetFor, key as cellKey, type Round, type Sheet, type Cell, type Marks, type Side, type Order,
} from "@/lib/mflow/model";
import { listRounds, getRound, putRound, dropRound, type RoundRow } from "@/lib/mflow/store";
import { roundXlsx } from "@/lib/mflow/xlsx";
import { FLOW_KEYS } from "@/lib/mflow/keys";
import { diff, patch as patchRound, type Patch } from "@/lib/mflow/sync";
import { joinFlow, newCode, tidyCode, type Session, type Peer, type Status } from "@/lib/flow/share";
import "./mflow.css";

export interface Outline { block: string; tags: string[] }
interface Props {
  owner: string | null;
  shown: boolean;
  wpm: number;
  toast: (m: string) => void;
  /** the speech doc, as blocks and their tags */
  speechOutline: () => Outline[];
  /** the file open now, as blocks and their tags (their doc, when it's theirs) */
  fileOutline: () => { name: string; theirs: boolean; blocks: Outline[] } | null;
  /** a claim, searched for in your library's Answer mode */
  answer: (text: string) => void;
  /** your name, for your partner's flow */
  who: string;
}

type Pos = { c: number; r: number };
const ZOOM_KEY = "coda.flow.zoom";
const UNDO_MAX = 200;

const I = {
  back: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>,
  plus: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  x: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  side: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" /><path d="M9 4v16" /></svg>,
  down: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>,
};

export default function MagicFlow({ owner, shown, wpm, toast, speechOutline, fileOutline, answer, who }: Props) {
  const [rows, setRows] = useState<RoundRow[]>([]);
  const [round, setRound] = useState<Round | null>(null);
  const roundRef = useRef<Round | null>(null);
  roundRef.current = round;
  const [sheetId, setSheetId] = useState("");
  const [sel, setSel] = useState<Pos>({ c: 0, r: 0 });
  const [anchor, setAnchor] = useState<Pos>({ c: 0, r: 0 });
  const [editing, setEditing] = useState<null | { text: string }>(null);
  /** cells on the move (Alt+M, or dragged): how far down and across they'll land */
  const [moving, setMoving] = useState<null | { by: number; byCol: number; drag?: Pos }>(null);
  const [zoom, setZoomState] = useState(1);
  const [sideOpen, setSideOpen] = useState(true);
  const [panel, setPanel] = useState<null | "info" | "help" | "from">(null);
  const [rfd, setRfd] = useState<null | "edit" | "preview">(null);
  const [decision, setDecision] = useState(false);
  const [find, setFind] = useState<null | { q: string; at: number }>(null);
  const [sendTo, setSendTo] = useState(-1);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragSheet, setDragSheet] = useState<string | null>(null);
  const past = useRef<Round[]>([]), future = useRef<Round[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  const edRef = useRef<HTMLTextAreaElement>(null);
  const dragSel = useRef(false);
  const clip = useRef<{ text: string; cells: (Cell | undefined)[][] } | null>(null);

  /* ---- flowing with your partner: a code read out, the same round in both */
  const sess = useRef<Session | null>(null);
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<Status | "">("");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [joinAsk, setJoinAsk] = useState(false);
  const synced = useRef<Round | null>(null);      // the round as your partner last had it
  const leave = () => { sess.current?.leave(); sess.current = null; setCode(""); setStatus(""); setPeers([]); synced.current = null; };
  useEffect(() => () => { sess.current?.leave(); }, []);
  const connect = (c: string) => {
    leave();
    const s = joinFlow(c, who || "Partner", {
      onStatus: (st, detail) => { setStatus(st); if (st === "error") toast("Couldn't reach the room" + (detail ? ": " + detail : "")); },
      onPeers: (p) => setPeers(p.filter((x) => x.kind === "flow")),
      snapshot: () => roundRef.current,
      onEvent: (type, data) => {
        if (type === "full" && data?.doc) {
          const r = data.doc as Round;
          synced.current = r;
          if (!roundRef.current || roundRef.current.id !== r.id) { putRound(owner, r); open(r); }
          else { roundRef.current = r; setRound(r); }
          toast("You're flowing " + title(r) + " together");
          return;
        }
        if (type === "patch" && data && roundRef.current) {
          const next = patchRound(roundRef.current, data as Patch);
          synced.current = next; roundRef.current = next; setRound(next);
        }
      },
    }, "flow");
    sess.current = s; setCode(c);
  };
  const invite = () => { if (!roundRef.current) return; connect(newCode(5)); synced.current = roundRef.current; };
  const joinCode = (raw: string) => { const c = tidyCode(raw); if (c.length < 4) { toast("That code is too short"); return; } setJoinAsk(false); connect(c); };
  // your changes, to your partner: what's different from what they last had
  const sendT = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!sess.current || !round || status === "error") return;
    if (sendT.current) clearTimeout(sendT.current);
    sendT.current = setTimeout(() => {
      const r = roundRef.current;
      if (!sess.current || !r) return;
      const p = diff(synced.current, r);
      if (p) { sess.current.send("patch", p); synced.current = r; }
    }, 120);
  }, [round, status]);

  // the rounds you have, and how big you like the flow
  useEffect(() => { setRows(listRounds(owner)); }, [owner]);
  useEffect(() => { try { const z = Number(localStorage.getItem(ZOOM_KEY)); if (z >= 0.5 && z <= 3) setZoomState(z); } catch { /* the default */ } }, []);
  const setZoom = (z: number) => { const v = Math.max(0.5, Math.min(3, Math.round(z * 20) / 20)); setZoomState(v); try { localStorage.setItem(ZOOM_KEY, String(v)); } catch { /* not kept */ } };

  // every change kept, a beat after it's made
  const saveT = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!round) return;
    if (saveT.current) clearTimeout(saveT.current);
    saveT.current = setTimeout(() => { putRound(owner, round); setRows(listRounds(owner)); }, 300);
  }, [round, owner]);

  const sheet: Sheet | null = useMemo(() => round?.sheets.find((s) => s.id === sheetId) || round?.sheets[0] || null, [round, sheetId]);
  const cols = round && sheet ? columnsOf(round, sheet) : [];
  const sps = round ? speeches(round.order) : [];
  const nRows = sheet ? rowsToShow(sheet) : 0;

  /** A change to the round, undoable. */
  const apply = useCallback((f: (r: Round) => Round) => {
    const r = roundRef.current;
    if (!r) return;
    const next = f(r);
    if (next === r) return;
    past.current.push(r);
    if (past.current.length > UNDO_MAX) past.current.shift();
    future.current = [];
    roundRef.current = next;
    setRound(next);
  }, []);

  const open = (r: Round) => {
    past.current = []; future.current = [];
    setRound(r); roundRef.current = r;
    setSheetId(r.sheets.find((s) => s.kind !== "cx")?.id || r.sheets[0].id);
    setSel({ c: 0, r: 0 }); setAnchor({ c: 0, r: 0 }); setEditing(null); setMoving(null); setRfd(null); setDecision(false);
    setSendTo(-1);
    requestAnimationFrame(() => gridRef.current?.focus());
  };
  const start = (order: Order) => { const r = newRound(order); putRound(owner, r); setRows(listRounds(owner)); open(r); setPanel("info"); };
  const close = () => { if (round) putRound(owner, round); setRound(null); setRows(listRounds(owner)); };

  /* ------------------------------------------------------------ selection */

  const rect = () => ({ c0: Math.min(sel.c, anchor.c), c1: Math.max(sel.c, anchor.c), r0: Math.min(sel.r, anchor.r), r1: Math.max(sel.r, anchor.r) });
  const go = (p: Pos, extendSel = false) => {
    const c = Math.max(0, Math.min(cols.length - 1, p.c)), r = Math.max(0, p.r);
    setSel({ c, r });
    if (!extendSel) setAnchor({ c, r });
    // the cell kept in view
    requestAnimationFrame(() => gridRef.current?.querySelector(`[data-cell="${c}:${r}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  };
  useEffect(() => {
    if (sess.current && sheet) sess.current.send("caret", { sheet: sheet.id, row: String(sel.r), col: sel.c });
  }, [sel.c, sel.r, sheet?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // what you send follows you into your own speeches
  useEffect(() => {
    if (!round || sendTo < 0 || !sheet || sheet.kind === "cx" || !round.info.us) return;
    if (sps[sel.c]?.side === round.info.us && sel.c !== sendTo) setSendTo(sel.c);
  }, [sel.c]); // eslint-disable-line react-hooks/exhaustive-deps

  const toSheet = (id: string) => {
    if (editing) commitEdit();
    setSheetId(id); setSel((p) => ({ c: Math.min(p.c, (round && round.sheets.find((s) => s.id === id)?.kind === "cx") ? 2 : 7), r: 0 })); setAnchor({ c: 0, r: 0 });
    requestAnimationFrame(() => gridRef.current?.focus());
  };

  /* ------------------------------------------------------------ editing a cell */

  const beginEdit = (text?: string) => {
    if (!sheet) return;
    setEditing({ text: text ?? textAt(sheet, sel.c, sel.r) });
    requestAnimationFrame(() => {
      const t = edRef.current;
      if (!t) return;
      t.focus(); t.setSelectionRange(t.value.length, t.value.length);
      t.style.height = "auto"; t.style.height = t.scrollHeight + "px";
    });
  };
  const commitEdit = () => {
    if (!editing || !sheet) return;
    const text = editing.text.replace(/\s+$/, "");
    if (text !== textAt(sheet, sel.c, sel.r)) apply((r) => setCell(r, sheet.id, sel.c, sel.r, { t: text }));
    setEditing(null);
  };
  const doneEdit = (then?: () => void) => { commitEdit(); then?.(); requestAnimationFrame(() => gridRef.current?.focus()); };

  /* ------------------------------------------------------------ actions */

  const mark = (m: keyof Marks) => { if (!sheet) return; const q = rect(); if (editing) commitEdit(); apply((r) => toggleMark(r, sheet.id, [q.c0, q.c1], [q.r0, q.r1], m)); };
  const undo = () => { const p = past.current.pop(); if (!p || !roundRef.current) return; future.current.push(roundRef.current); roundRef.current = p; setRound(p); };
  const redo = () => { const n = future.current.pop(); if (!n || !roundRef.current) return; past.current.push(roundRef.current); roundRef.current = n; setRound(n); };
  const newSheet = (kind: Side) => { let id = ""; apply((r) => { const o = addSheet(r, kind); id = o.id; return o.round; }); requestAnimationFrame(() => { setSheetId(id); setRenaming(id); }); };
  const jumpFilled = (dir: 1 | -1) => {
    if (!sheet) return;
    const filled = (w: number) => !!textAt(sheet, sel.c, w).trim();
    let w = sel.r + dir;
    // from a written cell, to the end of its run; from a blank one, to the next written one
    if (filled(sel.r) && filled(w)) { while (w + dir >= 0 && filled(w + dir)) w += dir; }
    else { while (w >= 0 && w < nRows && !filled(w)) w += dir; if (w < 0) w = 0; if (w >= nRows) w = lastRow(sheet, sel.c) + 1; }
    go({ c: sel.c, r: Math.max(0, w) });
  };
  const doExtend = () => {
    if (!sheet || sheet.kind === "cx") return;
    const q = rect();
    let to = -1;
    apply((r) => { const o = extend(r, sheet.id, q.c0, [q.r0, q.r1]); to = o.to; return o.round; });
    if (to < 0) toast("Nothing later for this side to extend into");
    else requestAnimationFrame(() => go({ c: to, r: q.r0 }));
  };
  const copy = (cut: boolean) => {
    if (!sheet) return "";
    const q = rect();
    const cells: (Cell | undefined)[][] = [];
    for (let w = q.r0; w <= q.r1; w++) { const row: (Cell | undefined)[] = []; for (let c = q.c0; c <= q.c1; c++) row.push(cellAt(sheet, c, w)); cells.push(row); }
    const text = cells.map((row) => row.map((c) => (c?.t || "").replace(/\t|\n/g, " ")).join("\t")).join("\n");
    clip.current = { text, cells };
    if (cut) apply((r) => clearRange(r, sheet.id, [q.c0, q.c1], [q.r0, q.r1]));
    return text;
  };
  const paste = (text: string) => {
    if (!sheet) return;
    const mine = clip.current && clip.current.text === text ? clip.current.cells : null;
    const grid = mine || text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((line) => line.split("\t").map((t) => ({ t } as Cell)));
    apply((r) => {
      let out = r;
      grid.forEach((row, i) => row.forEach((c, j) => {
        const col = sel.c + j;
        if (col < cols.length) out = setCell(out, sheet.id, col, sel.r + i, c ? { t: c.t, b: c.b, h: c.h, c: c.c, g: c.g, k: c.k } : { t: "" });
      }));
      return out;
    });
  };

  /* ------------------------------------------------------------ coda → flow */

  /** Lines into a speech's column, on the sheet whose name matches each block (made if none does). */
  const flowIn = (blocks: Outline[], col: number, side: Side) => {
    if (!blocks.length) { toast("Nothing to flow there yet"); return; }
    let n = 0;
    apply((r) => {
      let out = r;
      for (const b of blocks) {
        let s = sheetFor(out, b.block) || null;
        if (!s) { const o = addSheet(out, side, b.block.slice(0, 40)); out = o.round; s = out.sheets.find((x) => x.id === o.id)!; }
        out = appendLines(out, s.id, col, b.tags.map((t) => ({ t, src: b.block })));
        n += b.tags.length;
      }
      return out;
    });
    toast(`Flowed ${n} line${n === 1 ? "" : "s"} into the ${sps[col]?.name || "column"}`);
  };
  const flowSpeechDoc = () => {
    if (!round) return;
    const col = sendTo >= 0 ? sendTo : sel.c;
    if (!sps[col]) return;
    flowIn(speechOutline(), col, sps[col].side);
    setPanel(null);
  };
  const flowTheirDoc = () => {
    if (!round) return;
    const f = fileOutline();
    if (!f) { toast("Open their doc in coda first"); return; }
    const col = sel.c;
    if (round.info.us && sps[col]?.side === round.info.us) { toast("Put the cursor in their speech's column first"); return; }
    flowIn(f.blocks, col, sps[col]?.side || "neg");
    setPanel(null);
  };
  // what you send to the speech doc, onto the flow too
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { title?: string; tags?: string[] } | undefined;
      const r = roundRef.current;
      if (!r || sendTo < 0 || !d?.tags?.length) return;
      const s = sheetFor(r, d.title || "") || r.sheets.find((x) => x.id === sheetId && x.kind !== "cx") || r.sheets.find((x) => x.kind !== "cx");
      if (!s) return;
      apply((rr) => appendLines(rr, s.id, sendTo, d.tags!.map((t) => ({ t, src: d.title }))));
    };
    window.addEventListener("coda:sent", on);
    return () => window.removeEventListener("coda:sent", on);
  }, [sendTo, sheetId, apply]);

  /** The cells on the move put down: lifted out (their columns close up) and set in at the new place. */
  const drop = (by: number, byCol: number) => {
    if (!sheet) return;
    const q = rect();
    const bc = Math.max(-q.c0, Math.min(cols.length - 1 - q.c1, byCol));
    if (by || bc) apply((r) => moveBlock(r, sheet.id, [q.c0, q.c1], [q.r0, q.r1], by, bc));
    setMoving(null);
    setAnchor({ c: q.c0 + bc, r: Math.max(0, q.r0 + by) }); setSel({ c: q.c1 + bc, r: Math.max(0, q.r1 + by) });
    requestAnimationFrame(() => gridRef.current?.focus());
  };
  // a drag let go of anywhere: put the cells down where they are
  useEffect(() => {
    if (!moving?.drag) return;
    const up = () => {
      // pressed and let go without moving: a click on that cell
      if (!moving.by && !moving.byCol && moving.drag) { setMoving(null); setSel(moving.drag); setAnchor(moving.drag); return; }
      drop(moving.by, moving.byCol);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [moving]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------ keys */

  const onKey = (e: React.KeyboardEvent) => {
    if (!round || !sheet) return;
    if (editing || renaming || find) return;
    const spec = comboOf(e.nativeEvent);
    if (!spec) return;
    const q = rect();
    const take = () => { e.preventDefault(); e.stopPropagation(); };

    if (moving) {
      if (spec === "↑") { take(); setMoving({ ...moving, by: Math.max(-q.r0, moving.by - 1) }); return; }
      if (spec === "↓") { take(); setMoving({ ...moving, by: moving.by + 1 }); return; }
      if (spec === "←") { take(); setMoving({ ...moving, byCol: Math.max(-q.c0, moving.byCol - 1) }); return; }
      if (spec === "→") { take(); setMoving({ ...moving, byCol: Math.min(cols.length - 1 - q.c1, moving.byCol + 1) }); return; }
      if (spec === "Enter") { take(); drop(moving.by, moving.byCol); return; }
      if (spec === "Escape") { take(); setMoving(null); return; }
      take(); return;
    }

    switch (spec) {
      case "↑": take(); go({ c: sel.c, r: sel.r - 1 }); return;
      case "↓": case "Enter": if (spec === "Enter") { take(); beginEdit(); return; } take(); go({ c: sel.c, r: sel.r + 1 }); return;
      case "←": take(); go({ c: sel.c - 1, r: sel.r }); return;
      case "→": case "Tab": take(); go({ c: sel.c + 1, r: sel.r }); return;
      case "shift+Tab": take(); go({ c: sel.c - 1, r: sel.r }); return;
      case "shift+↑": take(); go({ c: sel.c, r: sel.r - 1 }, true); return;
      case "shift+↓": take(); go({ c: sel.c, r: sel.r + 1 }, true); return;
      case "shift+←": take(); go({ c: sel.c - 1, r: sel.r }, true); return;
      case "shift+→": take(); go({ c: sel.c + 1, r: sel.r }, true); return;
      case "mod+↓": take(); jumpFilled(1); return;
      case "mod+↑": take(); jumpFilled(-1); return;
      case "mod+←": take(); go({ c: 0, r: sel.r }); return;
      case "mod+→": take(); go({ c: cols.length - 1, r: sel.r }); return;
      case "F2": take(); beginEdit(); return;
      case "Delete": case "Backspace": take(); apply((r) => clearRange(r, sheet.id, [q.c0, q.c1], [q.r0, q.r1])); return;
      case "mod+Delete": take(); apply((r) => deleteCell(r, sheet.id, sel.c, sel.r)); return;
      case "mod+Backspace": take(); apply((r) => deleteRow(r, sheet.id, sel.r)); return;
      case "alt+↑": take(); apply((r) => insertCell(r, sheet.id, sel.c, sel.r)); return;
      case "alt+↓": take(); apply((r) => insertCell(r, sheet.id, sel.c, sel.r + 1)); go({ c: sel.c, r: sel.r + 1 }); return;
      case "alt+shift+↑": take(); apply((r) => insertRow(r, sheet.id, sel.r)); return;
      case "alt+shift+↓": take(); apply((r) => insertRow(r, sheet.id, sel.r + 1)); go({ c: sel.c, r: sel.r + 1 }); return;
      case "mod+Enter": take(); beginEdit(nextMarker(round, sheet, sel.c, sel.r) + textAt(sheet, sel.c, sel.r)); return;
      case "mod+shift+Enter": take(); go({ c: sel.c, r: sel.r + 3 }); return;
      case "mod+E": take(); doExtend(); return;
      case "alt+M": take(); setMoving({ by: 0, byCol: 0 }); return;
      case "mod+Z": take(); undo(); return;
      case "mod+Y": case "mod+shift+Z": take(); redo(); return;
      case "mod+B": take(); mark("b"); return;
      case "mod+shift+H": take(); mark("h"); return;
      case "mod+U": take(); mark("c"); return;
      case "mod+G": take(); mark("g"); return;
      case "mod+shift+X": take(); mark("k"); return;
      case "mod+P": take(); setFind({ q: "", at: 0 }); return;
      case "mod+]": case "mod+[": {
        take();
        const i = round.sheets.findIndex((s) => s.id === sheet.id);
        const j = Math.max(0, Math.min(round.sheets.length - 1, i + (spec === "mod+]" ? 1 : -1)));
        toSheet(round.sheets[j].id); return;
      }
      case "mod+shift+]": take(); apply((r) => moveSheet(r, sheet.id, 1)); return;
      case "mod+shift+[": take(); apply((r) => moveSheet(r, sheet.id, -1)); return;
      case "mod+alt+A": take(); newSheet("aff"); return;
      case "mod+alt+N": take(); newSheet("neg"); return;
      case "alt+R": take(); if (sheet.kind !== "cx") setRenaming(sheet.id); return;
      case "mod+\\": take(); setSideOpen((o) => !o); return;
      case "alt+Enter": { take(); const t = textAt(sheet, sel.c, sel.r).trim(); if (t) answer(t); else toast("Nothing in this cell to answer"); return; }
      case "alt+D": take(); setRfd((v) => (v ? null : "edit")); return;
      case "alt+shift+D": take(); setDecision((d) => !d); return;
      case "shift+?": take(); setPanel((p) => (p === "help" ? null : "help")); return;
      case "Escape": take(); setAnchor(sel); setPanel(null); return;
    }
    const m = spec.match(/^alt\+([1-9])$/);
    if (m) { take(); const list = round.sheets; const s = list[Number(m[1]) - 1]; if (s) toSheet(s.id); return; }
    // typing: a printable key starts writing in the cell, added to what's there
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      take();
      const had = textAt(sheet, sel.c, sel.r);
      setAnchor(sel);
      beginEdit(had ? had + (/\s$/.test(had) ? "" : " ") + e.key : e.key);
    }
  };

  const onEdKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!round || !sheet) return;
    const spec = comboOf(e.nativeEvent);
    const t = e.currentTarget;
    const take = () => { e.preventDefault(); e.stopPropagation(); };
    switch (spec) {
      case "Enter": take(); doneEdit(() => go({ c: sel.c, r: sel.r + 1 })); return;
      case "Tab": take(); doneEdit(() => go({ c: sel.c + 1, r: sel.r })); return;
      case "shift+Tab": take(); doneEdit(() => go({ c: sel.c - 1, r: sel.r })); return;
      case "Escape": take(); doneEdit(); return;
      case "mod+shift+Enter": take(); doneEdit(() => go({ c: sel.c, r: sel.r + 3 })); return;
      case "mod+Enter": {
        take();
        if (!/#\s*\d+/.test(editing?.text || "")) { const v = nextMarker(round, sheet, sel.c, sel.r) + (editing?.text || ""); setEditing({ text: v }); requestAnimationFrame(() => { t.setSelectionRange(v.length, v.length); }); }
        return;
      }
      case "↑": if (t.selectionStart === 0 && t.selectionEnd === 0) { take(); doneEdit(() => go({ c: sel.c, r: sel.r - 1 })); } return;
      case "↓": if (t.selectionStart === t.value.length) { take(); doneEdit(() => go({ c: sel.c, r: sel.r + 1 })); } return;
      case "mod+B": take(); commitEdit(); mark("b"); return;
      case "mod+shift+H": take(); commitEdit(); mark("h"); return;
      case "mod+U": take(); commitEdit(); mark("c"); return;
      case "mod+G": take(); commitEdit(); mark("g"); return;
      case "mod+shift+X": take(); commitEdit(); mark("k"); return;
    }
    e.stopPropagation();
  };

  /* ------------------------------------------------------------ find */

  const findHits = useMemo(() => {
    if (!find || !round) return [] as { sheet: Sheet; c: number; r: number; t: string; score: number }[];
    let words = find.q.toLowerCase().split(/\s+/).filter(Boolean);
    let onlyCol: string | null = null;
    const ids = new Set([...speeches(round.order).map((s) => s.id), "cx1", "cx2", "gcx", "first", "second", "grand"]);
    if (words.length && ids.has(words[0])) { onlyCol = words[0]; words = words.slice(1); }
    if (!words.length && !onlyCol) return [];
    const out: { sheet: Sheet; c: number; r: number; t: string; score: number }[] = [];
    for (const s of round.sheets) {
      const cs = columnsOf(round, s);
      for (const k in s.cells) {
        const [c, r] = k.split(":").map(Number);
        const col = cs[c];
        if (onlyCol && !(col && (col.id === onlyCol || col.name.toLowerCase() === onlyCol))) continue;
        const t = s.cells[k].t, low = t.toLowerCase();
        if (!words.every((w) => low.includes(w))) continue;
        const w0 = words[0] || "";
        const score = !w0 ? 1 : low === find.q.toLowerCase() ? 4 : low.startsWith(w0) ? 3 : new RegExp("\\b" + w0.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(low) ? 2 : 1;
        out.push({ sheet: s, c, r, t, score });
      }
      const name = s.name.toLowerCase();
      if (!onlyCol && words.length && words.every((w) => name.includes(w))) out.push({ sheet: s, c: 0, r: 0, t: "Sheet: " + s.name, score: 5 });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 40);
  }, [find, round]);
  const goHit = (h: { sheet: Sheet; c: number; r: number }) => {
    setFind(null); setSheetId(h.sheet.id);
    requestAnimationFrame(() => { setSel({ c: h.c, r: h.r }); setAnchor({ c: h.c, r: h.r }); gridRef.current?.focus(); gridRef.current?.querySelector(`[data-cell="${h.c}:${h.r}"]`)?.scrollIntoView({ block: "center" }); });
  };

  /* ------------------------------------------------------------ export */

  const exportXlsx = async () => {
    if (!round) return;
    try {
      const blob = await roundXlsx(round);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (title(round).replace(/[\\/:*?"<>|]+/g, " ").trim() || "flow") + ".xlsx";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast("The export didn't work: " + (e as Error).message); }
  };

  /* ------------------------------------------------------------ drawing */

  if (!shown) return null;

  if (!round) {
    return (
      <div className="mf mf-start">
        <div className="mf-startin">
          <h2>Flow</h2>
          <p className="mf-sub">Public Forum. Flow from the keyboard: type in a cell, Enter to go down, Tab to go across.</p>
          <div className="mf-new">
            <button type="button" onClick={() => start("aff")}><b>New round</b><span>Aff speaks first</span></button>
            <button type="button" onClick={() => start("neg")}><b>New round</b><span>Neg speaks first</span></button>
          </div>
          <div className="mf-joinrow">
            {joinAsk
              ? <input autoFocus placeholder="Your partner's code" onKeyDown={(e) => { if (e.key === "Enter") joinCode(e.currentTarget.value); if (e.key === "Escape") setJoinAsk(false); }} />
              : <button type="button" onClick={() => setJoinAsk(true)}>Join your partner's round</button>}
            {code && <span className="mf-wait">Joining {code}…</span>}
          </div>
          {rows.length > 0 && (
            <>
              <h4>Your rounds</h4>
              <ul className="mf-rounds">
                {rows.map((x) => (
                  <li key={x.id}>
                    <button type="button" className="mf-open" onClick={() => { const r = getRound(owner, x.id); if (r) open(r); else toast("That round couldn't be read"); }}>
                      <b>{x.title}</b><small>{new Date(x.updated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small>
                    </button>
                    <button type="button" className="mf-del" aria-label={"Delete " + x.title} onClick={() => { if (window.confirm(`Delete the flow "${x.title}"?`)) { dropRound(owner, x.id); setRows(listRounds(owner)); } }}>{I.x}</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    );
  }

  const q = rect();
  const inRange = (c: number, r: number) => c >= q.c0 && c <= q.c1 && r >= q.r0 && r <= q.r1;
  const mates = new Map<string, Peer>();
  for (const p of peers) if (p.caret && p.caret.sheet === sheet?.id) mates.set(cellKey(p.caret.col, Number(p.caret.row)), p);
  const movedTo = (c: number, r: number) => !!moving && c >= q.c0 + moving.byCol && c <= q.c1 + moving.byCol && r >= q.r0 + moving.by && r <= q.r1 + moving.by;
  const many = q.c0 !== q.c1 || q.r0 !== q.r1;
  const colWords = sheet && sheet.kind !== "cx" ? wordsIn(round, sel.c) : 0;
  const us = round.info.us;
  const ourSpeeches = sps.map((s, i) => ({ s, i })).filter((x) => !us || x.s.side === us);

  return (
    <div className={"mf" + (sideOpen ? "" : " noside")} style={{ ["--z" as string]: zoom }}>
      {/* ---- the sheets */}
      <aside className="mf-side" aria-label="Sheets">
        <div className="mf-addrow">
          <button type="button" className="aff" onClick={() => newSheet("aff")} title={"New aff sheet · " + keyLabel("mod+alt+A")}>{I.plus}Aff</button>
          <button type="button" className="neg" onClick={() => newSheet("neg")} title={"New neg sheet · " + keyLabel("mod+alt+N")}>{I.plus}Neg</button>
          <button type="button" className="mf-icon" onClick={() => setSideOpen(false)} aria-label="Hide the sheets" title={"Hide the sheets · " + keyLabel("mod+\\")}>{I.side}</button>
        </div>
        <ul className="mf-sheets">
          {round.sheets.map((s, i) => (
            <li key={s.id} className={(s.id === sheet?.id ? "on " : "") + s.kind + (dragSheet === s.id ? " dragging" : "")}
              draggable={s.kind !== "cx" && renaming !== s.id}
              onDragStart={() => setDragSheet(s.id)} onDragEnd={() => setDragSheet(null)}
              onDragOver={(e) => { if (dragSheet && s.kind !== "cx") e.preventDefault(); }}
              onDrop={() => { if (!dragSheet || dragSheet === s.id) return; const from = round.sheets.findIndex((x) => x.id === dragSheet); apply((r) => moveSheet(r, dragSheet, i - from)); setDragSheet(null); }}>
              {renaming === s.id ? (
                <input autoFocus defaultValue={s.name} aria-label="Sheet name"
                  onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v && v !== s.name) apply((r) => renameSheet(r, s.id, v)); setRenaming(null); requestAnimationFrame(() => gridRef.current?.focus()); }}
                  onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.currentTarget.value = s.name; e.currentTarget.blur(); } }} />
              ) : (
                <button type="button" onClick={() => toSheet(s.id)} onDoubleClick={() => s.kind !== "cx" && setRenaming(s.id)} title={i < 9 ? keyLabel("alt+" + (i + 1)) : undefined}>
                  <i />{s.kind === "cx" ? "Cross-examination" : s.name}
                </button>
              )}
              {s.kind !== "cx" && renaming !== s.id && (
                <span className="mf-sheetacts">
                  <button type="button" aria-label="Rename" title={"Rename · " + keyLabel("alt+R")} onClick={() => setRenaming(s.id)}>✎</button>
                  <button type="button" aria-label="Delete the sheet" onClick={() => { if (Object.keys(s.cells).length === 0 || window.confirm(`Delete the sheet "${s.name}"?`)) { apply((r) => removeSheet(r, s.id)); if (s.id === sheet?.id) setSheetId(round.sheets[0].id); } }}>{I.x}</button>
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="mf-partner">
          {code ? (
            <>
              <span className={"mf-dot " + status} />
              <span className="mf-code" title="Read this to your partner">{code}</span>
              <small>{peers.length ? peers.map((p) => p.name).join(", ") : status === "joining" ? "connecting…" : "waiting for your partner"}</small>
              <button type="button" onClick={leave} title="Stop flowing together">Leave</button>
            </>
          ) : joinAsk ? (
            <input autoFocus placeholder="Partner's code" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") joinCode(e.currentTarget.value); if (e.key === "Escape") setJoinAsk(false); }} onBlur={() => setJoinAsk(false)} />
          ) : (
            <>
              <button type="button" onClick={invite} title="Flow this round with your partner: they type in the code">Invite</button>
              <button type="button" onClick={() => setJoinAsk(true)} title="Flow your partner's round">Join</button>
            </>
          )}
        </div>
      </aside>

      {/* ---- the round */}
      <section className="mf-main">
        <header className="mf-bar">
          {!sideOpen && <button type="button" className="mf-icon" onClick={() => setSideOpen(true)} aria-label="Show the sheets">{I.side}</button>}
          <button type="button" className="mf-back" onClick={close} title="Your rounds">{I.back}Rounds</button>
          <button type="button" className="mf-title" onClick={() => setPanel(panel === "info" ? null : "info")} title="Round info">{title(round)}</button>
          <span className="mf-grow" />
          <label className="mf-sel" title="Go to a speech">
            <span>Speech</span>
            <select value={sheet?.kind === "cx" ? "" : String(sel.c)} onChange={(e) => { const c = Number(e.target.value); if (sheet?.kind === "cx") { const s = round.sheets.find((x) => x.kind !== "cx"); if (s) setSheetId(s.id); } go({ c, r: sheet ? Math.max(0, lastRow(sheet, c) + 1) : 0 }); gridRef.current?.focus(); }}>
              {sheet?.kind === "cx" && <option value="">—</option>}
              {sps.map((s, i) => <option key={s.id} value={i}>{s.name}</option>)}
            </select>
          </label>
          <span className="mf-zoom">
            <button type="button" onClick={() => setZoom(zoom - 0.1)} aria-label="Smaller">−</button>
            <button type="button" className="pct" onClick={() => setZoom(1)} title="Back to 100%">{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoom(zoom + 0.1)} aria-label="Bigger">+</button>
          </span>
          <button type="button" className={panel === "from" ? "on" : ""} onClick={() => setPanel(panel === "from" ? null : "from")} title="Flow from coda: your speech doc, their doc, and what you send">From coda{sendTo >= 0 ? " · " + sps[sendTo]?.name : ""}</button>
          <button type="button" className={rfd ? "on" : ""} onClick={() => setRfd(rfd ? null : "edit")} title={"RFD · " + keyLabel("alt+D")}>RFD</button>
          <button type="button" className={decision ? "on" : ""} onClick={() => setDecision((d) => !d)} title={"Decision view · " + keyLabel("alt+shift+D")}>Decision</button>
          <button type="button" onClick={exportXlsx} title="Download as .xlsx">{I.down}Export</button>
          <button type="button" className="mf-icon" onClick={() => setPanel(panel === "help" ? null : "help")} aria-label="Keys" title="Keys · ?">?</button>
        </header>

        {/* ---- round info */}
        {panel === "info" && (
          <div className="mf-pop mf-info" role="dialog" aria-label="Round info">
            <div className="mf-pophead"><b>Round info</b><button type="button" className="mf-icon" onClick={() => setPanel(null)} aria-label="Close">{I.x}</button></div>
            <div className="mf-fields">
              {([["aff", "Aff team"], ["neg", "Neg team"], ["tournament", "Tournament"], ["round", "Round"], ["flight", "Flight"], ["date", "Date"], ["judge", "Judge"]] as const).map(([k, label]) => (
                <label key={k}><span>{label}</span><input value={round.info[k]} onChange={(e) => { const v = e.target.value; setRound((r) => (r ? { ...r, updated: Date.now(), info: { ...r.info, [k]: v } } : r)); }} onKeyDown={(e) => e.stopPropagation()} /></label>
              ))}
              <label><span>You are</span>
                <span className="mf-seg">
                  {([["", "Judging"], ["aff", "Aff"], ["neg", "Neg"]] as const).map(([v, l]) => (
                    <button key={v} type="button" className={round.info.us === v ? "on" : ""} onClick={() => setRound((r) => (r ? { ...r, info: { ...r.info, us: v } } : r))}>{l}</button>
                  ))}
                </span>
              </label>
              <label><span>First speaker</span>
                <span className="mf-seg">
                  {(["aff", "neg"] as const).map((v) => (
                    <button key={v} type="button" className={round.order === v ? "on" : ""} onClick={() => { if (round.order !== v) apply((r) => swapOrder(r)); }}>{v === "aff" ? "Aff" : "Neg"}</button>
                  ))}
                </span>
              </label>
            </div>
          </div>
        )}

        {/* ---- from coda */}
        {panel === "from" && (
          <div className="mf-pop mf-from" role="dialog" aria-label="Flow from coda">
            <div className="mf-pophead"><b>From coda</b><button type="button" className="mf-icon" onClick={() => setPanel(null)} aria-label="Close">{I.x}</button></div>
            <label className="mf-line"><span>What you send lands in</span>
              <select value={sendTo} onChange={(e) => setSendTo(Number(e.target.value))}>
                <option value={-1}>Nowhere (off)</option>
                {ourSpeeches.map(({ s, i }) => <option key={s.id} value={i}>{s.name}</option>)}
              </select>
            </label>
            <p className="mf-note">Every card you send to the speech doc goes on the flow too: its tag, under what's there, on the sheet named like its block{us ? "" : ". Set which side you are in Round info to see only your speeches"}.</p>
            <div className="mf-acts">
              <button type="button" onClick={flowSpeechDoc}>Flow the speech doc<small>into the {sps[sendTo >= 0 ? sendTo : sel.c]?.name || "column"}</small></button>
              <button type="button" onClick={flowTheirDoc}>Flow their doc<small>the open file, into the {sps[sel.c]?.name || "column"}</small></button>
            </div>
            <p className="mf-note">Each block becomes a sheet (or joins the one named like it), and its tags become the lines. {keyLabel("alt+Enter")} on any cell looks for answers to it in your library.</p>
          </div>
        )}

        {/* ---- keys */}
        {panel === "help" && (
          <div className="mf-pop mf-help" role="dialog" aria-label="Flow keys">
            <div className="mf-pophead"><b>Keys</b><button type="button" className="mf-icon" onClick={() => setPanel(null)} aria-label="Close">{I.x}</button></div>
            <div className="mf-keys">
              {Array.from(new Set(FLOW_KEYS.map((k) => k.group))).map((g) => (
                <section key={g}><h4>{g}</h4>{FLOW_KEYS.filter((k) => k.group === g).map((k) => <div key={k.id} className="mf-k"><span>{k.label}</span><kbd>{keyLabel(k.key).replace("Shift+?", "?")}</kbd></div>)}</section>
              ))}
            </div>
          </div>
        )}

        {/* ---- find */}
        {find && (
          <div className="mf-pop mf-find" role="dialog" aria-label="Find in the flow">
            <input autoFocus value={find.q} placeholder={'Find in the flow · "ar warming" looks only in the AR'}
              onChange={(e) => setFind({ q: e.target.value, at: 0 })}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") { setFind(null); gridRef.current?.focus(); }
                if (e.key === "ArrowDown") { e.preventDefault(); setFind({ ...find, at: Math.min(findHits.length - 1, find.at + 1) }); }
                if (e.key === "ArrowUp") { e.preventDefault(); setFind({ ...find, at: Math.max(0, find.at - 1) }); }
                if (e.key === "Enter" && findHits[find.at]) goHit(findHits[find.at]);
              }} />
            <ul>
              {findHits.map((h, i) => (
                <li key={h.sheet.id + h.c + ":" + h.r + i} className={i === find.at ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); goHit(h); }}>
                  <span className={"tag " + h.sheet.kind}>{h.sheet.kind === "cx" ? "CX" : h.sheet.name} · {columnsOf(round, h.sheet)[h.c]?.name}</span>{h.t}
                </li>
              ))}
              {find.q && !findHits.length && <li className="none">Nothing on the flow says that</li>}
            </ul>
          </div>
        )}

        {decision ? (
          <DecisionView round={round} rfd={round.rfd} setRfd={(v) => setRound((r) => (r ? { ...r, rfd: v, updated: Date.now() } : r))} />
        ) : sheet && (
          <div className="mf-grid" ref={gridRef} tabIndex={0} onKeyDown={onKey}
            onCopy={(e) => { if (editing) return; e.preventDefault(); e.clipboardData.setData("text/plain", copy(false)); }}
            onCut={(e) => { if (editing) return; e.preventDefault(); e.clipboardData.setData("text/plain", copy(true)); }}
            onPaste={(e) => { if (editing) return; e.preventDefault(); paste(e.clipboardData.getData("text/plain")); }}
            onWheel={(e) => { if (e.ctrlKey) { e.preventDefault(); setZoom(zoom - Math.sign(e.deltaY) * 0.1); } }}
            onMouseUp={() => { dragSel.current = false; }}>
            <div className="mf-table" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(calc(300px * var(--z)), 1fr))` }}>
              {cols.map((c, i) => {
                const side = sheet.kind === "cx" ? "cx" : sps[i]?.side;
                return <div key={c.id} className={"mf-h " + side + (i === sel.c ? " cur" : "") + (i === sendTo && sheet.kind !== "cx" ? " sends" : "")}>{c.name}</div>;
              })}
              {Array.from({ length: nRows }).map((_, r) => cols.map((_, c) => {
                const cell = cellAt(sheet, c, r);
                const isSel = c === sel.c && r === sel.r;
                const cls = "mf-c" + (cell?.b ? " b" : "") + (cell?.h ? " h" : "") + (cell?.c ? " cd" : "") + (cell?.g ? " g" : "") + (cell?.k ? " k" : "") +
                  (cell?.src ? " src" : "") + (isSel ? " sel" : "") + (inRange(c, r) && !isSel ? " rng" : "") + (movedTo(c, r) ? " movto" : "") + (moving && inRange(c, r) ? " lifting" : "") + (many && inRange(c, r) && !moving && !editing ? " grab" : "");
                const mate = mates.get(cellKey(c, r));
                return (
                  <div key={cellKey(c, r)} className={cls + (mate ? " mate" : "")} data-cell={cellKey(c, r)} title={cell?.src ? "From " + cell.src : undefined}
                    style={mate ? { ["--mate" as string]: `hsl(${mate.hue} 70% 42%)` } : undefined} data-mate={mate?.name}
                    onMouseDown={(e) => {
                      if (editing && !isSel) commitEdit();
                      if (editing && isSel) return;
                      e.preventDefault(); gridRef.current?.focus();
                      if (many && inRange(c, r) && !e.shiftKey && e.button === 0) { setMoving({ by: 0, byCol: 0, drag: { c, r } }); return; }
                      setSel({ c, r }); if (!e.shiftKey) setAnchor({ c, r });
                      dragSel.current = true;
                    }}
                    onMouseEnter={() => {
                      if (moving?.drag) {
                        setMoving({ ...moving, by: Math.max(-q.r0, r - moving.drag.r), byCol: Math.max(-q.c0, Math.min(cols.length - 1 - q.c1, c - moving.drag.c)) });
                        return;
                      }
                      if (dragSel.current) setSel({ c, r });
                    }}
                    onDoubleClick={() => { setSel({ c, r }); setAnchor({ c, r }); beginEdit(); }}>
                    {isSel && editing ? (
                      <textarea ref={edRef} className="mf-ed" value={editing.text} spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
                        onChange={(e) => { setEditing({ text: e.target.value }); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                        onKeyDown={onEdKey} onBlur={() => commitEdit()} />
                    ) : (cell?.t || "")}
                  </div>
                );
              }))}
            </div>
          </div>
        )}

        {/* ---- the RFD */}
        {rfd && !decision && (
          <div className="mf-rfd">
            <div className="mf-rfdhead"><b>RFD</b>
              <span className="mf-seg">
                <button type="button" className={rfd === "edit" ? "on" : ""} onClick={() => setRfd("edit")}>Edit</button>
                <button type="button" className={rfd === "preview" ? "on" : ""} onClick={() => setRfd("preview")}>Preview</button>
              </span>
              <button type="button" className="mf-icon" onClick={() => setRfd(null)} aria-label="Close the RFD">{I.x}</button>
            </div>
            {rfd === "edit"
              ? <textarea className="mf-rfdtext" value={round.rfd} placeholder="Why you voted the way you did. # headings, **bold**, - lists." onKeyDown={(e) => e.stopPropagation()}
                  onChange={(e) => { const v = e.target.value; setRound((r) => (r ? { ...r, rfd: v, updated: Date.now() } : r)); }} />
              : <div className="mf-rfdview" dangerouslySetInnerHTML={{ __html: md(round.rfd) }} />}
          </div>
        )}

        <footer className="mf-foot">
          {moving ? <span className="mf-moving">{moving.drag ? "Moving · let go to put them down" : "Moving · arrows to place, Enter to drop, Esc to cancel"}</span>
            : <span>{sheet?.kind === "cx" ? "Cross-examination" : `${cols[sel.c]?.name || ""} · ${colWords.toLocaleString()} words · ${fmtTime((colWords / Math.max(60, wpm)) * 60)} at ${wpm} wpm`}</span>}
          <span className="mf-grow" />
          <span className="mf-hint">Type to flow · Enter down · Tab across · {keyLabel("mod+P")} find · ? keys</span>
        </footer>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ the decision view: the RFD beside cross-ex and the final focuses */

function DecisionView({ round, rfd, setRfd }: { round: Round; rfd: string; setRfd: (v: string) => void }) {
  const sps = speeches(round.order);
  const finals = sps.map((s, i) => ({ s, i })).filter((x) => x.s.id === "af" || x.s.id === "nf");
  const cx = round.sheets.find((s) => s.kind === "cx");
  return (
    <div className="mf-decision">
      <div className="mf-dcol">
        <h4>RFD</h4>
        <textarea className="mf-rfdtext" value={rfd} onChange={(e) => setRfd(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Why you voted the way you did." />
      </div>
      <div className="mf-dcol">
        <h4>Final focuses</h4>
        {round.sheets.filter((s) => s.kind !== "cx").map((s) => {
          const lines = finals.flatMap(({ s: sp, i }) => {
            const out: { sp: string; side: string; t: string }[] = [];
            for (let w = 0; w <= lastRow(s, i); w++) { const t = textAt(s, i, w).trim(); if (t) out.push({ sp: sp.name, side: sp.side, t }); }
            return out;
          });
          if (!lines.length) return null;
          return <section key={s.id}><b className={s.kind}>{s.name}</b>{lines.map((l, k) => <p key={k}><span className={"tag " + l.side}>{l.sp}</span>{l.t}</p>)}</section>;
        })}
      </div>
      <div className="mf-dcol">
        <h4>Cross-examination</h4>
        {cx && CXcols(round, cx)}
      </div>
    </div>
  );
}

function CXcols(round: Round, cx: Sheet) {
  return columnsOf(round, cx).map((c, i) => {
    const lines: string[] = [];
    for (let w = 0; w <= lastRow(cx, i); w++) { const t = textAt(cx, i, w).trim(); if (t) lines.push(t); }
    if (!lines.length) return null;
    return <section key={c.id}><b>{c.name}</b>{lines.map((t, k) => <p key={k}>{t}</p>)}</section>;
  });
}

const fmtTime = (s: number) => { const m = Math.floor(s / 60), r = Math.round(s % 60); return m + ":" + String(r).padStart(2, "0"); };

/** A little Markdown, for the RFD: headings, bold, italics, lists, quotes, paragraphs. Escaped first. */
function md(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<i>$2</i>");
  const out: string[] = [];
  let list = false;
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (!list) { out.push("<ul>"); list = true; } out.push("<li>" + inline(li[1]) + "</li>"); continue; }
    if (list) { out.push("</ul>"); list = false; }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) { out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }
    if (/^>\s?/.test(line)) { out.push("<blockquote>" + inline(line.replace(/^>\s?/, "")) + "</blockquote>"); continue; }
    if (line.trim()) out.push("<p>" + inline(line) + "</p>");
  }
  if (list) out.push("</ul>");
  return out.join("");
}
