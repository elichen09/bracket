import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/signup  { email, password, name } -> creates a confirmed account.
// Accounts are created with the service role and marked confirmed so nobody has
// to wait on Supabase's rate-limited confirmation email; the client then signs
// in with the same password.
export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const name = String(body?.name || "").trim().slice(0, 24);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ error: "that email doesn't look right" }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: "use at least 8 characters for the password" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "pick a display name — it's what the leaderboard shows" }, { status: 400 });

  const db = supabaseAdmin();
  const { error } = await db.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { display_name: name },
  });
  if (error) {
    const msg = /already|exists|registered/i.test(error.message) ? "an account with that email already exists — sign in instead" : error.message;
    return NextResponse.json({ error: msg }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
