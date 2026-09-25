/**
 * One card out of a .docx, as HTML the Evidence parser reads — without laying
 * the document out.
 *
 * Opening a caselist card used to mean rendering the whole disclosed document
 * in the browser and reading one card back out of it: seconds, for a few
 * paragraphs. This goes to the XML instead. It finds the Heading 4 whose text
 * matches the tag, takes the paragraphs under it until the next heading, and
 * writes each run with its look — bold, italic, underline, highlight, size —
 * resolved from the run, its character style and its paragraph style, the
 * way Word would. The block heading above it (Heading 3) comes along, for a
 * send that includes it.
 *
 * Plain JavaScript on purpose: it runs in the API route, and in the weekly
 * indexer if the index ever carries bodies.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const HIGHLIGHT = {
  yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff", blue: "#0000ff", red: "#ff0000",
  darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000",
  darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0", black: "#000000",
};

/** A run-properties block, as the parts that matter here. */
function props(rPr) {
  const p = {};
  if (!rPr) return p;
  const on = (tag) => {
    const m = rPr.match(new RegExp("<w:" + tag + "(?:\\s+w:val=\"([^\"]*)\")?\\s*/>"));
    return m ? !/^(0|false|none)$/i.test(m[1] || "") : undefined;
  };
  const b = on("b"); if (b !== undefined) p.b = b;
  const i = on("i"); if (i !== undefined) p.i = i;
  const u = rPr.match(/<w:u\s+w:val="([^"]*)"/);
  if (u) p.u = !/^none$/i.test(u[1]);
  else if (/<w:u\s*\/>/.test(rPr)) p.u = true;
  const hl = rPr.match(/<w:highlight\s+w:val="([^"]*)"/);
  if (hl) p.bg = hl[1] === "none" ? null : HIGHLIGHT[hl[1]] || null;
  const shd = rPr.match(/<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"/);
  if (shd && p.bg === undefined && shd[1].toLowerCase() !== "ffffff") p.bg = "#" + shd[1];
  const sz = rPr.match(/<w:sz\s+w:val="(\d+)"/);
  if (sz) p.sz = +sz[1] / 2;
  const rs = rPr.match(/<w:rStyle\s+w:val="([^"]+)"/);
  if (rs) p.rStyle = rs[1];
  return p;
}

/** styleId -> { level, rPr (resolved through basedOn) } */
function styleTable(stylesXml) {
  const raw = new Map();
  for (const m of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = (m[1].match(/w:styleId="([^"]+)"/) || [])[1];
    if (!id) continue;
    const body = m[2];
    const name = (body.match(/<w:name w:val="([^"]+)"/) || [])[1] || "";
    const ol = (body.match(/<w:outlineLvl w:val="(\d)"/) || [])[1];
    const h = name.match(/^heading (\d)$/i);
    const v = { pocket: 1, hat: 2, block: 3, tag: 4 }[name.toLowerCase()];
    raw.set(id, {
      level: h ? +h[1] : v || (ol !== undefined ? +ol + 1 : 0),
      based: (body.match(/<w:basedOn w:val="([^"]+)"/) || [])[1],
      rPr: props((body.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1]),
    });
  }
  const done = new Map();
  const get = (id, d = 0) => {
    if (!id || !raw.has(id)) return { level: 0, rPr: {} };
    if (done.has(id)) return done.get(id);
    const s = raw.get(id);
    const up = s.based && d < 10 ? get(s.based, d + 1) : { level: 0, rPr: {} };
    const r = { level: s.level || up.level, rPr: { ...up.rPr, ...s.rPr } };
    done.set(id, r);
    return r;
  };
  const defaults = props(((stylesXml.match(/<w:rPrDefault>([\s\S]*?)<\/w:rPrDefault>/) || [])[1] || "").match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[1]);
  return { get, defaults };
}

function paraHtml(p, table, tag) {
  const pPr = (p.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [])[1] || "";
  const pStyle = (pPr.match(/<w:pStyle w:val="([^"]+)"/) || [])[1];
  const base = { ...table.defaults, ...table.get(pStyle || "Normal").rPr };
  const runs = [];
  for (const r of p.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)) {
    const inner = r[1];
    const own = props((inner.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1]);
    const look = { ...base, ...(own.rStyle ? table.get(own.rStyle).rPr : {}), ...own };
    let text = "";
    for (const t of inner.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)) text += t[1] !== undefined ? unxml(t[1]) : t[0] === "<w:tab/>" ? "\t" : " ";
    if (!text) continue;
    const css = ["font-weight:" + (look.b ? 700 : 400)];
    if (look.i) css.push("font-style:italic");
    if (look.u) css.push("text-decoration:underline");
    if (look.sz) css.push("font-size:" + look.sz + "pt");
    if (look.bg) css.push("background-color:" + look.bg);
    runs.push('<span style="' + css.join(";") + '">' + esc(text) + "</span>");
  }
  return "<" + tag + ">" + (runs.join("") || "<br>") + "</" + tag + ">";
}

/**
 * The card whose tag reads `want`, from a .docx: HTML with its block heading,
 * its tag as <h4>, and its paragraphs — or null if no tag matches.
 */
export async function cardHtml(docx, want) {
  const z = await JSZip.loadAsync(docx);
  const doc = await z.file("word/document.xml")?.async("string");
  if (!doc) return null;
  const table = styleTable((await z.file("word/styles.xml")?.async("string")) || "");
  const paras = doc.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
  const text = (p) => unxml((p.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join("")).replace(/\s+/g, " ").trim();
  const levelOf = (p) => {
    const sid = (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1];
    const ol = (p.match(/<w:outlineLvl w:val="(\d)"/) || [])[1];
    return sid ? table.get(sid).level : ol !== undefined ? +ol + 1 : 0;
  };
  const w = norm(want);
  let at = -1, near = -1, block = -1;
  for (let i = 0; i < paras.length; i++) {
    const l = levelOf(paras[i]);
    if (l !== 4) continue;
    const n = norm(text(paras[i]));
    if (!n) continue;
    if (n === w) { at = i; break; }
    if (near < 0 && (n.startsWith(w.slice(0, 40)) || w.startsWith(n.slice(0, 40)))) near = i;
  }
  if (at < 0) at = near;
  if (at < 0) return null;
  for (let i = at - 1; i >= 0; i--) {
    const l = levelOf(paras[i]);
    if (l && l < 4 && text(paras[i])) { if (l === 3) block = i; break; }
  }
  const out = [];
  if (block >= 0) out.push(paraHtml(paras[block], table, "h3"));
  out.push(paraHtml(paras[at], table, "h4"));
  for (let i = at + 1; i < paras.length; i++) {
    const l = levelOf(paras[i]);
    if (l && l <= 4 && text(paras[i])) break;
    out.push(paraHtml(paras[i], table, "p"));
  }
  return out.join("");
}
