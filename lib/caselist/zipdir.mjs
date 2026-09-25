/**
 * Just enough of the zip format to find a file inside a big archive, and to
 * pull one out again with a single ranged read.
 *
 * The weekly caselist archives run to a gigabyte, and a card needs one
 * document from one of them. A zip ends with a table of contents — the
 * central directory — that says where each file's local header starts and how
 * many compressed bytes follow; with that, one HTTP Range request fetches the
 * header and the data, and inflating it gives the .docx back.
 *
 * Handles ZIP64, which archives this size may use for offsets.
 */

import zlib from "node:zlib";

const EOCD = 0x06054b50, EOCD64 = 0x06064b50, LOC64 = 0x07064b50, CEN = 0x02014b50, LOC = 0x04034b50;

/**
 * The entries of an archive, from its tail. `read(start, length)` returns bytes
 * of the archive — from a file on disk, or an HTTP range.
 */
export async function entries(size, read) {
  const tailLen = Math.min(size, 66_000);
  const tail = await read(size - tailLen, tailLen);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { at = i; break; }
  if (at < 0) throw new Error("not a zip: no end of central directory");
  let count = tail.readUInt16LE(at + 10);
  let dirSize = tail.readUInt32LE(at + 12);
  let dirOff = tail.readUInt32LE(at + 16);
  // ZIP64: the locator sits just before the end record
  if (at >= 20 && tail.readUInt32LE(at - 20) === LOC64) {
    const eocd64Off = Number(tail.readBigUInt64LE(at - 20 + 8));
    const rec = await read(eocd64Off, 56);
    if (rec.readUInt32LE(0) === EOCD64) {
      count = Number(rec.readBigUInt64LE(32));
      dirSize = Number(rec.readBigUInt64LE(40));
      dirOff = Number(rec.readBigUInt64LE(48));
    }
  }
  const dir = await read(dirOff, dirSize);
  const out = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= dir.length; n++) {
    if (dir.readUInt32LE(p) !== CEN) break;
    const method = dir.readUInt16LE(p + 10);
    let csize = dir.readUInt32LE(p + 20);
    let usize = dir.readUInt32LE(p + 24);
    const nameLen = dir.readUInt16LE(p + 28), extraLen = dir.readUInt16LE(p + 30), commentLen = dir.readUInt16LE(p + 32);
    let off = dir.readUInt32LE(p + 42);
    const name = dir.toString("utf8", p + 46, p + 46 + nameLen);
    // ZIP64 sizes and offset live in the extra field when the plain ones are maxed out
    if (csize === 0xffffffff || usize === 0xffffffff || off === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = dir.readUInt16LE(e), len = dir.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (usize === 0xffffffff) { usize = Number(dir.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(dir.readBigUInt64LE(q)); q += 8; }
          if (off === 0xffffffff) { off = Number(dir.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + len;
      }
    }
    out.push({ name, off, csize, usize, method, nameLen });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** How many bytes to ask for to be sure of getting an entry whole: its header, a generous extra field, its data. */
export const spanOf = (e) => 30 + e.nameLen + 1024 + e.csize;

/** Given bytes starting at an entry's local header, the entry's uncompressed contents. */
export function unpack(buf, csize, method) {
  if (buf.readUInt32LE(0) !== LOC) throw new Error("no local header where the directory said");
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  const data = buf.subarray(start, start + csize);
  if (data.length < csize) throw new Error("the entry was cut short");
  if (method === 0) return Buffer.from(data);
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error("compression method " + method + " is not one this reads");
}
