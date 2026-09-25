import { levelOf } from "../viewer/doc";

/**
 * A disclosed .docx, as the HTML Evidence's parser reads.
 *
 * Evidence builds its library from what Google Docs puts on the clipboard:
 * real <h1>–<h4> for the pocket, hat, block and tag, and every run's look —
 * bold, underline, highlight, size — written on the run itself. A .docx laid
 * out by docx-preview says the same things differently: headings are
 * paragraphs with a style class (Heading 4, or Verbatim's "Tag"), and most of
 * a card's underlining and emphasis lives in character styles, i.e. in a
 * stylesheet. So the file is laid out off screen, where the stylesheet applies,
 * and each run's computed look is written back onto it; then each heading
 * paragraph becomes the heading it is. What comes out parses like a paste.
 */

const px2pt = (px: string) => Math.round(parseFloat(px) * 0.75 * 2) / 2;
const clear = (bg: string) => !bg || bg === "transparent" || /rgba\([^)]*,\s*0\)$/.test(bg);

export async function docxToHtml(blob: Blob): Promise<string> {
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-100000px;top:0;width:820px;visibility:hidden;pointer-events:none;contain:strict;height:10px;overflow:hidden";
  document.body.appendChild(holder);
  try {
    const { renderAsync } = await import("docx-preview");
    await renderAsync(blob, holder, holder, {
      inWrapper: false, ignoreWidth: true, ignoreHeight: true, breakPages: false, ignoreLastRenderedPageBreak: true,
      renderHeaders: false, renderFooters: false, renderFootnotes: false, renderEndnotes: false, className: "docx",
    });

    // every run's look, written on the run
    holder.querySelectorAll<HTMLElement>("span").forEach((el) => {
      if (!el.textContent) return;
      const cs = getComputedStyle(el);
      const css: string[] = [];
      css.push("font-weight:" + (parseInt(cs.fontWeight, 10) >= 600 ? 700 : 400));
      if (cs.fontStyle === "italic") css.push("font-style:italic");
      const deco = cs.textDecorationLine || cs.textDecoration || "";
      // only ever said, never denied: underline does not inherit in computed
      // style, so a run inside an underlined run reads "none" and would undo it
      if (/underline/.test(deco)) css.push("text-decoration:underline");
      if (cs.fontSize) css.push("font-size:" + px2pt(cs.fontSize) + "pt");
      if (!clear(cs.backgroundColor)) css.push("background-color:" + cs.backgroundColor);
      el.setAttribute("style", css.join(";"));
      el.removeAttribute("class");
    });

    // every heading paragraph, the heading it is
    holder.querySelectorAll("p").forEach((p) => {
      const lvl = levelOf(p);
      if (!lvl) return;
      const h = document.createElement("h" + Math.min(lvl, 6));
      while (p.firstChild) h.appendChild(p.firstChild);
      p.replaceWith(h);
    });
    holder.querySelectorAll("style").forEach((s) => s.remove());
    return holder.innerHTML;
  } finally {
    holder.remove();
  }
}
