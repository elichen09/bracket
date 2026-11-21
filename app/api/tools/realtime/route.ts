import { NextResponse } from "next/server";
import { withCors, preflight } from "@/lib/appRequests";

/**
 * Where partners meet, for the desktop app: the realtime relay's address and
 * its public key — the same two values every page of the site already carries.
 * The app has no account; with these it joins a room by its code, as ebb's
 * partners meet by theirs. Nothing about a round passes through here.
 */
export const dynamic = "force-dynamic";

export async function OPTIONS(req: Request) {
  return preflight(req);
}

export async function GET(req: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  if (!url || !key) return withCors(req, NextResponse.json({ error: "Sharing isn't set up on this site" }, { status: 503 }));
  return withCors(req, NextResponse.json({ url, key }, { headers: { "cache-control": "public, max-age=3600" } }));
}
