import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Where the caselist tag indexes live: a private Supabase Storage bucket, one
 * gzipped index per wiki (`hspf26.json.gz`) and a small note beside it
 * (`hspf26.meta.json`: when it was built, from which archive, how many cards)
 * so that checking for a newer index never means downloading one.
 */

export const BUCKET = "caselist";

export interface IndexMeta { wiki: string; built: string; zip: { name: string; url: string }; docs: number; cards: number; bytes: number }

let made = false;
export async function bucket(db: SupabaseClient) {
  if (made) return;
  const { data } = await db.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await db.storage.createBucket(BUCKET, { public: false, fileSizeLimit: "50MB" });
    if (error && !/exists/i.test(error.message)) throw new Error("storage: " + error.message);
  }
  made = true;
}

export async function readMeta(db: SupabaseClient, wiki: string): Promise<IndexMeta | null> {
  const { data, error } = await db.storage.from(BUCKET).download(`${wiki}.meta.json`);
  if (error || !data) return null;
  try { return JSON.parse(await data.text()) as IndexMeta; } catch { return null; }
}
