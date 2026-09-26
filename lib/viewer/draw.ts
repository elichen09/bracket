/**
 * Drawing a document onto the page — the Doc viewer's, and its pop-out's.
 *
 * A .docx is laid out by docx-preview; a web page, a paste or a send doc is
 * cleaned and set in as HTML; plain text becomes paragraphs. Then readDoc
 * names the headings and marks the highlighting, and what it found comes
 * back. A PDF is not drawn here (the browser's own reader shows it).
 */
import { sanitize, readDoc, type Head } from "./doc";
import type { ViewDoc } from "./store";

export const textToHtml = (t: string) =>
  t.replace(/\r/g, "").split(/\n{2,}/).map((p) => "<p>" + p.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!)).replace(/\n/g, "<br>") + "</p>").join("");

/** Draw it into `el`. Null if `stale()` said, part way, that it is no longer wanted. */
export async function drawDoc(el: HTMLElement, doc: Pick<ViewDoc, "kind" | "blob" | "html">, stale: () => boolean = () => false): Promise<Head[] | null> {
  el.innerHTML = "";
  if (doc.kind === "docx" && doc.blob) {
    const { renderAsync } = await import("docx-preview");
    if (stale()) return null;
    await renderAsync(doc.blob, el, el, {
      inWrapper: false, ignoreWidth: true, ignoreHeight: true, breakPages: false, ignoreLastRenderedPageBreak: true,
      renderHeaders: false, renderFooters: false, renderFootnotes: true, renderEndnotes: true, className: "docx", useBase64URL: true,
    });
  } else {
    el.innerHTML = sanitize(doc.kind === "text" ? textToHtml(doc.html || "") : doc.html || "");
  }
  if (stale()) return null;
  return readDoc(el);
}
