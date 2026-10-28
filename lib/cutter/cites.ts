import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../evidence/docSchema";
import { shortCite } from "./reference";

/**
 * Cites, rewritten into one shape:
 *
 *   Aleksander **Olech 26.** Lecturer at …, Former Deputy Director of ….
 *   "Poland's road to the atomic bomb: “5–10 Years to a warhead”". 2-19-2026.
 *   Defence24. https://defence24.com/…. elimafia 🕵
 *
 * from the bracketed kind a lot of files carry —
 *
 *   **Olech 26** [Poland's road …, "Defence24," 2-19-2026, https://…,
 *   Aleksander Olech is Head of … . Lecturer at …//Spence]
 *
 * First name before the short cite (bold, 13pt), then the qualifications,
 * the title in quotes, the date, the publication, the link, an access date
 * if there was one, and the signature. Only a cite that looks like the
 * bracketed kind is touched, and only when enough of it can be read —
 * otherwise it is left exactly as it was.
 */

const M = schema.marks;
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";
const DATE = new RegExp(
  `\\b(?:\\d{1,2}[-/.](?:\\d{1,2}|xx)[-/.]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|(?:${MONTHS})\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}|\\d{1,2} (?:${MONTHS}) \\d{4}|(?:${MONTHS}) \\d{4})\\b`, "i");
const CREDENTIAL = /\b(professor|director|fellow|lecturer|researcher|editor|analyst|senior|former|ph\.?\s?d|graduate|associate|chair|dean|journalist|correspondent|writer|reporter|advis[eo]r|scholar|student|candidate|master|j\.?d\b|m\.?a\b|holds|founder|president|ceo|head of|member of|served|works? (?:at|as|for)|teaches|expert|specialist|historian|economist|scientist|engineer|officer|ambassador|secretary|minister|consultant)\b/i;

/** Is this a cite of the bracketed kind — the one worth rewriting? */
export function looksMessy(cite: PMNode, short: string): boolean {
  const text = cite.textContent;
  const after = text.slice(text.indexOf(short) + short.length);
  if (/^\s*[,.:]?\s*[[(]/.test(after)) return true;                  // "Olech 26 [ …"
  if (/\/\/\s*\S+\s*[\])]?\s*$/.test(text)) return true;              // "…//Spence]"
  // most of it shrunk: the details were set small under a big short cite
  let small = 0, all = 0;
  cite.forEach((t) => {
    if (!t.isText) return;
    all += t.text!.length;
    if (t.marks.some((m) => m.type === M.fontSize && parseFloat(m.attrs.size) < 11)) small += t.text!.length;
  });
  return all > 0 && small / all > 0.5;
}

/** Split on commas that are not inside quotes. */
function segments(s: string): string[] {
  const out: string[] = [];
  let cur = "", q = "";
  for (const ch of s) {
    if (q) { cur += ch; if ((q === "“" && ch === "”") || (q === '"' && ch === '"')) q = ""; continue; }
    if (ch === "“" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === ",") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x && !/^[.,;:]+$/.test(x));
}

