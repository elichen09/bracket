import { NextResponse } from "next/server";
import { adminKeyOk, adminCookie, hintCookie, isAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin  { adminKey }   — unlock the tools on this browser
 * DELETE /api/admin               — lock them again
 * GET /api/admin                  — is this browser unlocked?
 *
 * A wrong key is answered slowly. There is nothing to brute force here at
 * human speed, but the delay costs an honest admin a tenth of a second once
 * and costs a script most of its throughput.
 */
export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!process.env.ADMIN_KEY) {
    return NextResponse.json({ error: "no admin key is set on the server" }, { status: 500 });
  }
  if (!adminKeyOk(String(body?.adminKey || ""))) {
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json({ error: "wrong admin key" }, { status: 403 });
  }
  const res = NextResponse.json({ ok: true, admin: true });
  res.cookies.set(adminCookie(String(body.adminKey)));
  res.cookies.set(hintCookie(true));
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true, admin: false });
  res.cookies.set(adminCookie(""));
  res.cookies.set(hintCookie(false));
  return res;
}

export async function GET() {
  return NextResponse.json({ admin: isAdmin() });
}
