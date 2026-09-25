import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { token, call } from "@/lib/caselist/api";
import { circuitOf } from "@/lib/caselist/rank";
import { BUCKET, bucket, readMeta } from "@/lib/caselist/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/tools/caselist/index        (x-update-secret: UPDATE_SECRET)
 *
 * What the weekly index build needs to know, and where to put what it makes
 * (scripts/caselist-index.mjs, run by .github/workflows/caselist-index.yml):
 * for each of this season's wikis, the newest whole-wiki archive openCaselist
 * has published, the school names to show, which archive the stored index was
 * built from, and signed URLs to upload the new index and its note to.
 *
 * The heavy part — a gigabyte of documents — happens in the workflow, which
 * has the room for it; this only talks to the caselist and to storage.
 */
export async function POST(req: Request) {
  const secret = process.env.UPDATE_SECRET;
  if (!secret || req.headers.get("x-update-secret") !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const db = supabaseAdmin();
    await bucket(db);
    const t = await token(null);
    const get = async (p: string) => {
      const r = await call(p, t.token);
      if (!r.ok) throw new Error("openCaselist said " + r.status + " for " + p);
      return r.json();
    };
    const wikis = ((await get("/caselists")) as any[]).filter((c) => !c.archived && circuitOf(String(c.name)));
    const out = [];
    for (const w of wikis) {
      const slug = String(w.name);
      const downloads = (await get(`/caselists/${slug}/downloads`)) as { name: string; url: string }[];
      // the whole wiki as of its latest build: "hspf26-all-2026-09-22.zip"
      const all = downloads.filter((d) => /-all-\d{4}-\d{2}-\d{2}\.zip$/.test(d.name)).sort((a, b) => b.name.localeCompare(a.name))[0] || null;
      const schools: Record<string, string> = {};
      try {
        for (const s of (await get(`/caselists/${slug}/schools`)) as any[]) schools[String(s.name)] = String(s.display_name || s.name);
      } catch { /* the index shows the school's short name instead */ }
      const meta = await readMeta(db, slug);
      const up = async (path: string) => {
        const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
        if (error || !data) throw new Error("storage: " + (error?.message || "no upload url"));
        return data.signedUrl;
      };
      out.push({
        slug, name: String(w.display_name || slug), zip: all, schools,
        current: meta?.zip?.name || null,
        upload: await up(`${slug}.json.gz`),
        uploadMeta: await up(`${slug}.meta.json`),
      });
    }
    return NextResponse.json({ wikis: out });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
