import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../evidence/docSchema";
import { shortCite } from "./reference";

/**
 * Cites, rewritten into one shape — the cite format set under Keys, written
 * the way cite tools write theirs:
 *
 *   %author% %y%. "%title%". %date%. %url%. elimafia 🕵
 *
 * gives
 *
 *   Raymond **Anneborg ‘24.** "Title". 2024. https://…. elimafia 🕵
 *
 * from the bracketed kind a lot of files carry, whichever order its parts
 * come in —
 *
 *   **Olech 26** [Title, "Defence24," 2-19-2026, https://…, Aleksander Olech is …//Spence]
 *   **Anneborg ‘24** [Raymond Anneborg independent researcher …, 2024, No Publication, https://…, 7-10-2026] // kai
 *
 * The surname and year are bold at 13pt (with the stop after them), the rest
 * at the body's size. A part the cite does not have goes, with its quotes and
 * the stop after it. %quals%, %publication% and %accessed% can be put in the
 * format too. Only a cite that looks like the bracketed kind is touched, and
 * only when enough of it can be read — otherwise it is left as it was.
 */

const M = schema.marks;
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";
const DATE_SRC = `(?:\\d{1,2}[-/.](?:\\d{1,2}|xx)[-/.]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|(?:${MONTHS})\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}|\\d{1,2} (?:${MONTHS}) \\d{4}|(?:${MONTHS}) \\d{4}|(?:19|20)\\d{2})`;
/** A piece of a cite that is a date and nothing else. */
const DATE_PIECE = new RegExp(`^(?:on\\s+|published\\s+)?${DATE_SRC}$`, "i");
const CREDENTIAL = /\b(professor|director|fellow|lecturer|researcher|editor|analyst|senior|former|ph\.?\s?d|graduate|associate|chair|dean|journalist|correspondent|writer|reporter|advis[eo]r|scholar|student|candidate|master|j\.?d\b|m\.?a\b|holds|founder|president|ceo|head of|member of|served|works? (?:at|as|for)|teaches|expert|specialist|historian|economist|scientist|engineer|officer|ambassador|secretary|minister|consultant)\b/i;
const URL_MARK = "\u0001";

export const DEFAULT_CITE_FORMAT = `%author% %y%. "%title%". %date%. %url%. elimafia 🕵`;

