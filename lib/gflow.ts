/**
 * A partner's flow, read out of a Google Doc's HTML export.
 *
 * The flow is a bulleted outline: headings or top bullets for each speech or
 * position, arguments and their answers indented under them. Google writes a
 * list as flat <ul>s, one per run of items at the same depth, and says the
 * depth in the class — "lst-kix_abc123-2" is the third level — rather than by
 * nesting, so that suffix is what is read. A heading starts a section; a
 * plain paragraph is a line of its own; a table's cells are read in order.
 */

export interface FlowItem {
  /** "h" a heading, "li" a bullet, "p" a plain line */
  kind: "h" | "li" | "p";
  /** how far in it sits: headings 0, bullets 1 + their list depth under a heading */
  depth: number;
  text: string;
}

const clean = (s: string) => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();

export function parseFlow(html: string): FlowItem[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: FlowItem[] = [];
  let underHeading = false;
  const levelOf = (el: Element) => {
    const m = (el.getAttribute("class") || "").match(/lst-kix_[A-Za-z0-9_]+-(\d+)/);
    return m ? +m[1] : 0;
  };
  const walk = (el: Element) => {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const t = clean(el.textContent || "");
      if (t) { out.push({ kind: "h", depth: 0, text: t }); underHeading = true; }
      return;
    }
    if (tag === "UL" || tag === "OL") {
      const lv = levelOf(el);
      el.querySelectorAll(":scope > li").forEach((li) => {
        const t = clean(li.textContent || "");
        if (t) out.push({ kind: "li", depth: lv + (underHeading ? 1 : 0), text: t });
      });
      return;
    }
    if (tag === "P") {
      const t = clean(el.textContent || "");
      if (t) out.push({ kind: "p", depth: underHeading ? 1 : 0, text: t });
      return;
    }
    if (tag === "TABLE") {
      el.querySelectorAll("td, th").forEach((cell) => cell.querySelectorAll("p, li").forEach((x) => {
        const t = clean(x.textContent || "");
        if (t) out.push({ kind: "p", depth: underHeading ? 1 : 0, text: t });
      }));
      return;
    }
    Array.from(el.children).forEach(walk);
  };
  Array.from(doc.body.children).forEach(walk);
  return out;
}

/** The Doc's id, from its link or as given. */
export function gdocId(raw: string): string {
  const m = raw.trim().match(/\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,80})/);
  return m ? m[1] : raw.trim();
}

/**
 * The Doc as it looks: Google's own stylesheet and its body, made safe to put
 * on the page — no scripts, no handlers, no frames, links that go nowhere.
 * Shown inside a shadow root, so its styles (p, li, h1… and its .c0 classes)
 * stay inside it and the page's stay out.
 */
export function docView(html: string): { css: string; body: string; bodyClass: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, iframe, object, embed, form, link, meta, base").forEach((n) => n.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const a of Array.from(el.attributes)) if (/^on/i.test(a.name) || (a.name === "href" && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
  });
  const css = Array.from(doc.querySelectorAll("style")).map((x) => x.textContent || "").join("\n")
    // nothing in it may reach outside: no imports, no fonts fetched
    .replace(/@import[^;]+;/g, "")
    .replace(/<\/?style/gi, "");
  doc.querySelectorAll("style").forEach((x) => x.remove());
  return { css, body: doc.body.innerHTML, bodyClass: doc.body.getAttribute("class") || "" };
}

/** The lines of a shown Doc that are arguments to click: every list item, paragraph and heading with words in it. */
export const LINE_SEL = "li, p, h1, h2, h3, h4, h5, h6";
export const lineText = (el: Element) => clean(el.textContent || "");
