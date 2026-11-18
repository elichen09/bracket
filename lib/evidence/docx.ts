/**
 * The document as a .docx.
 *
 * The clipboard cannot carry a page break into Google Docs — it discards them
 * and keeps the rule they were written as — so a document that has to break
 * where it is told has to arrive as a file.
 *
 * The file is written the way Verbatim writes one, because that is what every
 * debate tool reads a .docx by — Verbatim itself, CardMirror, the caselist's
 * parsers. They don't look at how text is dressed; they look at which STYLE it
 * wears:
 *
 *   - headings: Heading1–4 (Pocket, Hat, Block, Tag)
 *   - a card's cite: the character style Style13ptBold ("Cite")
 *   - underlined card text: StyleUnderline ("Underline")
 *   - underlined and bold (or boxed) card text: Emphasis
 *   - highlighting: Word's own highlighter where the colour is one of its
 *     colours, shading otherwise
 *
 * Text dressed only by hand (bold, a size, a face, a colour on every run) reads
 * there as loose formatting rather than as a card: the tag, cite and card text
 * aren't told apart, and every run carries a face and colour of its own. So the
 * styles are defined once, in styles.xml, and each run names its style and
 * carries only what differs from it.
 */

import type { Run, Elem } from "./elements";

const PT = 2;                       // docx sizes are half-points
const TWIP = 1440;                  // per inch

