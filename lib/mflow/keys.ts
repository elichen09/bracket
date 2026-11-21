/**
 * Flow's keys: ebb's, where a browser lets a page have them, and moved where
 * it doesn't (Ctrl+T, Ctrl+N, Ctrl+W, Ctrl+1–9 are Chrome's) or where Eli's
 * Docs Hotkey extension already has them (Ctrl+K, Ctrl+O, Ctrl+D, Ctrl+N).
 * Specs are written the way comboOf names a key press.
 */
export interface FlowKey { id: string; group: string; label: string; key: string }

export const FLOW_KEYS: FlowKey[] = [
  // moving
  { id: "down", group: "Moving", label: "Down a cell (or save and go down)", key: "Enter" },
  { id: "right", group: "Moving", label: "Right a cell (or save and go right)", key: "Tab" },
  { id: "left", group: "Moving", label: "Left a cell", key: "shift+Tab" },
  { id: "jump", group: "Moving", label: "Jump to the next written cell / the edge", key: "mod+↓" },
  { id: "edit", group: "Moving", label: "Edit the cell (also double-click)", key: "F2" },
  { id: "find", group: "Moving", label: "Find in the flow (\"2ar warming\" looks in one speech)", key: "mod+P" },
  // writing
  { id: "marker", group: "Writing", label: "Argument number (\"AR #3\")", key: "mod+Enter" },
  { id: "skip", group: "Writing", label: "Save and skip down three", key: "mod+shift+Enter" },
  { id: "extend", group: "Writing", label: "Extend to your next speech", key: "mod+E" },
  { id: "move", group: "Writing", label: "Move cells (↑ ↓, Enter to drop, Esc to cancel)", key: "alt+M" },
  { id: "cell-above", group: "Writing", label: "New cell above", key: "alt+↑" },
  { id: "cell-below", group: "Writing", label: "New cell below", key: "alt+↓" },
  { id: "row-above", group: "Writing", label: "New row above", key: "alt+shift+↑" },
  { id: "row-below", group: "Writing", label: "New row below", key: "alt+shift+↓" },
  { id: "del-cell", group: "Writing", label: "Take the cell out (the column closes up)", key: "mod+Delete" },
  { id: "del-row", group: "Writing", label: "Take the row out", key: "mod+Backspace" },
  { id: "clear", group: "Writing", label: "Clear the cells", key: "Delete" },
  { id: "undo", group: "Writing", label: "Undo", key: "mod+Z" },
  { id: "redo", group: "Writing", label: "Redo", key: "mod+Y" },
  // marks
  { id: "bold", group: "Marks", label: "Bold", key: "mod+B" },
  { id: "highlight", group: "Marks", label: "Highlight", key: "mod+shift+H" },
  { id: "card", group: "Marks", label: "Card (a line under it)", key: "mod+U" },
  { id: "group", group: "Marks", label: "Group (a bar beside it)", key: "mod+G" },
  { id: "kicked", group: "Marks", label: "Kicked (struck through)", key: "mod+shift+X" },
  // sheets
  { id: "sheet-next", group: "Sheets", label: "Next sheet", key: "mod+]" },
  { id: "sheet-prev", group: "Sheets", label: "Previous sheet", key: "mod+[" },
  { id: "sheet-n", group: "Sheets", label: "Sheet 1–9", key: "alt+1" },
  { id: "sheet-up", group: "Sheets", label: "Move the sheet up", key: "mod+shift+[" },
  { id: "sheet-down", group: "Sheets", label: "Move the sheet down", key: "mod+shift+]" },
  { id: "sheet-aff", group: "Sheets", label: "New aff sheet", key: "mod+alt+A" },
  { id: "sheet-neg", group: "Sheets", label: "New neg sheet", key: "mod+alt+N" },
  { id: "rename", group: "Sheets", label: "Rename the sheet", key: "alt+R" },
  { id: "sheets", group: "Sheets", label: "Show or hide the sheets", key: "mod+\\" },
  // the round
  { id: "answer", group: "The round", label: "Answer this cell: your library, in Answer mode", key: "alt+Enter" },
  { id: "rfd", group: "The round", label: "RFD", key: "alt+D" },
  { id: "decision", group: "The round", label: "Decision view: RFD beside cross-ex and the final focuses", key: "alt+shift+D" },
  { id: "help", group: "The round", label: "These keys", key: "shift+?" },
];

export const keyOf = (id: string) => FLOW_KEYS.find((k) => k.id === id)?.key || "";