/** Quotes off only when they wrap the whole piece — a title can end in a quote of its own. */
const unquote = (s: string) => {
  let t = s.trim().replace(/[,;:]+$/, "");
  if (/^[“"]/.test(t) && /[”"][,.;:]*$/.test(t) && (t.match(/["“”]/g) || []).length === 2) t = t.replace(/[,.;:]+$/, "").slice(1, -1);
  return t.replace(/[,;:]+$/, "").trim();
};
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const end = (s: string) => (/[.!?]["”]?$/.test(s) ? s : s + ".");

export interface CiteParts { first: string; short: string; quals: string; title: string; date: string; pub: string; url: string; doa: string; credit: string }

/** The parts of a bracketed cite, as well as they can be read. */
export function readCite(text: string, short: string): CiteParts | null {
  const at = text.indexOf(short);
  if (at < 0) return null;
  let first = text.slice(0, at).trim().replace(/[,.]$/, "");
  if (words(first) > 3) first = "";
  let rest = text.slice(at + short.length).replace(/^[\s.,:;]+/, "");
  const br = /^[[(]([\s\S]*)[\])]\s*\.?\s*$/.exec(rest);
  if (br) rest = br[1];

  let credit = "";
  const cm = /\/\/\s*([^/]*?)\s*$/.exec(rest);
  if (cm) { credit = cm[1].replace(/[\])]+$/, "").trim(); rest = rest.slice(0, cm.index); }

  let url = "";
  const um = /https?:\/\/[^\s\]]+/.exec(rest);
  if (um) { url = um[0].replace(/[.,;)\]]+$/, ""); rest = rest.replace(um[0], " "); }

  let doa = "";
  const dm = /\b(?:DOA|accessed)[:\s]+(\S+(?:\s\d{1,2},?\s\d{4})?)/i.exec(rest);
  if (dm) { doa = dm[1].replace(/[.,;]+$/, ""); rest = rest.replace(dm[0], " "); }

  let date = "";
  const da = DATE.exec(rest);
  if (da) { date = da[0]; rest = rest.slice(0, da.index) + " " + rest.slice(da.index + da[0].length); }

  // the qualifications: from the author's own name ("Aleksander Olech is …"), or the first credential
  const surname = short.replace(/['’]?\d{2,4}\b.*$/, "").trim().split(/\s+/).pop() || "";
  let quals = "";
  const named = surname ? new RegExp(`((?:[A-Z][\\w.'’-]*\\s+){0,3})${surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b(?:\\s+is\\s+(?:an?\\s+|the\\s+)?|,\\s*)?`).exec(rest) : null;
  let cut = -1;
  if (named) {
    if (!first && named[1].trim()) first = named[1].trim();
    cut = named.index;
    quals = rest.slice(named.index + named[0].length);
  } else {
    const sentences = rest.split(/(?<=[.;])\s+|,\s+(?=[A-Z])/);
    let pos = 0;
    for (const s of sentences) {
      const i = rest.indexOf(s, pos);
      if (CREDENTIAL.test(s)) { cut = i; quals = rest.slice(i); break; }
      pos = i + s.length;
    }
  }
  const head = cut >= 0 ? rest.slice(0, cut) : rest;
  quals = cap(quals.replace(/\s+/g, " ").replace(/^[\s,.;:]+|[\s,;:]+$/g, "").trim());

  // what is left before them: the title (the first long piece) and the publication (a short one)
  let title = "", pub = "";
  for (const seg of segments(head)) {
    const s = seg.replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (!title && words(unquote(s)) >= 3) { title = unquote(s); continue; }
    if (!pub && words(unquote(s)) <= 6 && /[A-Za-z]/.test(s)) { pub = unquote(s); continue; }
  }
  if (!url && !date) return null;                    // too little read to rewrite it safely
  if (!title && !quals) return null;
  return { first, short, quals, title, date, pub, url, doa, credit };
}

/** The cite as a paragraph: first name, the short cite bold at 13pt, then the rest at the body's size. */
export function writeCite(p: CiteParts, signature: string): PMNode {
  const tail = [
    p.quals ? end(p.quals) : "",
    p.title ? `"${p.title.replace(/"/g, "“").replace(/“([^“]*)“/g, "“$1”")}".` : "",
    p.date ? end(p.date) : "",
    p.pub ? end(p.pub) : "",
    p.url ? end(p.url) : "",
    p.doa ? `DOA ${end(p.doa)}` : "",
    (signature || p.credit || "").trim(),
  ].filter(Boolean).join(" ");
  const shortText = p.short.replace(/[.,]$/, "") + ".";
  const kids: PMNode[] = [];
  if (p.first) kids.push(schema.text(p.first + " "));
  kids.push(schema.text(shortText, [M.strong.create(), M.fontSize.create({ size: "13pt" })]));
  if (tail) kids.push(schema.text(" " + tail));
  return schema.nodes.paragraph.create(null, kids);
}

/** A cite rewritten, or null to leave it as it is. */
export function rewriteCite(cite: PMNode, signature: string): PMNode | null {
  const short = shortCite(cite);
  if (!short || !looksMessy(cite, short)) return null;
  const parts = readCite(cite.textContent, short);
  return parts ? writeCite(parts, signature) : null;
}