/** "#ffff00" -> "FFFF00", which is how OOXML wants a colour. */
const hex = (c?: string | null) => (c ? String(c).replace(/^#/, "").toUpperCase() : undefined);

/** Word's highlighter colours, by the colour each one is. */
const HIGHLIGHT: Record<string, string> = {
  FFFF00: "yellow", "00FF00": "green", "00FFFF": "cyan", FF00FF: "magenta", "0000FF": "blue",
  FF0000: "red", "000080": "darkBlue", "008080": "darkCyan", "008000": "darkGreen",
  "800080": "darkMagenta", "800000": "darkRed", "808000": "darkYellow", "808080": "darkGray",
  C0C0C0: "lightGray", "000000": "black",
};

/** The size each style gives its text, in points — a run says its size only when it differs. */
const HEAD_SIZE = [11, 26, 22, 16, 13];
const SIZE = { Normal: 11, Style13ptBold: 13, StyleUnderline: 11, Emphasis: 11 } as const;
type CharStyle = keyof typeof SIZE;

/** Verbatim's styles: the ids and looks its template gives them. */
function stylesXml(): string {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const head = (n: 1 | 2 | 3 | 4, alias: string, ppr: string, rpr: string) => `
<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:aliases w:val="${alias}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="Heading${n}Char"/><w:uiPriority w:val="${n - 1}"/><w:qFormat/>
<w:pPr><w:keepNext/><w:keepLines/>${ppr}<w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/>${rpr}<w:sz w:val="${HEAD_SIZE[n] * PT}"/><w:szCs w:val="${HEAD_SIZE[n] * PT}"/></w:rPr></w:style>
<w:style w:type="character" w:customStyle="1" w:styleId="Heading${n}Char"><w:name w:val="Heading ${n} Char"/><w:basedOn w:val="DefaultParagraphFont"/><w:link w:val="Heading${n}"/><w:uiPriority w:val="${n - 1}"/>
<w:rPr><w:b/><w:bCs/>${rpr}<w:sz w:val="${HEAD_SIZE[n] * PT}"/><w:szCs w:val="${HEAD_SIZE[n] * PT}"/></w:rPr></w:style>`;
  const box = '<w:pBdr><w:top w:val="single" w:sz="24" w:space="1" w:color="auto"/><w:left w:val="single" w:sz="24" w:space="4" w:color="auto"/><w:bottom w:val="single" w:sz="24" w:space="1" w:color="auto"/><w:right w:val="single" w:sz="24" w:space="4" w:color="auto"/></w:pBdr>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsiaTheme="minorEastAsia" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:aliases w:val="Normal/Card"/><w:qFormat/></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>
${head(1, "Pocket", `${box}<w:spacing w:before="480"/><w:jc w:val="center"/>`, "")}
${head(2, "Hat", '<w:spacing w:before="480"/><w:jc w:val="center"/>', '<w:u w:val="double"/>')}
${head(3, "Block", '<w:spacing w:before="200"/><w:jc w:val="center"/>', '<w:u w:val="single"/>')}
${head(4, "Tag", '<w:spacing w:before="200"/>', "")}
<w:style w:type="character" w:customStyle="1" w:styleId="Style13ptBold"><w:name w:val="Style 13 pt Bold"/><w:aliases w:val="Cite"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="6"/><w:qFormat/>
<w:rPr><w:b/><w:bCs/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="character" w:customStyle="1" w:styleId="StyleUnderline"><w:name w:val="Style Underline"/><w:aliases w:val="Underline"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="7"/><w:qFormat/>
<w:rPr><w:sz w:val="22"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Emphasis"><w:name w:val="Emphasis"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="8"/><w:qFormat/>
<w:rPr><w:b/><w:bCs/><w:i w:val="0"/><w:sz w:val="22"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;
}

/** The file itself, for saving or for sending somewhere. */
export async function buildDocx(elements: Elem[], name: string): Promise<{ blob: Blob; filename: string }> {
  const stage = (s: string) => { if (typeof window !== "undefined") (window as any).__docxStage = s; };
  stage("importing");
  const {
    Document, Packer, Paragraph, TextRun, PageBreak, HeadingLevel,
    AlignmentType, BorderStyle, ShadingType, UnderlineType, PageOrientation,
  } = await import("docx");
  stage("imported");

  const heading = [undefined, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
  const level = (e: Elem) => ({ H1: 1, H2: 2, H3: 3, H4: 4 } as Record<string, number>)[e.h || ""] || 0;

  /** The style a run of card text wears. In the cite line, bold is the cite. */
  const styleOf = (r: Run, citeLine: boolean): CharStyle => {
    if (r.u && (r.b || r.bx)) return "Emphasis";
    if (r.u) return "StyleUnderline";
    if (citeLine && r.b) return "Style13ptBold";
    return "Normal";
  };

  const runs = (e: Elem, l: number, citeLine: boolean) => (e.runs || []).filter((r: Run) => r.t).map((r: Run) => {
    const st = l ? null : styleOf(r, citeLine);
    const own = l ? HEAD_SIZE[l] : SIZE[st!];
    const bg = hex(r.bg);
    const fg = hex(r.fg);
    return new TextRun({
      text: r.t,
      style: st && st !== "Normal" ? st : undefined,
      // what the style doesn't already give it
      bold: !l && st === "Normal" && r.b ? true : undefined,
      italics: r.i ? true : undefined,
      strike: r.s ? true : undefined,
      size: r.fs && r.fs !== own ? r.fs * PT : undefined,
      font: r.ff && !/^calibri$/i.test(r.ff.trim()) ? r.ff : undefined,
      color: fg && fg !== "000000" ? fg : undefined,
      highlight: bg && HIGHLIGHT[bg] ? (HIGHLIGHT[bg] as any) : undefined,
      shading: bg && !HIGHLIGHT[bg] ? { type: ShadingType.CLEAR, color: "auto", fill: bg } : undefined,
      border: r.bx && st !== "Emphasis" ? { style: BorderStyle.SINGLE, size: 6, color: "000000", space: 0 } : undefined,
      // a hat's and a block's rule come with their style; a word underlined in a tag or pocket doesn't
      underline: (l === 4 || l === 1) && r.u ? { type: UnderlineType.SINGLE } : undefined,
    });
  });

  const children: any[] = [];
  let afterTag = false;               // the next paragraph with words in it is the cite line
  (elements || []).forEach((e) => {
    if (e.k === "brk") {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      return;
    }
    const l = level(e);
    const hasWords = (e.runs || []).some((r) => r.t && r.t.trim());
    const citeLine = !l && afterTag && hasWords;
    if (l) afterTag = l === 4;
    else if (hasWords) afterTag = false;
    const line = runs(e, l, citeLine);
    children.push(new Paragraph({
      children: line.length ? line : [new TextRun({ text: "" })],
      heading: l ? heading[l] : undefined,
      // card text keeps a centring or indent it was given; headings take their style's
      alignment: !l && e.al === "center" ? AlignmentType.CENTER : !l && e.al === "right" ? AlignmentType.RIGHT : undefined,
      indent: !l && e.ml ? { left: Math.round(e.ml * 20) } : undefined,
    }));
  });

  const doc = new Document({
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
  // styles.xml written whole: the library's own defaults would sit beside these, with a second
  // Heading1–4 that Word or a reader might take instead
  const blob = await Packer.toBlob(doc, false, [{ path: "word/styles.xml", data: stylesXml() }]);
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
