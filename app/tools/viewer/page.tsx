import { redirect } from "next/navigation";

/**
 * The Doc viewer is part of coda now: a partner's room is the speech doc you
 * share, a SpeechDrop room its Round tab. Old links still land there.
 */
export default function DocViewerTool({ searchParams }: { searchParams?: { room?: string | string[]; sd?: string | string[] } }) {
  const one = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v) || undefined;
  const q = new URLSearchParams();
  const room = one(searchParams?.room), sd = one(searchParams?.sd);
  if (room) q.set("room", room);
  if (sd) q.set("sd", sd);
  const qs = q.toString();
  redirect("/tools/magic" + (qs ? "?" + qs : ""));
}
