#!/usr/bin/env node
/**
 * Build the caselist tag index — every Heading 4 in a wiki's disclosed
 * documents, with its cite and where its document sits in the weekly archive.
 *
 * openCaselist publishes each wiki's open-source documents every week as one
 * zip (hspf26-all-2026-09-22.zip, about a gigabyte for PF). Reading that once
 * a week is what makes the Evidence tool's caselist search instant: the tags
 * are searched from this index in the browser, and a card's body is fetched
 * on demand with one ranged read into the same zip. The same approach as
 * Logos (github.com/tvergho/logos-web), which indexes the wikis ahead of time
 * rather than downloading documents while someone waits.
 *
 *   node scripts/caselist-index.mjs --site https://… --secret …
 *       asks the site which archives are current (POST /api/tools/caselist/index,
 *       authorised by UPDATE_SECRET), builds each wiki's index and uploads it to
 *       the signed URL the site hands back. This is what the weekly workflow runs.
 *
 *   node scripts/caselist-index.mjs --zip ndt.zip --wiki ndtceda26 --url https://…/x.zip --out ndt.json.gz
 *       builds one index from a local archive, for trying it out.
 *
 * Index format (gzipped JSON):
 *   { v: 1, wiki, built, zip: { name, url }, schools: { slug: display },
 *     docs: [[path, offset, csize, method, nameLen]],
 *     cards: [[docIndex, tag, cite, rounds]] }
 * A card disclosed round after round by one team is one entry; `rounds`
 * counts how many documents it appeared in.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { entries, unpack } from "../lib/caselist/zipdir.mjs";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");

const arg = (k) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : undefined; };

/* ------------------------------------------------------------ reading a .docx */

const unxml = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const textOf = (xml) => unxml((xml.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|<w:tab\/>|<w:br\/>/g) || [])
  .map((t) => (t === "<w:tab/>" || t === "<w:br/>" ? " " : t.replace(/<[^>]+>/g, ""))).join("")).replace(/\s+/g, " ").trim();

/** styleId -> heading level: Word's Heading 1-4, Verbatim's Pocket/Hat/Block/Tag, or an outline level, through basedOn. */
function styleLevels(stylesXml) {
  const own = new Map(), based = new Map();
  for (const m of stylesXml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const [, id, body] = m;
    const name = (body.match(/<w:name w:val="([^"]+)"/) || [])[1] || "";
    const ol = (body.match(/<w:outlineLvl w:val="(\d)"/) || [])[1];
    const h = name.match(/^heading (\d)$/i);
    const v = { pocket: 1, hat: 2, block: 3, tag: 4 }[name.toLowerCase()];
    own.set(id, h ? +h[1] : v || (ol !== undefined ? +ol + 1 : 0));
    const b = (body.match(/<w:basedOn w:val="([^"]+)"/) || [])[1];
    if (b) based.set(id, b);
  }
  const memo = new Map();
  const level = (id, d = 0) => {
    if (memo.has(id)) return memo.get(id);
    let l = own.get(id) || 0;
    if (!l && based.has(id) && d < 10) l = level(based.get(id), d + 1);
    memo.set(id, l);
    return l;
  };
  return level;
}

/** A document's tags, each with the first paragraph under it — the cite. */
export async function readTags(docx) {
  const z = await JSZip.loadAsync(docx);
  const doc = await z.file("word/document.xml")?.async("string");
  if (!doc) return [];
  const level = styleLevels((await z.file("word/styles.xml")?.async("string")) || "");
  const out = [];
  let open = null;
  for (const p of doc.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []) {
    const sid = (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1];
    const ol = (p.match(/<w:outlineLvl w:val="(\d)"/) || [])[1];
    const lvl = sid ? level(sid) : (ol !== undefined ? +ol + 1 : 0);
    const t = textOf(p);
    if (lvl === 4 && t) { open = { tag: t.slice(0, 500), cite: "" }; out.push(open); continue; }
    if (lvl) { open = null; continue; }
    if (open && !open.cite && t) open.cite = t.slice(0, 220);
  }
  return out;
}

/* ------------------------------------------------------------ one wiki */

