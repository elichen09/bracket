/**
 * What the site holds, as a list: coda itself, and how it works.
 *
 * The app was Round Magic — the card cutter, Evidence and the Doc viewer as
 * one window — and is called coda now, after the site. Flow, Doc flow, Split
 * screen and Past flows were retired with the rename; their old addresses
 * land in the app (next.config.mjs).
 */

export interface Tool {
  slug: string;
  name: string;
  /** One line, in the index. */
  blurb: string;
  /** What it is for, in the tool's own header. */
  about: string;
  /** Where its data lives, so nobody has to guess. */
  storage: string;
}

export const TOOLS: Tool[] = [
  {
    slug: "magic",
    name: "coda",
    blurb: "Cut cards, search your library and the caselist, build the speech doc, read the other team's — one window for the round.",
    about:
      "The card cutter, the library and the speech doc as one window. Your files in the middle, cut by key; the library and the " +
      "caselist down the side, Enter to send; the speech doc beside them, shared with your partner; the other team's docs opened " +
      "in the same editor to rehighlight; and Read mode, the speech as you will read it, timed.",
    storage: "This browser, kept apart per account — IndexedDB. Your files, your library, their docs; nothing is uploaded unless you share it. A room passes the speech doc straight between browsers; a file you share by link is kept on the site so the link opens it.",
  },
  {
    slug: "tutorial",
    name: "Tutorial",
    blurb: "How coda works — every key and every panel, with a working copy to try each in.",
    about: "Every part of coda in turn — what it does, a first go at it, its keys, and what is worth knowing.",
    storage: "Nothing to keep — it only explains.",
  },
];

export const toolBySlug = (slug: string) => TOOLS.find((t) => t.slug === slug) || null;
