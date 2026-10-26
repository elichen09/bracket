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
const SPACE_AFTER = 120;            // 6pt under a paragraph
const SPACE_BEFORE_HEAD = 240;      // 12pt over a heading

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

/** The file itself, for saving or for sending somewhere. */
export async function buildDocx(elements: Elem[], name: string): Promise<{ blob: Blob; filename: string }> {
  const stage = (s: string) => { (window as any).__docxStage = s; };
  stage("importing");
  const {
    Document, Packer, Paragraph, TextRun, PageBreak, HeadingLevel,
    AlignmentType, BorderStyle, ShadingType, UnderlineType, PageOrientation,
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
      // black unless the text has a colour of its own — never the heading style's blue
      color: hex(r.fg) || "000000",
      shading: r.bg ? { type: ShadingType.CLEAR, color: "auto", fill: hex(r.bg) } : undefined,
      border: r.bx ? { style: BorderStyle.SINGLE, size: 6, color: "000000", space: 0 } : undefined,
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
      // Room between things, given the way a word processor gives it: spacing
      // on the paragraph rather than blank lines to delete later.
      spacing: { before: l ? SPACE_BEFORE_HEAD : 0, after: l ? 60 : SPACE_AFTER },
      border: style && style.box ? {
        top: { style: BorderStyle.SINGLE, size: 24, color: "333333", space: 8 },
        bottom: { style: BorderStyle.SINGLE, size: 24, color: "333333", space: 8 },
        left: { style: BorderStyle.SINGLE, size: 24, color: "333333", space: 8 },
        right: { style: BorderStyle.SINGLE, size: 24, color: "333333", space: 8 },
      } : undefined,
    }));
  });

  // Word's own Heading 1–4 are blue Calibri Light (Heading 4 italic too), and a
  // paragraph marked as a heading takes whatever the file says those styles
  // are. So the file says: black Calibri, bold, at the cut file's sizes — the
  // headings still work as headings (Navigation pane, outline), they just look
  // like a cut file's.
  const headingStyle = (l: 1 | 2 | 3 | 4) => ({
    run: {
      font: "Calibri", color: "000000", bold: true, italics: false, size: LEVEL[l].size * PT,
      underline: LEVEL[l].underline ? { type: LEVEL[l].underline === "double" ? UnderlineType.DOUBLE : UnderlineType.SINGLE, color: "000000" } : undefined,
    },
    paragraph: {
      alignment: LEVEL[l].centre ? AlignmentType.CENTER : AlignmentType.LEFT,
      spacing: { before: SPACE_BEFORE_HEAD, after: 60 },
    },
  });

  const doc = new Document({
    // the defaults themselves, replaced — not a second set beside them, which Word may ignore
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 11 * PT, color: "000000" } },
        heading1: headingStyle(1), heading2: headingStyle(2), heading3: headingStyle(3), heading4: headingStyle(4),
        // not used here, but black too, for whoever goes on in Word
        heading5: { run: { font: "Calibri", color: "000000", italics: false } },
        heading6: { run: { font: "Calibri", color: "000000", italics: false } },
      },
    },
    sections: [{
      // Word's standard page: US Letter, an inch all round, header and footer at half an
      // inch. Left to itself the library writes A4, which sits oddly in Word and Docs set
      // to Letter — a different width and length, so the margins look wrong.
      properties: {
        page: {
          size: { width: 8.5 * TWIP, height: 11 * TWIP, orientation: PageOrientation.PORTRAIT },
          margin: { top: TWIP, bottom: TWIP, left: TWIP, right: TWIP, header: TWIP / 2, footer: TWIP / 2, gutter: 0 },
        },
      },
      children: children.length ? children : [new Paragraph({ children: [] })],
    }],
  });

  stage("packing " + children.length + " paragraphs");
  const blob = await Packer.toBlob(doc);
  stage("packed");
  return { blob, filename: (name || "send doc").replace(/[\\/:*?"<>|]/g, "-") + ".docx" };
}

/** Save it to disk. */
export async function downloadDocx(elements: Elem[], name: string) {
  const { blob, filename } = await buildDocx(elements, name);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // The anchor has to be in the document: a detached one is ignored by some
  // browsers, and by a browser being driven by a test.
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
  return blob.size;
}
