import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * GET /api/tools/gdoc?doc=<a Google Doc's link, or its id>
 *
 * Your partner's flow, read out of the Google Doc they are writing it in.
 * The Doc is shared "anyone with the link can view", so no Google sign-in is
 * involved: Google's own export (/export?format=html) hands back the Doc as
 * it is right now, and Round Magic reads its outline. It goes through here
 * because a browser cannot fetch docs.google.com from this origin.
 *
 * What Google answers, and what that means:
 *   200       the Doc, as HTML
 *   3xx/401   it is not shared with the link — the export sends you to sign in
 *   404       there is no Doc with that id
 */

const ID = /^[A-Za-z0-9_-]{20,80}$/;
const MAX = 4 * 1024 * 1024;

function idOf(raw: string): string {
  const s = raw.trim();
  const m = s.match(/\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,80})/);
  return m ? m[1] : s;
}

export async function GET(req: Request) {
  if (!(await currentUser())) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const id = idOf(new URL(req.url).searchParams.get("doc") || "");
  if (!ID.test(id)) return NextResponse.json({ error: "That isn't a Google Doc link" }, { status: 400 });
  try {
    const res = await fetch(`https://docs.google.com/document/d/${id}/export?format=html`, {
      redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; TheBreak/1.0)" },
    });
    if (res.status === 404) return NextResponse.json({ error: "There's no Google Doc at that link" }, { status: 404 });
    if ((res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) {
      return NextResponse.json({ error: "That Doc isn't shared with the link — in Google Docs: Share › General access › Anyone with the link (Viewer)" }, { status: 403 });
    }
    if (!res.ok) return NextResponse.json({ error: `Google said ${res.status}` }, { status: 502 });
    const html = await res.text();
    if (html.length > MAX) return NextResponse.json({ error: "That Doc is too big to read as a flow" }, { status: 413 });
    return NextResponse.json({ id, html }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: "Couldn't reach Google Docs: " + ((e as Error).message || "timed out") }, { status: 502 });
  }
}
