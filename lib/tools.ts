/**
 * The tools, as a list.
 *
 * The tools are the site. Each one is a workbench of its own — self-contained,
 * admin-keyed, and added to over time. Keeping them in a list means the front
 * page and the suite page never have to be edited to gain one.
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
    slug: "tutorial",
    name: "Tutorial",
    blurb: "Start here — every tool explained: what it is for, a first go at it, its keys, and how they fit together.",
    about:
      "How the tools fit together through a round, then each one in turn — what it does, a first go at it step by step, " +
      "every key it answers to, and what is worth knowing — with a way straight into each.",
    storage: "Nothing to keep — it only explains.",
  },
  {
    slug: "magic",
    name: "Round Magic",
    blurb: "Cut cards, search the library, send to the speech doc, read the other team's — one window for the round.",
    about:
      "The card cutter, Evidence and the Doc viewer as one tool. Your files in the middle, cut by key (Ctrl+Alt cut, Ctrl+N shrink, " +
      "Alt+Z highlight, Alt+1–4 the headings); the speech doc beside them in Split, where Alt+Enter sends the card you are in and " +
      "your partner can write with you; any file shared by a link, edited together like a Google Doc; the library and the caselist down the side, Enter to send; the other team's docs off " +
      "SpeechDrop opened in the same editor to rehighlight; and Read mode, the speech as you will read it, timed.",
    storage: "This browser, kept apart per account — IndexedDB. Your files, your library, their docs; nothing is uploaded unless you share it. A room passes the speech doc straight between browsers; a file you share by link is kept on the site so the link opens it.",
  },
  {
    slug: "split",
    name: "Split screen",
    blurb: "Any two tools side by side — Round Magic, Flow, Doc flow — in one window.",
    about:
      "Two tools in one window, each whole: pick what goes on each side, drag the line between them to share the room, " +
      "swap them over. A card sent from Round Magic is ready to flow on the other side.",
    storage: "Whatever each tool keeps; the split only remembers which tools and how wide.",
  },
  {
    slug: "flow",
    name: "Flow",
    blurb: "Flow a Public Forum round on a real grid, on the clock, with your partner in the same flow.",
    about:
      "One sheet per case, its columns the chain of answers — the case, their rebuttal, your rebuttal, " +
      "through both final focuses — one row per argument, and the answer to something sits to the right of it. The clock knows every speech and both prep clocks, and marks the " +
      "column that is live. Start a room, read the code to your partner, and you are both writing " +
      "the same flow.",
    storage:
      "This browser, kept apart per account — localStorage. A shared room passes changes straight between the two " +
      "browsers in it and stores nothing on the way.",
  },
  {
    slug: "docflow",
    name: "Doc flow",
    blurb: "Flow a round the way a Google Doc gets flowed — boxed sides, their points in red, your answers under them.",
    about:
      "A document that knows it is a flow. Tab answers a line and changes the speaker, the numbering is Docs' own, " +
      "and your rhetoric sits beside it to drag onto a line or call up with /. Start a room and your partner types " +
      "into the same flow. Pastes a flow straight out of Google Docs and copies one back in.",
    storage: "This browser, kept apart per account — localStorage for the flows you are working on; every one is also kept in Past flows.",
  },
  {
    slug: "flows",
    name: "Past flows",
    blurb: "Every round you have flowed, Doc or Grid — searchable, grouped by tournament, one click from opening again.",
    about:
      "Flow and Doc flow file every round here as you flow it, so starting the next round never loses the last. " +
      "Search every word you have flowed, group rounds by tournament, read one back without opening it, and open it " +
      "in the tool it came from.",
    storage: "This browser, kept apart per account — IndexedDB. Nothing is uploaded.",
  },
];

export const toolBySlug = (slug: string) => TOOLS.find((t) => t.slug === slug) || null;
