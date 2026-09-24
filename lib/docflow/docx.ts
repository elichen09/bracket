import type { Node as PMNode, Mark } from "prosemirror-model";
import { schema, HIGHLIGHTS, type Hl } from "./schema";

/**
 * The flow as a Word file, for when it has to be a file — submitted, emailed,
 * or opened in Docs with its numbering intact. Numbering starts again after
 * every box and heading, as a new list does in Docs, which in Word means a
 * new instance of the same list for each section.
 */
export async function flowDocx(doc: PMNode, name: string): Promise<{ blob: Blob; filename: string }> {
  const {
    Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, LevelFormat, UnderlineType,
  } = await import("docx");

  const FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
  const levels = Array.from({ length: 9 }, (_, l) => ({
    level: l,
    format: FORMATS[l % 3],
    text: `%${l + 1}.`,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } },
  }));

  const runs = (n: PMNode, red: boolean, hl: Hl | null, extra: Record<string, unknown> = {}) => {
    const out: InstanceType<typeof TextRun>[] = [];
    n.forEach((t) => {
      const has = (type: unknown) => t.marks.some((m: Mark) => m.type === type);
      const markHl = t.marks.find((m: Mark) => m.type === schema.marks.mark);
      const h = markHl ? (markHl.attrs.hl as Hl) : hl;
      out.push(new TextRun({
        text: t.text || "",
        bold: has(schema.marks.strong) || !!extra.bold,
        italics: has(schema.marks.em),
        underline: has(schema.marks.underline) || extra.underline ? { type: UnderlineType.SINGLE } : undefined,
        strike: has(schema.marks.strike),
        color: red || has(schema.marks.red) ? "FF0000" : undefined,
        highlight: h ? HIGHLIGHTS[h].docx : undefined,
        size: (extra.size as number) || 22,
        font: "Calibri",
      }));
    });
    return out.length ? out : [new TextRun({ text: "" })];
  };

  const children: InstanceType<typeof Paragraph>[] = [];
  let instance = 0;
  let inList = false;
  doc.forEach((n) => {
    if (n.type === schema.nodes.item) {
      if (!inList) { instance++; inList = true; }
      children.push(new Paragraph({
        children: runs(n, n.attrs.who === "them", n.attrs.hl),
        numbering: { reference: "flow", level: Math.min(8, n.attrs.depth), instance },
        spacing: { after: 40 },
      }));
      return;
    }
    inList = false;
    const red = n.attrs && n.attrs.who === "them";
    if (n.type === schema.nodes.box) {
      const edge = { style: BorderStyle.SINGLE, size: 24, color: "000000", space: 6 };
      children.push(new Paragraph({
        children: runs(n, red, null, { bold: true, size: 48 }),
        alignment: AlignmentType.CENTER,
        border: { top: edge, bottom: edge, left: edge, right: edge },
        spacing: { before: 240, after: 200 },
      }));
    } else if (n.type === schema.nodes.head) {
      children.push(new Paragraph({
        children: runs(n, red, null, { bold: true, underline: true, size: 28 }),
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 80 },
      }));
    } else {
      children.push(new Paragraph({ children: runs(n, false, null), spacing: { after: 120 } }));
    }
  });

  const file = new Document({
    numbering: { config: [{ reference: "flow", levels }] },
    sections: [{ properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children }],
  });
  const blob = await Packer.toBlob(file);
  return { blob, filename: (name || "flow").replace(/[\\/:*?"<>|]/g, "-") + ".docx" };
}