/** Is this a cite of the bracketed kind — the one worth rewriting? */
export function looksMessy(cite: PMNode, short: string): boolean {
  const text = cite.textContent;
  const after = text.slice(text.indexOf(short) + short.length);
  if (/^\s*[,.:]?\s*[[(]/.test(after)) return true;                  // "Olech 26 [ …"
  if (/(?<!:)\/\/[^/]{0,40}$/.test(text.trim())) return true;           // "…//Spence]", "…] // kai"
  // most of it shrunk: the details were set small under a big short cite
  let small = 0, all = 0;
  cite.forEach((t) => {
    if (!t.isText) return;
    all += t.text!.length;
    if (t.marks.some((m) => m.type === M.fontSize && parseFloat(m.attrs.size) < 11)) small += t.text!.length;
  });
  return all > 0 && small / all > 0.5;
}

/** The short cite's name and its year: "Anneborg ‘24" → Anneborg, ‘24. */
export function splitShort(short: string): { name: string; y: string } {
  const s = short.trim().replace(/[.,;:]+$/, "");
  const m = /^(.*?)[\s,]*(['‘’]?\d{2}(?:\d{2})?)$/.exec(s);
  return m && m[1] ? { name: m[1].trim(), y: m[2] } : { name: s, y: "" };
}

interface Piece { text: string; start: number; end: number }

/** Split on commas not inside quotes, and at a stop before a number ("Philosophy. 2024"). */
function pieces(s: string): Piece[] {
  const out: Piece[] = [];
  let start = 0, q = "";
  const push = (end: number, next: number) => { out.push({ text: s.slice(start, end), start, end }); start = next; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if ((q === "“" && ch === "”") || (q === '"' && ch === '"')) { q = ""; if (s[i - 1] === ",") push(i + 1, i + 1); }   // "Defence24," 2-19-2026
      continue;
    }
    if (ch === URL_MARK) { push(i, i); push(i + 1, i + 1); continue; }
    if (ch === "“" || (ch === '"' && /(^|[\s,([])$/.test(s.slice(0, i)))) { q = ch; continue; }
    if (ch === ",") { push(i, i + 1); continue; }
    if (ch === "." && /^\s+\d/.test(s.slice(i + 1)) && !/\d$/.test(s.slice(0, i))) { push(i + 1, i + 1); continue; }
  }
  push(s.length, s.length);
  return out.filter((p) => p.text.trim() && !/^[\s.,;:]+$/.test(p.text));
}

/** Quotes off only when they wrap the whole piece — a title can end in a quote of its own. */
const unquote = (s: string) => {
  let t = s.trim().replace(/[,;:]+$/, "");
  if (/^[“"]/.test(t) && /[”"][,.;:]*$/.test(t) && (t.match(/["“”]/g) || []).length === 2) t = t.replace(/[,.;:]+$/, "").slice(1, -1);
  return t.replace(/[,;:]+$/, "").trim();
};
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const bare = (s: string) => s.trim().replace(/^[\s,.;:]+|[\s,.;:]+$/g, "");

export interface CiteParts { first: string; short: string; quals: string; title: string; date: string; pub: string; url: string; doa: string; credit: string }

/** The parts of a bracketed cite, as well as they can be read. */
export function readCite(text: string, short: string): CiteParts | null {
  const at = text.indexOf(short);
  if (at < 0) return null;
  let first = text.slice(0, at).trim().replace(/[,.]$/, "");
  if (words(first) > 3) first = "";
  let rest = text.slice(at + short.length).replace(/^[\s.,:;]+/, "");

  // the cutter's credit, "//Spence" — inside the bracket or after it (not a link's "https://")
  let credit = "";
  const cm = /(?<!:)\/\/\s*([^/]*?)\s*$/.exec(rest);
  if (cm) { credit = cm[1].replace(/[\])]+$/, "").trim(); rest = rest.slice(0, cm.index); }
  rest = rest.trim();
  if (/^[[(]/.test(rest)) rest = rest.slice(1).replace(/[\])]\s*[.,]?\s*$/, "");

  let url = "";
  const um = /https?:\/\/[^\s\]]+/.exec(rest);
  if (um) { url = um[0].replace(/[.,;)\]]+$/, ""); rest = rest.slice(0, um.index) + URL_MARK + rest.slice(um.index + um[0].length); }

  let doa = "";
  const dm = /\b(?:DOA|accessed(?:\s+on)?|retrieved)[:\s]+(\S+(?:\s\d{1,2},?\s\d{4})?)/i.exec(rest);
  if (dm) { doa = dm[1].replace(/[.,;]+$/, ""); rest = rest.slice(0, dm.index) + rest.slice(dm.index + dm[0].length); }

  const all = pieces(rest);

  // the qualifications: from the author's own name ("Aleksander Olech is …", "Raymond Anneborg independent …"),
  // or the first piece that reads like a credential — and on, until a date, a quoted title or the link
  const surname = splitShort(short).name.split(/\s+/).pop() || "";
  const named = surname ? new RegExp(`((?:[A-Z][\\w.'’-]*\\s+){0,3})${surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b(?:\\s+is\\s+(?:an?\\s+|the\\s+)?|,\\s*)?`).exec(rest) : null;
  let qFrom = -1;
  if (named) {
    if (!first && named[1].trim()) first = named[1].trim();
    qFrom = named.index + named[0].length;
  } else {
    const c = all.find((p) => CREDENTIAL.test(p.text) && !DATE_PIECE.test(bare(p.text)) && !p.text.includes(URL_MARK));
    if (c) qFrom = c.start;
  }
  const stops = (p: Piece) => p.text.includes(URL_MARK) || DATE_PIECE.test(bare(p.text)) || /^\s*[“"]/.test(p.text);
  const used = new Set<Piece>();
  if (named) for (const p of all) if (p.start >= named.index && p.end <= qFrom) used.add(p);   // "John Smith," alone: the name
  let quals = "";
  if (qFrom >= 0) {
    const k = all.findIndex((p) => p.end > qFrom);
    const got: string[] = [];
    for (let i = k; i >= 0 && i < all.length; i++) {
      const p = all[i];
      if (i > k && stops(p)) break;
      got.push(i === k ? rest.slice(Math.max(qFrom, p.start), p.end) : p.text);
      used.add(p);
    }
    quals = cap(got.map(bare).filter(Boolean).join(", ").replace(/\s+/g, " ").replace(/\.,/g, "."));
  }

  // the rest by what each piece is: the link, dates (the one after the link is when it was read), the title, the publication
  let title = "", pub = "", date = "", seenUrl = false;
  for (const p of all) {
    if (used.has(p)) continue;
    if (p.text.includes(URL_MARK)) { seenUrl = true; continue; }
    const s = bare(p.text.replace(/\s+/g, " "));
    if (!s) continue;
    if (DATE_PIECE.test(s)) {
      if (seenUrl && !doa) doa = s;
      else if (!date) date = s;
      else if (!doa) doa = s;
      continue;
    }
    const u = unquote(s);
    if (/^[“"]/.test(s) && !title && words(u) >= 2) { title = u; continue; }
    if (!title && words(u) >= 3) { title = u; continue; }
    if (!pub && words(u) <= 6 && /[A-Za-z]/.test(u)) { pub = u; continue; }
  }
  if (/^no publication$/i.test(pub)) pub = "";
  if (!url && !date) return null;                    // too little read to rewrite it safely
  if (!title && !quals) return null;
  return { first, short, quals, title, date, pub, url, doa, credit };
}

/** Text between the cite's parts, tidied: no space before a stop, no stop twice. */
const tidy = (s: string) => s.replace(/\s+([.,;:])/g, "$1").replace(/([.,;:])[.,;:]+/g, "$1").replace(/\s{2,}/g, " ");

/** The cite as a paragraph, in the cite format: the surname and year bold at 13pt, the rest at the body's size. */
export function writeCite(p: CiteParts, format: string): PMNode {
  const { name, y } = splitShort(p.short);
  const values: Record<string, string> = {
    title: p.title ? p.title.replace(/"/g, "“").replace(/“([^“]*)“/g, "“$1”") : "",
    date: p.date, url: p.url, quals: p.quals, publication: p.pub, pub: p.pub,
    accessed: p.doa, doa: p.doa, credit: p.credit, first: p.first,
  };
  // a part the cite does not have goes, with its quotes, the word before it and the stop after it
  const f = (format.trim() || DEFAULT_CITE_FORMAT).replace(/(?:\b(?:accessed|DOA)\s+)?(["“]?)%(\w+)%(["”]?)([.,;:]?)\s*/gi,
    (whole, _q, key: string) => { const k = key.toLowerCase(); return k in values && !values[k] ? "" : whole; });
  let before = "", bold = "", after = "", where: "before" | "bold" | "after" = "before";
  const put = (s: string) => { if (where === "before") before += s; else if (where === "bold") bold += s; else after += s; };
  const parts = f.split(/%(\w+)%/);
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      if (where === "bold") {
        if (/^\s*$/.test(part) && parts[i + 1]?.toLowerCase() === "y") { bold += part; return; }   // "Anneborg ‘24"
        const stop = /^[.,]?/.exec(part)![0];                       // the stop straight after the year is bold too
        bold += stop; part = part.slice(stop.length); where = "after";
      }
      put(part); return;
    }
    const k = part.toLowerCase();
    if (k === "author") { if (p.first) put(p.first + " "); if (where === "before") { where = "bold"; bold += name; } else put(name); return; }
    if (k === "y") { if (where === "before") where = "bold"; put(y); return; }
    put(k in values ? values[k] : `%${part}%`);
  });
  const kids: PMNode[] = [];
  const b = tidy(before), s = tidy(bold).trim(), a = tidy(after).trimEnd();
  if (b.trim()) kids.push(schema.text(b));
  if (s) kids.push(schema.text(s, [M.strong.create(), M.fontSize.create({ size: "13pt" })]));
  if (a.trim()) kids.push(schema.text((s && !/^[\s.,;:]/.test(a) ? " " : "") + a.replace(/^\s+/, " ")));
  return schema.nodes.paragraph.create(null, kids);
}

/** A cite rewritten, or null to leave it as it is. */
export function rewriteCite(cite: PMNode, format: string): PMNode | null {
  const short = shortCite(cite);
  if (!short || !looksMessy(cite, short)) return null;
  const parts = readCite(cite.textContent, short);
  return parts ? writeCite(parts, format) : null;
}
