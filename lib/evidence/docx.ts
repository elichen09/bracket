/**
 * The document as a .docx.
 *
 * The clipboard cannot carry a page break into Google Docs — it discards them
 * and keeps the rule they were written as — so a document that has to break
 * where it is told has to arrive as a file. A .docx also carries the cover's
 * box, which is a paragraph border rather than anything a paste preserves.
 *
 * The shape written here is the one a cut file has: Verbatim's four heading
 * levels at their own sizes, centred where they are centred, and every run
 * keeping the bold, underline, size, face, colour and highlighting it already
 * had. Word and Docs both open it; Docs keeps the breaks.
 */

import type { Run, Elem } from "./elements";

const PT = 2;                       // docx sizes are half-points
const TWIP = 1440;                  // per inch

/** "#ffff00" -> "FFFF00", which is how OOXML wants a colour. */
const hex = (c?: string | null) => (c ? String(c).replace(/^#/, "").toUpperCase() : undefined);

/** The style each heading level carries in a block file. */
const LEVEL = [
  null,
  { size: 26, centre: true, box: true, underline: false },   // pocket
  { size: 22, centre: true, box: false, underline: "double" },
  { size: 16, centre: true, box: false, underline: "single" },
  { size: 13, centre: false, box: false, underline: false },  // tag
] as const;

export async function downloadDocx(elements: Elem[], name: string) {
  const stage = (s: string) => { (window as any).__docxStage = s; };
  stage("importing");
  const {
    Document, Packer, Paragraph, TextRun, PageBreak, HeadingLevel,
    AlignmentType, BorderStyle, ShadingType, UnderlineType,
  } = await import("docx");
  stage("imported");

  const heading = [undefined, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
  const level = (e: Elem) => ({ H1: 1, H2: 2, H3: 3, H4: 4 } as Record<string, number>)[e.h || ""] || 0;

  const runs = (e: Elem, l: number) => {
    const style = l ? LEVEL[l as 1 | 2 | 3 | 4] : null;
    return (e.runs || []).filter((r: Run) => r.t).map((r: Run) => new TextRun({
      text: r.t,
      bold: !!r.b || !!style,
      italics: !!r.i,
      strike: !!r.s,
      underline: r.u ? { type: UnderlineType.SINGLE }
        : style && style.underline
          ? { type: style.underline === "double" ? UnderlineType.DOUBLE : UnderlineType.SINGLE }
          : undefined,
      size: (r.fs || (style ? style.size : 11)) * PT,
      font: r.ff || "Calibri",
      color: hex(r.fg),
      shading: r.bg ? { type: ShadingType.CLEAR, color: "auto", fill: hex(r.bg) } : undefined,
    }));
  };

  const children: any[] = [];
  (elements || []).forEach((e) => {
    if (e.k === "brk") {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      return;
    }
    const l = level(e);
    const style = l ? LEVEL[l as 1 | 2 | 3 | 4] : null;
    const line = runs(e, l);
    children.push(new Paragraph({
      children: line.length ? line : [new TextRun({ text: "" })],
      heading: l ? heading[l] : undefined,
      alignment: style && style.centre ? AlignmentType.CENTER : undefined,
      border: style && style.box ? {
        top: { style: BorderStyle.SINGLE, size: 18, color: "333333", space: 6 },
        bottom: { style: BorderStyle.SINGLE, size: 18, color: "333333", space: 6 },
        left: { style: BorderStyle.SINGLE, size: 18, color: "333333", space: 6 },
        right: { style: BorderStyle.SINGLE, size: 18, color: "333333", space: 6 },
      } : undefined,
    }));
  });

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: TWIP, bottom: TWIP, left: TWIP, right: TWIP } } },
      children: children.length ? children : [new Paragraph({ children: [] })],
    }],
  });

  stage("packing " + children.length + " paragraphs");
  const blob = await Packer.toBlob(doc);
  stage("packed");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (name || "send doc").replace(/[\\/:*?"<>|]/g, "-") + ".docx";
  // The anchor has to be in the document: a detached one is ignored by some
  // browsers, and by a browser being driven by a test.
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  stage("clicked");
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
  return blob.size;
}
