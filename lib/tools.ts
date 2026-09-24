/**
 * The tools, as a list.
 *
 * These are not part of the pool. A bracket pool is for everyone in it; a tool
 * is for whoever runs the thing, and each one is a workbench of its own —
 * self-contained, admin-keyed, and added to over time. Keeping them in a list
 * means the suite page never has to be edited to gain one.
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
    slug: "evidence",
    name: "Evidence",
    blurb: "Search a cut file by trigger, send cards, and cut the speech doc from what you highlighted.",
    about:
      "Paste an evidence document straight out of Google Docs. Headings become blocks and taglines, " +
      "so the whole file is searchable by trigger; sending a card copies it ready to paste, and the " +
      "read document is built from the highlighting you already did.",
    storage: "This browser only — IndexedDB. Nothing is uploaded and nothing reaches the server.",
  },
  {
    slug: "flow",
    name: "Flow",
    blurb: "Flow a Public Forum round on a real grid, on the clock, with your partner in the same flow.",
    about:
      "One column per speech in PF's own order, one row per argument, and the answer to something " +
      "sits to the right of it. The clock knows every speech and both prep clocks, and marks the " +
      "column that is live. Start a room, read the code to your partner, and you are both writing " +
      "the same flow.",
    storage:
      "This browser only — localStorage. A shared room passes changes straight between the two " +
      "browsers in it and stores nothing on the way.",
  },
];

export const toolBySlug = (slug: string) => TOOLS.find((t) => t.slug === slug) || null;
