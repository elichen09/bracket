import { levelOf } from "../viewer/doc";
import { isBlankBackground } from "../evidence/docSchema";

/**
 * A .docx, as HTML the card cutter can open.
 *
 * docx-preview lays the file out (off screen, the way the Doc viewer does).
 * In a Verbatim file, cite, underline and emphasis are Word *character
 * styles*, which docx-preview writes as classes in a stylesheet rather than
 * as styles on the text — so each run's style is read off the page as it is
 * drawn, and written onto it, before the stylesheet goes. Headings come back
 * as h1–h4 whatever Word called them (Heading 1–4, or Pocket/Hat/Block/Tag).
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const BASE_PX = 11 / 0.75;          // 11pt, in the pixels getComputedStyle answers in

const isBg = (c: string) => !isBlankBackground(c);

export async function docxToHtml(blob: Blob): Promise<string> {
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-100000px;top:0;width:820px;visibility:hidden;pointer-events:none";
  document.body.appendChild(holder);
  try {
    const { renderAsync } = await import("docx-preview");
    await renderAsync(blob, holder, holder, {
      inWrapper: false, ignoreWidth: true, ignoreHeight: true, breakPages: false,
      renderHeaders: false, renderFooters: false, renderFootnotes: false, renderEndnotes: false, className: "docx",
    });
    const out: string[] = [];
    holder.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li").forEach((el) => {
      if (el.querySelector("p, h1, h2, h3, h4, li")) return;          // a container, its children speak
      const level = Math.min(4, levelOf(el));
      const runs: string[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
        const text = t.data;
        if (!text) continue;
        const p = t.parentElement || (el as HTMLElement);
        const cs = getComputedStyle(p);
        let under = false, bg = "", box = false;
        for (let a: HTMLElement | null = p; a && a !== el.parentElement; a = a.parentElement) {
          if ((getComputedStyle(a).textDecorationLine || "").includes("underline")) under = true;
          if (!bg) { const b = getComputedStyle(a).backgroundColor; if (isBg(b)) bg = b; }
          if (a !== el && getComputedStyle(a).borderTopStyle === "solid") box = true;
        }
        if (level) { runs.push(esc(text)); continue; }               // a heading is its style
        const px = parseFloat(cs.fontSize);
        const st = [
          parseInt(cs.fontWeight, 10) >= 600 ? "font-weight:700" : "",
          cs.fontStyle === "italic" ? "font-style:italic" : "",
          under ? "text-decoration:underline" : "",
          px && Math.abs(px - BASE_PX) > 0.6 ? `font-size:${Math.round(px * 0.75)}pt` : "",
          bg ? `background-color:${bg}` : "",
          box ? "border:1px solid #000" : "",
        ].filter(Boolean).join(";");
        runs.push(st ? `<span style="${st}">${esc(text)}</span>` : esc(text));
      }
      const body = runs.join("");
      out.push(level ? `<h${level}>${body}</h${level}>` : `<p>${body}</p>`);
    });
    return out.join("");
  } finally {
    holder.remove();
  }
}
