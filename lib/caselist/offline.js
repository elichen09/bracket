/**
 * The caselist kept on this computer — the desktop app only (src-tauri/src/caselist.rs).
 *
 * The index of tags is already kept in the page; this keeps the week's archive
 * of the documents themselves, so a card opens with no internet: its document
 * is read out of the archive here, at the offset the index gives, unpacked,
 * and the card taken out of it by the same code the site uses (card.mjs).
 *
 * A kept archive serves only the index it matches (the same archive's address):
 * an index read from another week's archive points at other offsets.
 */

import { isDesktop } from '../desktop';

let tauri = null;
function T() {
  if (!isDesktop()) return Promise.resolve(null);
  if (!tauri) tauri = Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]).then(([c, e]) => ({ invoke: c.invoke, listen: e.listen })).catch(() => null);
  return tauri;
}

/** Whether this can keep archives at all (the app). */
export const canKeep = () => isDesktop();

let keptP = null;
/** The archives kept here: slug -> { slug, url, bytes, at }. Asked once, then kept up to date by keep/drop. */
export function keptList(fresh) {
  if (!keptP || fresh) {
    keptP = T().then((t) => (t ? t.invoke('cl_kept') : [])).then((l) => new Map((l || []).map((k) => [k.slug, k]))).catch(() => new Map());
  }
  return keptP;
}

/** Whether this wiki's archive, the one this index was read from, is kept here. */
export async function keptFor(slug, url) {
  if (!isDesktop() || !url) return false;
  const k = (await keptList()).get(slug);
  return !!k && k.url === url;
}

/** Keep this wiki's archive here (in the background; progress by onProgress). */
export async function keep(slug, url) {
  const t = await T();
  if (!t) throw new Error('only the desktop app keeps the caselist');
  await t.invoke('cl_keep', { slug, url });
}

/** How big a wiki's archive is, in bytes (asked before keeping it). */
export async function size(url) {
  const t = await T();
  if (!t) return 0;
  return Number(await t.invoke("cl_size", { url })) || 0;
}

/** Let a wiki's archive go (a download under way stops). */
export async function drop(slug) {
  const t = await T();
  if (!t) return;
  await t.invoke('cl_drop', { slug });
  await keptList(true);
}

/** Progress of the downloads: f({ slug, got, total, done, error }). */
export async function onProgress(f) {
  const t = await T();
  if (!t) return () => {};
  return t.listen('coda-cl', ({ payload }) => {
    if (payload && payload.done) keptList(true).then(() => f(payload)); else f(payload);
  });
}

/** Given bytes from an entry's local header on, the entry's contents (a .docx). */
async function unpack(buf, csize, method) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 30 || dv.getUint32(0, true) !== 0x04034b50) throw new Error('the kept archive is not the one the index was read from');
  const start = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
  const data = buf.subarray(start, start + csize);
  if (data.length < csize) throw new Error('the document was cut short');
  if (method === 0) return data;
  if (method === 8) {
    const out = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(out).arrayBuffer());
  }
  throw new Error('compression method ' + method + ' is not one this reads');
}

/** A card's body as HTML, out of the archive kept here. d = the index's [path, offset, size, method, nameLength]. */
export async function localCard(slug, d, tag) {
  const t = await T();
  if (!t) return null;
  const span = 30 + d[4] + 1024 + d[2];
  const bytes = new Uint8Array(await t.invoke('cl_read', { slug, off: d[1], len: span }));
  const docx = await unpack(bytes, d[2], d[3]);
  const { cardHtml } = await import('./card.mjs');
  return cardHtml(docx, tag);
}
