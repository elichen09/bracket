/**
 * A flow as an .xlsx: a worksheet per sheet (a column per speech, the marks
 * kept: bold, highlight, card, group, kicked), then the round's info and the
 * RFD, as ebb exports. Written by hand on jszip; nothing else needed.
 */
import JSZip from "jszip";
import { columnsOf, firstCol, lastRow, cellAt, title, type Round, type Cell } from "./model";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  // characters XML can't hold
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

const colName = (i: number) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

/** Styles, made as they're needed: a cell's marks → its style number. */
class Styles {
  private borders: string[] = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  private borderAt = new Map<string, number>([["", 0]]);
  private xfs: string[] = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>',
    // the header row: bold, grey
    '<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>',
  ];
  private xfAt = new Map<string, number>();
  border(c: Cell): number {
    const k = (c.c ? "c" : "") + (c.g ? "g" : "") + (c.k ? "k" : "");
    let i = this.borderAt.get(k);
    if (i === undefined) {
      const diag = c.k ? ' diagonalDown="1"' : "";
      this.borders.push(`<border${diag}>${c.g ? '<left style="thick"><color rgb="FF555555"/></left>' : "<left/>"}<right/><top/>` +
        `${c.c ? '<bottom style="medium"><color rgb="FF111111"/></bottom>' : "<bottom/>"}${c.k ? '<diagonal style="thin"><color rgb="FF999999"/></diagonal>' : "<diagonal/>"}</border>`);
      i = this.borders.length - 1;
      this.borderAt.set(k, i);
    }
    return i;
  }
  of(c: Cell | undefined): number {
    if (!c || !(c.b || c.h || c.c || c.g || c.k)) return 0;
    const k = (c.b ? "b" : "") + (c.h ? "h" : "") + (c.c ? "c" : "") + (c.g ? "g" : "") + (c.k ? "k" : "");
    let i = this.xfAt.get(k);
    if (i === undefined) {
      const b = this.border(c);
      this.xfs.push(`<xf numFmtId="0" fontId="${c.b ? 1 : 0}" fillId="${c.h ? 2 : 0}" borderId="${b}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>`);
      i = this.xfs.length - 1;
      this.xfAt.set(k, i);
    }
    return i;
  }
  xml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF333333"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF59D"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/></patternFill></fill></fills>
<borders count="${this.borders.length}">${this.borders.join("")}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${this.xfs.length}">${this.xfs.join("")}</cellXfs>
</styleSheet>`;
  }
}

const cellXml = (ref: string, text: string, style: number) =>
  `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;

function sheetXml(rows: { cells: { text: string; style: number }[] }[], widths: number[]): string {
  const body = rows.map((row, ri) => `<row r="${ri + 1}">${row.cells.map((c, ci) => (c.text || c.style ? cellXml(colName(ci) + (ri + 1), c.text, c.style) : "")).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${body}</sheetData></worksheet>`;
}

/** A name Excel will take: 31 characters, none of []:*?/\, and no two the same. */
function names(list: string[]): string[] {
  const seen = new Set<string>();
  return list.map((n) => {
    const base = (n || "Sheet").replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 28) || "Sheet";
    let s = base, i = 2;
    while (seen.has(s.toLowerCase())) s = base.slice(0, 27) + " " + i++;
    seen.add(s.toLowerCase());
    return s;
  });
}

export async function roundXlsx(r: Round): Promise<Blob> {
  const st = new Styles();
  const books: { name: string; xml: string }[] = [];
  const sheetNames = names([...r.sheets.map((s) => (s.kind === "cx" ? "CX" : (s.kind === "aff" ? "Aff " : "Neg ") + s.name)), "Info", "RFD"]);

  r.sheets.forEach((s, i) => {
    // the columns the sheet shows (a neg sheet from the NC)
    const c0 = firstCol(r, s);
    const cols = columnsOf(r, s).slice(c0);
    const rows: { cells: { text: string; style: number }[] }[] = [{ cells: cols.map((c) => ({ text: c.name, style: 1 })) }];
    const last = lastRow(s);
    for (let w = 0; w <= last; w++) rows.push({ cells: cols.map((_, i) => { const cell = cellAt(s, c0 + i, w); return { text: cell?.t || "", style: st.of(cell) }; }) });
    books.push({ name: sheetNames[i], xml: sheetXml(rows, cols.map(() => 34)) });
  });

  const info = r.info;
  const infoRows = [
    ["Round", title(r)], ["Tournament", info.tournament], ["Round", info.round], ["Flight", info.flight], ["Date", info.date],
    ["Aff", info.aff], ["Neg", info.neg], ["Judge", info.judge], ["First speaker", r.order === "aff" ? "Aff" : "Neg"],
  ].map(([k, v]) => ({ cells: [{ text: k, style: 1 }, { text: v, style: 0 }] }));
  books.push({ name: sheetNames[r.sheets.length], xml: sheetXml(infoRows, [18, 60]) });
  const rfdRows = r.rfd.split("\n").map((line) => ({ cells: [{ text: line, style: 0 }] }));
  books.push({ name: sheetNames[r.sheets.length + 1], xml: sheetXml([{ cells: [{ text: "RFD", style: 1 }] }, ...rfdRows], [100]) });

  const zip = new JSZip();
  const file = (path: string, xml: string) => zip.file(path, xml, { createFolders: false });
  file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${books.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
  file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${books.map((b, i) => `<sheet name="${esc(b.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${books.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${books.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  books.forEach((b, i) => file(`xl/worksheets/sheet${i + 1}.xml`, b.xml));
  file("xl/styles.xml", st.xml());
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
