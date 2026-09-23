/**
 * The shape the engine's parser produces, written down so the parts of the
 * tool that are TypeScript can talk about it. The engine itself is plain
 * JavaScript and predates this; these are the fields it actually sets.
 */

export interface Run {
  t: string;                // the text
  b?: boolean;              // bold
  i?: boolean;              // italic
  u?: boolean;              // underline
  s?: boolean;              // strike through
  fs?: number;              // size, in points
  ff?: string | null;       // face
  fg?: string | null;       // colour
  bg?: string | null;       // highlight
  lk?: string;              // link
}

export interface Elem {
  k?: string;               // "p", "li", "brk"
  h?: string;               // "P", "H1".."H4"
  runs?: Run[];
  ml?: number;              // indent, in points
  al?: string;              // alignment
  ol?: boolean;             // an ordered list item
  nl?: number;              // nesting depth
  an?: number;              // written by hand rather than cut
}
