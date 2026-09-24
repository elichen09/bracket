import { readDoc, sanitize } from "../viewer/doc";

/**
 * The other team's case, as the lines of a flow.
 *
 * A case off SpeechDrop is a Verbatim document: the pocket says whose case it
 * is, the contentions are headings under it, and every card is a tag — the
 * lowest heading — with the evidence under it. What a flow needs is the
 * shape without the evidence: each contention, and the tags under it, in
 * order. So the document is laid out off screen (a .docx the way the Doc
 * viewer does it), its headings read, and the tags grouped under whatever
 * heading sits one level above them.
 */

export interface CasePart { section: string | null; tags: string[] }
export interface CaseRead { parts: CasePart[]; tags: number }

const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 400);

export async function readCase(blob: Blob, name: string): Promise<CaseRead> {
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-100000px;top:0;width:820px;visibility:hidden;pointer-events:none";
  document.body.appendChild(holder);
  try {
    const n = name.toLowerCase();
    if (n.endsWith(".docx") || blob.type.includes("wordprocessingml")) {
      const { renderAsync } = await import("docx-preview");
      await renderAsync(blob, holder, holder, {
        inWrapper: false, ignoreWidth: true, ignoreHeight: true, breakPages: false,
        renderHeaders: false, renderFooters: false, renderFootnotes: false, renderEndnotes: false, className: "docx",
      });
    } else if (n.endsWith(".html") || n.endsWith(".htm") || blob.type.includes("html")) {
      holder.innerHTML = sanitize(await blob.text());
    } else {
      throw new Error("only a .docx or a web page has headings to read");
    }
    const heads = readDoc(holder);
    if (!heads.length) return { parts: [], tags: 0 };

    // Tags are Heading 4 in Verbatim; a doc that never goes that deep uses its
    // deepest heading for them. The contentions are the level just above.
    const levels = Array.from(new Set(heads.map((h) => h.level))).sort((a, b) => a - b);
    const tagLevel = levels.includes(4) ? 4 : levels[levels.length - 1];
    const above = levels.filter((l) => l < tagLevel);
    const sectionLevel = above.length ? above[above.length - 1] : null;

    const parts: CasePart[] = [];
    let cur: CasePart | null = null;
    for (const h of heads) {
      if (h.level === sectionLevel) { cur = { section: clean(h.text), tags: [] }; parts.push(cur); continue; }
      if (h.level !== tagLevel) continue;
      if (!cur) { cur = { section: null, tags: [] }; parts.push(cur); }
      cur.tags.push(clean(h.text));
    }
    const kept = parts.filter((p) => p.tags.length);
    return { parts: kept, tags: kept.reduce((n, p) => n + p.tags.length, 0) };
  } finally {
    holder.remove();
  }
}
