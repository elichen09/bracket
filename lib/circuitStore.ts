import type { SupabaseClient } from "@supabase/supabase-js";
import { setCollegeOverrides } from "./circuit";

/**
 * Which tournaments someone has said are college policy (or are not), kept in
 * Supabase Storage — `config/college.json`, `{ "<tournament name>": true }` —
 * so that choosing "College policy" for a tournament on the ranking-update page
 * sticks without a migration or a code change.
 *
 * lib/circuit.ts decides a round's circuit from names alone, synchronously;
 * this loads the list into it. Everything on the server that reads rounds or
 * rebuilds ratings calls `loadCircuitOverrides` first. Cached for a few
 * minutes, and replaced the moment it is saved.
 */

const BUCKET = "config";
const FILE = "college.json";
const LIFE = 5 * 60_000;
let loaded: { at: number; list: Record<string, boolean> } | null = null;
let made = false;

async function bucket(db: SupabaseClient) {
  if (made) return;
  const { data } = await db.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await db.storage.createBucket(BUCKET, { public: false });
    if (error && !/exists/i.test(error.message)) throw new Error("storage: " + error.message);
  }
  made = true;
}

export async function loadCircuitOverrides(db: SupabaseClient, fresh = false): Promise<Record<string, boolean>> {
  if (!fresh && loaded && Date.now() - loaded.at < LIFE) return loaded.list;
  let list: Record<string, boolean> = {};
  try {
    const { data, error } = await db.storage.from(BUCKET).download(FILE);
    if (!error && data) list = JSON.parse(await data.text()) || {};
  } catch { /* none yet, or unreadable: the named list in circuit.ts stands alone */ }
  loaded = { at: Date.now(), list };
  setCollegeOverrides(list);
  return list;
}

/** Say whether a tournament is college policy, for good. */
export async function saveCollegeOverride(db: SupabaseClient, tournName: string, college: boolean) {
  await bucket(db);
  const list = { ...(await loadCircuitOverrides(db, true)), [tournName]: college };
  const { error } = await db.storage.from(BUCKET).upload(FILE, JSON.stringify(list, null, 1), { upsert: true, contentType: "application/json" });
  if (error) throw new Error("storage: " + error.message);
  loaded = { at: Date.now(), list };
  setCollegeOverrides(list);
}