export async function buildIndex({ wiki, zipFile, zipName, zipUrl, schools = {} }) {
  const fd = fs.openSync(zipFile, "r");
  const size = fs.fstatSync(fd).size;
  const read = async (start, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, start); return b; };
  const list = (await entries(size, read)).filter((e) => /\.docx$/i.test(e.name) && e.name.split("/").length >= 4);
  const docs = [], cards = [];
  const seen = new Map();          // team|tag|cite -> card
  let failed = 0;
  const t0 = Date.now();
  for (const [i, e] of list.entries()) {
    try {
      const buf = await read(e.off, 30 + e.nameLen + 1024 + e.csize > size - e.off ? size - e.off : 30 + e.nameLen + 1024 + e.csize);
      const tags = await readTags(unpack(buf, e.csize, e.method));
      if (!tags.length) continue;
      const di = docs.length;
      docs.push([e.name, e.off, e.csize, e.method, e.nameLen]);
      const team = e.name.split("/").slice(1, 3).join("/");
      for (const t of tags) {
        const key = team + "|" + t.tag.toLowerCase().replace(/\W+/g, "") + "|" + t.cite.toLowerCase().replace(/\W+/g, "").slice(0, 60);
        const had = seen.get(key);
        if (had) { had[3]++; continue; }
        const c = [di, t.tag, t.cite, 1];
        seen.set(key, c);
        cards.push(c);
      }
    } catch { failed++; }
    if ((i + 1) % 250 === 0) console.log(`  ${wiki}: ${i + 1}/${list.length} docs, ${cards.length} cards, ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  fs.closeSync(fd);
  console.log(`  ${wiki}: ${docs.length} docs with tags, ${cards.length} cards, ${failed} unreadable, ${Math.round((Date.now() - t0) / 1000)}s`);
  return { v: 1, wiki, built: new Date().toISOString(), zip: { name: zipName, url: zipUrl }, schools, docs, cards };
}

const gz = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 9 });

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error("download " + r.status + " " + url);
  const out = fs.createWriteStream(file);
  const reader = r.body.getReader();
  let got = 0, next = 100e6;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(value)) await new Promise((res) => out.once("drain", res));
    if (got > next) { console.log(`  ${Math.round(got / 1e6)} MB`); next += 100e6; }
  }
  await new Promise((res) => out.end(res));
}

/* ------------------------------------------------------------ run */

if (arg("zip")) {
  const idx = await buildIndex({ wiki: arg("wiki"), zipFile: arg("zip"), zipName: path.basename(arg("url") || arg("zip")), zipUrl: arg("url") || "" });
  const out = gz(idx);
  fs.writeFileSync(arg("out") || arg("wiki") + ".json.gz", out);
  console.log("wrote", (out.length / 1e6).toFixed(1), "MB");
} else if (arg("site")) {
  const site = arg("site").replace(/\/+$/, "");
  const secret = arg("secret") || process.env.UPDATE_SECRET;
  const r = await fetch(site + "/api/tools/caselist/index", { method: "POST", headers: { "x-update-secret": secret } });
  const plan = await r.json();
  if (!r.ok) throw new Error("plan: " + (plan.error || r.status));
  const only = arg("wikis") ? arg("wikis").split(",") : null;
  for (const w of plan.wikis) {
    if (only && !only.includes(w.slug)) continue;
    if (!w.zip) { console.log(w.slug + ": no archive yet"); continue; }
    if (w.current === w.zip.name && !process.argv.includes("--force")) { console.log(w.slug + ": already indexed from " + w.zip.name); continue; }
    console.log(w.slug + ": " + w.zip.name);
    const file = path.join(os.tmpdir(), w.zip.name);
    await download(w.zip.url, file);
    const idx = await buildIndex({ wiki: w.slug, zipFile: file, zipName: w.zip.name, zipUrl: w.zip.url, schools: w.schools || {} });
    fs.rmSync(file, { force: true });
    const body = gz(idx);
    const up = await fetch(w.upload, { method: "PUT", headers: { "content-type": "application/gzip", "x-upsert": "true" }, body });
    if (!up.ok) throw new Error(w.slug + " upload " + up.status + " " + (await up.text()));
    // the note beside it, written after the index so it never points at one that is not there
    const meta = { wiki: w.slug, built: idx.built, zip: idx.zip, docs: idx.docs.length, cards: idx.cards.length, bytes: body.length };
    const um = await fetch(w.uploadMeta, { method: "PUT", headers: { "content-type": "application/json", "x-upsert": "true" }, body: JSON.stringify(meta) });
    if (!um.ok) throw new Error(w.slug + " meta upload " + um.status + " " + (await um.text()));
    console.log(`  ${w.slug}: uploaded ${(body.length / 1e6).toFixed(1)} MB`);
  }
} else {
  console.log("usage: --site URL --secret S [--wikis a,b] [--force]  |  --zip file --wiki slug [--url u] [--out f]");
}
