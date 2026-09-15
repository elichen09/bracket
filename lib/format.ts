export function fmtDate(ts: string | number | null | undefined): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch { return ""; }
}
