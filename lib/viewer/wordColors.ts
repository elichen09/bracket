/**
 * Word's highlight colours, the way Word draws them.
 *
 * A .docx names its highlights ("green", "darkYellow") and docx-preview hands
 * the name straight to CSS — where "green" is #008000, a dark green, not the
 * #00FF00 Word means; "darkGreen" darker still; and "darkYellow" is no CSS
 * colour at all, so that highlighting vanished. So before a .docx is drawn,
 * each named highlight is rewritten as the colour Word gives it — and the
 * dark greens as the ordinary green, the one a card is cut in.
 */

const WORD: Record<string, string> = {
  yellow: "FFFF00", green: "00FF00", cyan: "00FFFF", magenta: "FF00FF", blue: "0000FF", red: "FF0000",
  darkBlue: "000080", darkCyan: "008080", darkGreen: "00FF00", darkMagenta: "800080", darkRed: "800000",
  darkYellow: "808000", darkGray: "808080", lightGray: "C0C0C0", black: "000000", white: "FFFFFF",
};

/** The parts of a .docx that carry text and its runs' formatting. */
const PARTS = /^word\/(document|styles|numbering|footnotes|endnotes|header\d*|footer\d*)\.xml$/;

/** The same .docx with Word's highlight colours spelled out; the original if nothing changed or it can't be read. */
export async function wordHighlights(blob: Blob): Promise<Blob> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(blob);
    let changed = false;
    for (const name of Object.keys(zip.files)) {
      if (!PARTS.test(name)) continue;
      const file = zip.file(name);
      if (!file) continue;
      const xml = await file.async("string");
      const next = xml.replace(/(<w:highlight\b[^>]*?\bw:val=")([A-Za-z]+)(")/g, (all, a: string, v: string, b: string) => {
        const hex = WORD[v];
        if (!hex) return all;
        changed = true;
        return a + hex + b;
      });
      if (next !== xml) zip.file(name, next);
    }
    return changed ? await zip.generateAsync({ type: "blob" }) : blob;
  } catch {
    return blob;
  }
}
