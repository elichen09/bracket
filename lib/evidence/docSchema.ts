import { Schema, type DOMOutputSpec } from "prosemirror-model";

/**
 * The document, as a model rather than a string of HTML.
 *
 * The panel used to be a contenteditable holding whatever HTML had last been
 * written into it. That is why it misbehaved: every redraw threw away the undo
 * history and the cursor, an editing command could delete the structure it was
 * being made in, and there was no answer to "what is this paragraph" beyond
 * looking at the tags.
 *
 * Here a document is nodes and marks. A paragraph is a paragraph, a block
 * heading is a heading at level three, and the editor's job is to keep the two
 * in step. Everything else — undo, selection, the cursor surviving a change
 * made somewhere else — comes from having a model at all.
 *
 * The node names are the ones a cut file uses. Verbatim's four heading levels
 * are its four levels, so they map one to one onto h1–h4 and come out of the
 * clipboard as headings, which is what Google Docs reads back as headings.
 */

const inline = "inline*";

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },

    paragraph: {
      content: inline,
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM(): DOMOutputSpec { return ["p", 0]; },
    },

    /**
     * pocket / hat / block / tag, in that order. Levels rather than four node
     * types because that is how they paste, and because "one level up" is a
     * thing a person asks for.
     */
    heading: {
      attrs: { level: { default: 3 } },
      content: inline,
      group: "block",
      defining: true,
      parseDOM: [1, 2, 3, 4].map((level) => ({ tag: `h${level}`, attrs: { level } })),
      /**
       * The cover carries its rule inline, because a paste has no stylesheet
       * to consult and a box is the one part of a cover page that is not a
       * heading style. Nothing else is decorated here: an inline underline
       * would be read back as an underline *mark* the next time the document
       * is parsed, and would then follow the text into whatever style it was
       * changed to — which is how tags ended up underlined.
       */
      toDOM(node): DOMOutputSpec {
        const tag = `h${node.attrs.level}`;
        if (node.attrs.level !== 1) return [tag, 0];
        return [tag, { style: "text-align:center;border:3px solid #333333;padding:6pt 10pt" }, 0];
      },
    },

    /** Drawn as a rule on the page; taken out again on the way to the clipboard. */
    pageBreak: {
      group: "block",
      parseDOM: [{ tag: "hr" }],
      toDOM(): DOMOutputSpec { return ["hr", { class: "brk" }]; },
    },

    text: { group: "inline" },
  },

  marks: {
    strong: {
      parseDOM: [
        { tag: "strong" },
        { tag: "b", getAttrs: (n) => (n as HTMLElement).style.fontWeight !== "normal" && null },
        { style: "font-weight", getAttrs: (v) => /^(bold(er)?|[5-9]\d{2,})$/.test(v as string) && null },
      ],
      toDOM(): DOMOutputSpec { return ["strong", 0]; },
    },
    em: {
      parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }],
      toDOM(): DOMOutputSpec { return ["em", 0]; },
    },
    underline: {
      parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }, { style: "text-decoration-line=underline" }],
      toDOM(): DOMOutputSpec { return ["u", 0]; },
    },
    strike: {
      parseDOM: [{ tag: "s" }, { tag: "strike" }, { tag: "del" }, { style: "text-decoration=line-through" }],
      toDOM(): DOMOutputSpec { return ["s", 0]; },
    },

    /** The highlighter. The colour is kept, because a file can use several. */
    highlight: {
      attrs: { color: { default: "#ffff00" } },
      parseDOM: [{
        style: "background-color",
        getAttrs: (v) => {
          const c = String(v);
          if (!c || /transparent|^rgba\(0, 0, 0, 0\)$|^#f{3,6}$|^white$/i.test(c)) return false;
          return { color: c };
        },
      }],
      toDOM(mark): DOMOutputSpec { return ["span", { style: `background-color:${mark.attrs.color}` }, 0]; },
    },

    fontSize: {
      attrs: { size: { default: "11pt" } },
      parseDOM: [{ style: "font-size", getAttrs: (v) => ({ size: String(v) }) }],
      toDOM(mark): DOMOutputSpec { return ["span", { style: `font-size:${mark.attrs.size}` }, 0]; },
    },

    fontFamily: {
      attrs: { font: { default: "" } },
      parseDOM: [{ style: "font-family", getAttrs: (v) => ({ font: String(v).replace(/["']/g, "") }) }],
      toDOM(mark): DOMOutputSpec { return ["span", { style: `font-family:${mark.attrs.font}` }, 0]; },
    },

    textColor: {
      attrs: { color: { default: "#000000" } },
      parseDOM: [{ style: "color", getAttrs: (v) => ({ color: String(v) }) }],
      toDOM(mark): DOMOutputSpec { return ["span", { style: `color:${mark.attrs.color}` }, 0]; },
    },

    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [{ tag: "a[href]", getAttrs: (n) => ({ href: (n as HTMLElement).getAttribute("href") }) }],
      toDOM(mark): DOMOutputSpec { return ["a", { href: mark.attrs.href }, 0]; },
    },
  },
});

/** What each heading level is called in a cut file. */
export const LEVELS = [
  { level: 0, name: "Normal" },
  { level: 1, name: "Pocket" },
  { level: 2, name: "Hat" },
  { level: 3, name: "Block" },
  { level: 4, name: "Tag" },
];
