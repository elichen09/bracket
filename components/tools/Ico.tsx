/**
 * The toolbar's icons, for when a bar is too narrow for its words.
 *
 * Drawn as lines on a 24 grid with square ends and mitred corners — the
 * tools' hard-edged look, not the rounded one icon sets default to. They
 * are hidden until the bar they sit in runs out of room (see fitBar.ts);
 * until then the words say it better.
 */

const PATHS: Record<string, string> = {
  import: "M12 3v12M7 10l5 5 5-5M4 15v5h16v-5",
  export: "M12 15V3M7 8l5-5 5 5M4 15v5h16v-5",
  case: "M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M13 4v6M7 14v6",
  grid: "M3 4h18v16H3zM9 4v16M15 4v16M3 10h18",
  split: "M3 4h18v16H3zM12 4v16",
  doc: "M6 3h9l4 4v14H6zM15 3v4h4M9 13h6",
  command: "M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z",
  cards: "M4 8h12v12H4zM8 4h12v12",
  history: "M3 12a9 9 0 1 0 3-6.7M3 3v5h5M12 7v5l3 3",
  drawer: "M3 4h18v16H3zM15 4v16",
};

export default function Ico({ n }: { n: keyof typeof PATHS | string }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="square" strokeLinejoin="miter">
      <path d={PATHS[n] || ""} />
    </svg>
  );
}
