/**
 * The speech doc, sent into your partner's Google Doc: a tab called "speech doc", and inside it a tab
 * called "(rhetoric speech doc)" with the same doc verbatimised — what you'll read. Each send replaces
 * what those tabs had; the tabs are made the first time (the Google Docs check showed tabs, and tabs
 * inside tabs, can be added). It keeps what makes a cut file a cut file: Verbatim's heading sizes,
 * centring and the pocket's box, and every run's bold, italics, underline, size, font, colour and
 * highlighting.
 */

import type { Node as PMNode } from "prosemirror-model";
import { schema } from "./evidence/docSchema";
import { readHighlight } from "./cutter/reference";
import { getToken } from "./gdocsApi";

async function call(path: string, init: RequestInit = {}) {
  const t = await getToken(false);
  const r = await fetch("https://docs.googleapis.com/v1/" + path, { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + t, "Content-Type": "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 403 ? "Your Google account can't edit that Doc" : (j?.error?.message || `Google said ${r.status}`));
  return j;
}
const batch = (id: string, requests: any[]) => call(`documents/${id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });

interface Run { text: string; b?: boolean; i?: boolean; u?: boolean; s?: boolean; size?: number; font?: string; color?: string; bg?: string }
interface Para { level: number; runs: Run[] }

const M = schema.marks, H = schema.nodes.heading;
const pt = (v: string) => { const m = /([\d.]+)/.exec(v || ""); return m ? +m[1] : undefined; };

function runOf(t: PMNode): Run {
  const r: Run = { text: t.text || "" };
  for (const m of t.marks) {
    if (m.type === M.strong) r.b = true;
    else if (m.type === M.em) r.i = true;
    else if (m.type === M.underline) r.u = true;
    else if (m.type === M.strike) r.s = true;
    else if (m.type === M.highlight) r.bg = m.attrs.color;
    else if (m.type === M.fontSize) r.size = pt(m.attrs.size);
    else if (m.type === M.fontFamily) r.font = m.attrs.font || undefined;
    else if (m.type === M.textColor) r.color = m.attrs.color;
    // the emphasis box has no Docs equivalent on a run: it's bold and underlined already
  }
  return r;
}

/** The speech doc as paragraphs of runs. */
export function speechParas(doc: PMNode): Para[] {
  const out: Para[] = [];
  doc.forEach((n) => {
    if (!n.isTextblock) { out.push({ level: 0, runs: [] }); return; }
    const runs: Run[] = [];
    n.forEach((c) => { if (c.isText && c.text) runs.push(runOf(c)); });
    out.push({ level: n.type === H ? n.attrs.level : 0, runs });
  });
  return out;
}

/**
 * Verbatimised, as the Verbatimise view reads it: headings as they are; in a card, its cite whole and
 * its text down to what is highlighted (a paragraph with none goes), a space where unread words stood
 * between two read ones; anything not in a card as it is.
 */
export function verbatimParas(doc: PMNode): Para[] {
  const out: Para[] = [];
  let inCard = false, citeNext = false;
  doc.forEach((n) => {
    if (n.type === H) { inCard = n.attrs.level === 4; citeNext = inCard; out.push(speechParas(schema.node("doc", null, [n]))[0]); return; }
    if (!n.isTextblock) return;
    if (!inCard) { out.push(speechParas(schema.node("doc", null, [n]))[0]); return; }
    if (citeNext && n.textContent.trim()) { citeNext = false; out.push(speechParas(schema.node("doc", null, [n]))[0]); return; }
    const runs: Run[] = [];
    let gap = false;
    n.forEach((c) => {
      if (!c.isText || !c.text) return;
      if (readHighlight(c)) {
        const r = runOf(c);
        const last = runs[runs.length - 1];
        if (gap && last && !/\s$/.test(last.text) && !/^\s/.test(r.text)) runs.push({ text: " " });
        runs.push(r);
        gap = false;
      } else gap = true;
    });
    if (runs.some((r) => r.text.trim())) out.push({ level: 0, runs });
  });
  return out;
}

/** A colour as Docs takes it, from how the page keeps it: "#00ff00", "#0f0" or "rgb(0, 255, 0)". */
const rgb = (c?: string) => {
  const s = (c || "").trim();
  let r: number, g: number, b: number;
  const fn = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s);
  const hex = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(s);
  if (fn) { r = +fn[1]; g = +fn[2]; b = +fn[3]; }
  else if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((x) => x + x).join("") : hex[1];
    const v = parseInt(h, 16); r = (v >> 16) & 255; g = (v >> 8) & 255; b = v & 255;
  } else return undefined;
  return { color: { rgbColor: { red: r / 255, green: g / 255, blue: b / 255 } } };
};
const SIZE = [11, 26, 22, 16, 13];

/**
 * The requests that fill an empty tab with these paragraphs.
 *
 * In this order, because Google resets a paragraph's text to its named style when the style is set:
 * first every paragraph's style (heading or normal, and the room around it — the .docx export's:
 * 8pt under a paragraph and a tag, 4pt under a block, 12pt over a heading, 1.15 lines), then the
 * text over all of it (Calibri 11, black), then each heading's look, then each run as it was.
 */
function fill(paras: Para[], tabId: string): any[][] {
  const text = paras.map((p) => p.runs.map((r) => r.text.replace(/\n/g, " ")).join("")).join("\n");
  if (!text) return [];
  const range = (a: number, b: number) => ({ startIndex: a, endIndex: b, tabId });
  const first = [{ insertText: { location: { index: 1, tabId }, text } }];
  const paraStyles: any[] = [], headings: any[] = [], runs: any[] = [];
  const PTS = (n: number) => ({ magnitude: n, unit: "PT" });
  let at = 1;
  for (const p of paras) {
    const len = p.runs.reduce((n, r) => n + r.text.replace(/\n/g, " ").length, 0);
    const pr = range(at, at + len + 1);
    const box = p.level === 1 ? Object.fromEntries(["borderTop", "borderBottom", "borderLeft", "borderRight"].map((k) => [k, { color: rgb("#333333"), width: PTS(3), padding: PTS(6), dashStyle: "SOLID" }])) : {};
    paraStyles.push({ updateParagraphStyle: { range: pr, paragraphStyle: {
      namedStyleType: p.level ? "HEADING_" + p.level : "NORMAL_TEXT",
      alignment: p.level && p.level < 4 ? "CENTER" : "START",
      spaceAbove: PTS(p.level ? 12 : 0), spaceBelow: PTS(p.level && p.level < 4 ? 4 : 8), lineSpacing: 115,
      ...box,
    }, fields: "namedStyleType,alignment,spaceAbove,spaceBelow,lineSpacing" + (p.level === 1 ? ",borderTop,borderBottom,borderLeft,borderRight" : "") } });
    if (p.level && len) headings.push({ updateTextStyle: { range: range(at, at + len), textStyle: { bold: true, italic: false, underline: p.level === 2 || p.level === 3, fontSize: PTS(SIZE[p.level]) }, fields: "bold,italic,underline,fontSize" } });
    let r0 = at;
    for (const r of p.runs) {
      const n = r.text.replace(/\n/g, " ").length;
      const ts: any = {}, f: string[] = [];
      if (r.b) { ts.bold = true; f.push("bold"); }
      if (r.i) { ts.italic = true; f.push("italic"); }
      if (r.u) { ts.underline = true; f.push("underline"); }
      if (r.s) { ts.strikethrough = true; f.push("strikethrough"); }
      if (r.size) { ts.fontSize = PTS(r.size); f.push("fontSize"); }
      if (r.font) { ts.weightedFontFamily = { fontFamily: r.font.split(",")[0].replace(/["']/g, "").trim() }; f.push("weightedFontFamily"); }
      const fg = rgb(r.color); if (fg) { ts.foregroundColor = fg; f.push("foregroundColor"); }
      const bg = rgb(r.bg); if (bg) { ts.backgroundColor = bg; f.push("backgroundColor"); }
      if (n && f.length) runs.push({ updateTextStyle: { range: range(r0, r0 + n), textStyle: ts, fields: f.join(",") } });
      r0 += n;
    }
    at += len + 1;
  }
  const base = { updateTextStyle: { range: range(1, 1 + text.length), textStyle: { weightedFontFamily: { fontFamily: "Calibri" }, fontSize: PTS(11), foregroundColor: rgb("#000000"), bold: false, italic: false, underline: false }, fields: "weightedFontFamily,fontSize,foregroundColor,bold,italic,underline" } };
  const style = [...paraStyles, base, ...headings, ...runs];
  const chunks: any[][] = [first];
  for (let i = 0; i < style.length; i += 400) chunks.push(style.slice(i, i + 400));
  return chunks;
}

function find(tabs: any[], want: (t: any) => boolean): any {
  for (const t of tabs || []) { if (want(t)) return t; const k = find(t.childTabs || [], want); if (k) return k; }
  return null;
}
const titled = (name: string) => (t: any) => (t.tabProperties?.title || "").trim().toLowerCase() === name;

/** An empty tab: the one called `title` (under `parent`, if given), emptied — or a new one. */
async function emptyTab(docId: string, title: string, parent?: string): Promise<string> {
  const d = await call(`documents/${docId}?includeTabsContent=true`);
  const pool = parent ? (find(d.tabs, (t) => t.tabProperties?.tabId === parent)?.childTabs || []) : d.tabs;
  const have = (pool || []).find(titled(title.toLowerCase()));
  if (!have) {
    const r = await batch(docId, [{ addDocumentTab: { tabProperties: { title, ...(parent ? { parentTabId: parent } : {}) } } }]);
    return r.replies[0].addDocumentTab.tabProperties.tabId;
  }
  const content = have.documentTab?.body?.content || [];
  const end = content.length ? content[content.length - 1].endIndex : 2;
  const id = have.tabProperties.tabId;
  if (end > 2) await batch(docId, [{ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId: id } } }]);
  return id;
}

export async function sendSpeechDoc(docId: string, doc: PMNode): Promise<{ url: string }> {
  const speech = await emptyTab(docId, "speech doc");
  for (const c of fill(speechParas(doc), speech)) await batch(docId, c);
  const rhet = await emptyTab(docId, "(rhetoric speech doc)", speech);
  for (const c of fill(verbatimParas(doc), rhet)) await batch(docId, c);
  return { url: `https://docs.google.com/document/d/${docId}/edit?tab=${speech}` };
}
