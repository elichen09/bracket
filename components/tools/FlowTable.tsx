"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseSections, toDocsHtml, type FlowSection } from "@/lib/gflowTable";
import { scoped } from "@/lib/owner";

/**
 * Your partner's flow tab, as tables you write in.
 *
 * Each numbered argument in the Doc is a row; its lettered responses fill the
 * Responses cell, one a line. Type in that cell like a spreadsheet — Enter
 * starts the next response, Tab goes on to the next row, ↑ and ↓ off the
 * edge of a cell move between rows — and in the blank row at the bottom of a
 * part to add an argument. What you write is kept here, against the Doc and
 * the argument, until the Doc says the same: COPY FOR DOCS puts the whole
 * flow on the clipboard as the Doc's own numbered and lettered lists, to
 * paste over the flow tab (click in it, Ctrl+A, Ctrl+V). A Google Doc cannot
 * be written to from outside without a Google sign-in; this is the way
 * without one.
 */

interface Edits { rows: Record<string, string[]>; added: { arg: string; responses: string[] }[] }
type All = Record<string, Edits>;

const secKey = (s: FlowSection, i: number) => (s.title || "") + "#" + i;
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
// kept as typed — a line just started with Enter is still there; blank lines are dropped only on the way out
const linesOf = (v: string) => v.split("\n");

