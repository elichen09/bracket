import { redirect } from "next/navigation";

/** Evidence is part of coda now; a partner's room link still opens the shared speech doc. */
export default function EvidenceTool({ searchParams }: { searchParams?: { room?: string | string[] } }) {
  const raw = searchParams?.room;
  const room = (Array.isArray(raw) ? raw[0] : raw) || undefined;
  redirect("/tools/magic" + (room ? `?room=${encodeURIComponent(room)}` : ""));
}
