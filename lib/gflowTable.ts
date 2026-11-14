/**
 * A flow, as tables.
 *
 * The flow tab of a partner's Google Doc is numbered lists: each numbered line
 * an argument, the lettered lines under it (a., b., …) its responses. A plain
 * line between the lists — "C1" — starts a new part. That is read here into
 * sections of rows, from the HTML Google exports; and written back the same
 * way, as HTML a Google Doc pastes into numbered and lettered lists with the
 * colours they had.
 *
 * Google writes each run of list items at one depth as its own <ol>, with the
 * list and its depth in the class ("lst-kix_abc-0" is list abc, top level)
 * and where its numbering picks up in start="5". Colours are in its own
 * stylesheet, by class (.c3{color:#ff0000}).
 */

export interface FlowRow { n: number; arg: string; color: string; responses: string[] }
export interface FlowSection { title: string; rows: FlowRow[] }

const clean = (s: string) => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();

/** class → colour, out of Google's stylesheet. */
function colours(css: string): Map<string, string> {
  const m = new Map<string, string>();
  const re = /\.([A-Za-z0-9_-]+)\{([^}]*)\}/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(css))) {
    const c = x[2].match(/(?:^|;)color:(#[0-9a-fA-F]{3,8})/);
    if (c) m.set(x[1], c[1].toLowerCase());
  }
  return m;
}

export function parseSections(html: string): FlowSection[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const css = Array.from(doc.querySelectorAll("style")).map((s) => s.textContent || "").join("\n");
  const col = colours(css);
  const colourOf = (el: Element) => {
    const span = Array.from(el.querySelectorAll("span")).find((s) => clean(s.textContent || ""));
    for (const e of [span, el]) {
      if (!e) continue;
      for (const c of Array.from(e.classList)) { const v = col.get(c); if (v) return v; }
    }
    return "";
  };
  const out: FlowSection[] = [{ title: "", rows: [] }];
  // which list the part's arguments are in: a different list (the other side's, its own numbering) is a part of its own
  let partList = "";
  const counter = new Map<string, number>();
  const cur = () => out[out.length - 1];
  const list = (el: Element) => {
    const m = (el.getAttribute("class") || "").match(/(lst-kix_[A-Za-z0-9_]+)-(\d+)/);
    const id = m ? m[1] : "list", depth = m ? +m[2] : 0;
    const items = Array.from(el.querySelectorAll(":scope > li"));
    if (depth === 0) {
      if (partList && id !== partList && cur().rows.length) out.push({ title: "", rows: [] });
      partList = id;
      let n = el.hasAttribute("start") ? +(el.getAttribute("start") || 1) - 1 : counter.get(id) || 0;
      items.forEach((li) => {
        const t = clean(li.textContent || "");
        if (!t) return;
        n++;
        cur().rows.push({ n, arg: t, color: colourOf(li), responses: [] });
      });
      counter.set(id, n);
    } else {
      // a response: under the last argument
      const rows = cur().rows, last = rows[rows.length - 1];
      items.forEach((li) => { const t = clean(li.textContent || ""); if (t && last) last.responses.push(t); });
    }
  };
  const walk = (el: Element) => {
    const tag = el.tagName;
    if (tag === "OL" || tag === "UL") { list(el); return; }
    if (tag === "P" || /^H[1-6]$/.test(tag)) {
      const t = clean(el.textContent || "");
      if (!t) return;
      // a plain line between the lists starts a new part
      if (cur().rows.length || cur().title) out.push({ title: t, rows: [] });
      else cur().title = t;
      partList = "";
      return;
    }
    if (tag === "TABLE") return;
    Array.from(el.children).forEach(walk);
  };
  Array.from(doc.body.children).forEach(walk);
  return out.filter((s) => s.rows.length || s.title);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The flow back as a Google Doc takes it: each part's title as a line, its
 * arguments a numbered list continuing where the last one stopped, each
 * argument's responses lettered under it — the colours as they were.
 */
export function toDocsHtml(sections: { title: string; rows: { n: number; arg: string; color: string; responses: string[] }[] }[]): { html: string; text: string } {
  let html = "", text = "";
  for (const s of sections) {
    if (s.title) { html += `<p>${esc(s.title)}</p>`; text += s.title + "\n"; }
    if (!s.rows.length) continue;
    html += `<ol start="${s.rows[0].n}" style="list-style-type:decimal">`;
    for (const r of s.rows) {
      const c = r.color ? ` style="color:${r.color}"` : "";
      html += `<li${c}><span${c}>${esc(r.arg)}</span>`;
      text += `${r.n}. ${r.arg}\n`;
      const rs = r.responses.filter((x) => x.trim());
      if (rs.length) {
        html += `<ol style="list-style-type:lower-alpha">` + rs.map((x) => `<li><span style="color:#000000">${esc(x)}</span></li>`).join("") + `</ol>`;
        rs.forEach((x, i) => { text += `    ${String.fromCharCode(97 + (i % 26))}. ${x}\n`; });
      }
      html += `</li>`;
    }
    html += `</ol><p></p>`;
    text += "\n";
  }
  return { html: `<meta charset="utf-8">${html}`, text };
}