export default function FlowTable({ html, docKey, owner, onLook, toast }: {
  html: string; docKey: string; owner?: string | null; onLook: (text: string) => void; toast: (s: string) => void;
}) {
  const sections = useMemo(() => parseSections(html), [html]);
  const store = scoped("gflow.edits", owner) + ":" + docKey;
  const [edits, setEdits] = useState<All>({});
  // what was written is read back first; only after that is anything written over it
  const loadedFor = useRef("");
  const skip = useRef(false);
  useEffect(() => {
    try { setEdits(JSON.parse(localStorage.getItem(store) || "{}") || {}); } catch { setEdits({}); }
    loadedFor.current = store;
    skip.current = true;
  }, [store]);
  useEffect(() => {
    if (loadedFor.current !== store) return;
    if (skip.current) { skip.current = false; return; }      // the render before what was kept arrives
    try { localStorage.setItem(store, JSON.stringify(edits)); } catch { /* private browsing */ }
  }, [edits, store]);

  // what the Doc now says, once it says it, is no longer an edit of yours
  useEffect(() => {
    setEdits((all) => {
      let changed = false;
      const next: All = { ...all };
      sections.forEach((s, i) => {
        const k = secKey(s, i), e = next[k];
        if (!e) return;
        const rows = { ...e.rows };
        s.rows.forEach((r) => { if (rows[r.arg] && same(rows[r.arg].filter((x) => x.trim()), r.responses)) { delete rows[r.arg]; changed = true; } });
        const added = e.added.filter((a) => !s.rows.some((r) => r.arg === a.arg.trim()) || (changed = true, false));
        next[k] = { rows, added };
      });
      return changed ? next : all;
    });
  }, [sections]);

  const edit = (k: string, f: (e: Edits) => Edits) => setEdits((all) => ({ ...all, [k]: f(all[k] || { rows: {}, added: [] }) }));

  /** The flow as it will be: the Doc, with what you have written. */
  const merged = sections.map((s, i) => {
    const k = secKey(s, i), e = edits[k] || { rows: {}, added: [] };
    let n = s.rows.length ? s.rows[s.rows.length - 1].n : 0;
    const colour = s.rows[0]?.color || "";
    return {
      k, title: s.title,
      rows: [
        ...s.rows.map((r) => ({ ...r, responses: e.rows[r.arg] ?? r.responses, mine: !!e.rows[r.arg] && !same(e.rows[r.arg].filter((x) => x.trim()), r.responses), added: -1 })),
        ...e.added.map((a, j) => ({ a, j })).filter(({ a }) => a.arg.trim() || a.responses.some((x) => x.trim()))
          .map(({ a, j }) => ({ n: ++n, arg: a.arg, color: colour, responses: a.responses, mine: true, added: j })),
      ],
      next: n + 1,
    };
  });
  const pending = merged.reduce((t, s) => t + s.rows.filter((r) => r.mine).length, 0);

  const copy = async () => {
    const { html: h, text } = toDocsHtml(merged.map((s) => ({ title: s.title, rows: s.rows.filter((r) => r.arg.trim()).map((r) => ({ n: r.n, arg: r.arg.trim(), color: r.color, responses: r.responses })) })));
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([h], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
      toast("Copied — in the Doc's flow tab: click in it, Ctrl+A, Ctrl+V");
    } catch {
      toast("The browser would not copy — allow the clipboard for this site");
    }
  };

  // Excel's keys: Tab on to the next cell, ↑ ↓ off a cell's edge to the row above or below
  const box = useRef<HTMLDivElement>(null);
  const cells = () => Array.from(box.current?.querySelectorAll<HTMLTextAreaElement>("textarea[data-cell]") || []);
  const go = (from: HTMLTextAreaElement, d: number) => {
    const all = cells(), i = all.indexOf(from), to = all[i + d];
    if (!to) return false;
    to.focus();
    return true;
  };
  const place = (t: HTMLTextAreaElement, at: number) => requestAnimationFrame(() => t.setSelectionRange(at, at));
  const keys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    const after = () => document.activeElement as HTMLTextAreaElement;
    // Tab: the next cell, ready to add to; ↑ ↓ off a cell's edge: the row above or below
    if (e.key === "Tab") { if (go(t, e.shiftKey ? -1 : 1)) { e.preventDefault(); place(after(), after().value.length); } return; }
    if (e.key === "ArrowDown" && !t.value.slice(t.selectionEnd).includes("\n")) { if (go(t, 1)) { e.preventDefault(); place(after(), 0); } return; }
    if (e.key === "ArrowUp" && !t.value.slice(0, t.selectionStart).includes("\n")) { if (go(t, -1)) { e.preventDefault(); place(after(), after().value.length); } return; }
    if (e.key === "Escape") t.blur();
  };

  if (!sections.length) return <p className="rm-gferr">No numbered lists in the flow tab yet.</p>;

  return (
    <div className="rm-ft" ref={box}>
      <div className="rm-ftbar">
        <span>{pending ? `${pending} change${pending === 1 ? "" : "s"} not in the Doc yet` : "Everything here is in the Doc"}</span>
        <span className="rm-grow" />
        <button type="button" className={"rm-pbtn" + (pending ? " acc" : "")} onClick={() => void copy()} title="The flow as the Doc's numbered and lettered lists — paste it over the flow tab (click in it, Ctrl+A, Ctrl+V)">COPY FOR DOCS</button>
      </div>
      {merged.map((s) => (
        <section key={s.k} className="rm-fts">
          {s.title && <h3>{s.title}</h3>}
          <table>
            <colgroup><col className="n" /><col className="a" /><col className="r" /></colgroup>
            <thead><tr><th>#</th><th>Argument</th><th>Responses</th></tr></thead>
            <tbody>
              {s.rows.map((r, ri) => (
                <tr key={ri} className={r.mine ? "mine" : ""}>
                  <td className="n">{r.n}</td>
                  <td className="a">
                    {r.added >= 0 ? (
                      <textarea data-cell data-added={s.k + ":" + r.added} value={r.arg} rows={1} spellCheck={false} placeholder="Argument" style={{ color: r.color || undefined }} onKeyDown={keys}
                        onChange={(e) => { const v = e.target.value.replace(/\n/g, " "); edit(s.k, (x) => ({ ...x, added: x.added.map((a, j) => (j === r.added ? { ...a, arg: v } : a)) })); }} />
                    ) : (
                      <button type="button" className="arg" style={{ color: r.color || undefined }} onClick={() => onLook(r.arg)} title="Look for this in the library">{r.arg}</button>
                    )}
                  </td>
                  <td className="r">
                    <textarea data-cell value={r.responses.join("\n")} rows={Math.max(1, r.responses.length)} spellCheck={false} placeholder={r.added >= 0 ? "" : "Respond…"} onKeyDown={keys}
                      onChange={(e) => {
                        const v = linesOf(e.target.value);
                        if (r.added >= 0) edit(s.k, (x) => ({ ...x, added: x.added.map((a, j) => (j === r.added ? { ...a, responses: v } : a)) }));
                        else edit(s.k, (x) => ({ ...x, rows: { ...x.rows, [r.arg]: v } }));
                      }} />
                  </td>
                </tr>
              ))}
              {/* the blank row: an argument of your own, the next number */}
              <tr className="new">
                <td className="n">{s.next}</td>
                <td className="a"><textarea data-cell value="" rows={1} spellCheck={false} placeholder="+ Add an argument" onKeyDown={keys}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\n/g, " ");
                    if (!v) return;
                    const j = (edits[s.k]?.added || []).length;
                    edit(s.k, (x) => ({ ...x, added: [...x.added, { arg: v, responses: [] }] }));
                    // the row it became takes the cursor, at the end of what was typed
                    requestAnimationFrame(() => {
                      const t = box.current?.querySelector<HTMLTextAreaElement>(`textarea[data-added="${CSS.escape(s.k + ":" + j)}"]`);
                      if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
                    });
                  }} /></td>
                <td className="r" />
              </tr>
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
