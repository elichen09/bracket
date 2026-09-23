"use client";

import { useCallback, useRef } from "react";

/**
 * Formatting for the send document.
 *
 * One row, at the top of the panel, present only while the document is one you
 * can write in. Everything here is what a debater actually reaches for —
 * bold, underline, a size, a face, a highlighter — and nothing else, because
 * the panel's job is to show the document and a second wall of controls would
 * eat the thing it is showing.
 *
 * It drives `document.execCommand`. That API is deprecated and still the only
 * one every browser implements for a contenteditable region; the replacement
 * is to write the selection handling by hand, which is a great deal of code to
 * arrive back where this starts. Two details make it behave:
 *
 *  - The buttons cancel their own mousedown, so pressing one never moves focus
 *    out of the document and the selection survives. A <select> cannot do that
 *    and still open, so the range is remembered when it is opened and put back
 *    before the command runs.
 *  - execCommand's own size scale is 1-7, not points, so a size is applied as
 *    7 and the tags it leaves are swapped for spans carrying real points. The
 *    same pass turns a face into an inline style, so what lands on the
 *    clipboard is what Docs would have written itself.
 */

const FONTS = ["Calibri", "Arial", "Times New Roman", "Georgia", "Verdana", "Garamond"];
const SIZES = ["8", "9", "10", "11", "12", "13", "14", "16", "18", "24"];

export default function DocFormat({ host }: { host: React.RefObject<HTMLDivElement> }) {
  const saved = useRef<Range | null>(null);

  const page = useCallback(
    () => host.current?.querySelector<HTMLElement>("#docbody .paper[contenteditable]") || null,
    [host],
  );

  /** Remember where the cursor is, for controls that have to take focus. */
  const remember = useCallback(() => {
    const p = page();
    const sel = window.getSelection();
    if (!p || !sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (p.contains(r.commonAncestorContainer)) saved.current = r.cloneRange();
  }, [page]);

  const focused = useCallback(() => {
    const p = page();
    if (!p) return null;
    p.focus();
    const sel = window.getSelection();
    const inside = sel && sel.rangeCount && p.contains(sel.getRangeAt(0).commonAncestorContainer);
    if (!inside && saved.current) {
      sel?.removeAllRanges();
      sel?.addRange(saved.current);
    }
    return p;
  }, [page]);

  /** Tell the engine the draft changed, so it saves. */
  const changed = (p: HTMLElement) => p.dispatchEvent(new InputEvent("input", { bubbles: true }));

  const run = useCallback((cmd: string, value?: string, asCss = false) => {
    const p = focused();
    if (!p) return;
    if (asCss) document.execCommand("styleWithCSS", false, "true");
    document.execCommand(cmd, false, value);
    if (asCss) document.execCommand("styleWithCSS", false, "false");
    changed(p);
  }, [focused]);

  const setSize = useCallback((pt: string) => {
    const p = focused();
    if (!p || !pt) return;
    document.execCommand("fontSize", false, "7");     // the only handle there is
    p.querySelectorAll('font[size="7"]').forEach((f) => {
      const span = document.createElement("span");
      span.style.fontSize = pt + "pt";
      span.innerHTML = (f as HTMLElement).innerHTML;
      f.replaceWith(span);
    });
    changed(p);
  }, [focused]);

  const B = ({ cmd, label, title, style }: { cmd: string; label: string; title: string; style?: React.CSSProperties }) => (
    <button type="button" className="fbtn" title={title} style={style}
      onMouseDown={(e) => e.preventDefault()} onClick={() => run(cmd)}>{label}</button>
  );

  return (
    <div className="docbar" onMouseDown={remember}>
      <select className="fsel" defaultValue="" title="Font"
        onMouseDown={remember} onChange={(e) => { run("fontName", e.target.value, true); e.target.value = ""; }}>
        <option value="" disabled>Font</option>
        {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
      </select>
      <select className="fsel narrow" defaultValue="" title="Size"
        onMouseDown={remember} onChange={(e) => { setSize(e.target.value); e.target.value = ""; }}>
        <option value="" disabled>Size</option>
        {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>

      <span className="fdiv" />
      <B cmd="bold" label="B" title="Bold — Ctrl/⌘+B" style={{ fontWeight: 700 }} />
      <B cmd="italic" label="I" title="Italic — Ctrl/⌘+I" style={{ fontStyle: "italic", fontFamily: "Georgia, serif" }} />
      <B cmd="underline" label="U" title="Underline — Ctrl/⌘+U" style={{ textDecoration: "underline" }} />
      <B cmd="strikeThrough" label="S" title="Strike through" style={{ textDecoration: "line-through" }} />

      <span className="fdiv" />
      <button type="button" className="fbtn hl" title="Highlight"
        onMouseDown={(e) => e.preventDefault()} onClick={() => run("hiliteColor", "#ffff00", true)}>
        <i />
      </button>
      {/* Docs' own mark for this, and it keeps the row to one line. */}
      <button type="button" className="fbtn" title="Clear the formatting on the selection"
        onMouseDown={(e) => e.preventDefault()} onClick={() => run("removeFormat")}>T<sub>x</sub></button>

      <span className="fdiv" />
      {/* The whole document rather than the selection, so it is the engine's
          job: it asks the questions and rewrites the draft. */}
      <button type="button" className="fbtn wide" data-act="format"
        title="Title it, drop the analytics, renumber, take out the white space">Format</button>
    </div>
  );
}
