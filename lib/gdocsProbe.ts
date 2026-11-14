/**
 * A check of how Google Docs really takes list writes — run once, on a scratch Doc in your Drive.
 *
 * Google's documentation leaves out how a list line written by the API decides its level: whether a
 * leading tab counts when the line is already in a list, when it's at the start of the range, and how
 * lines join the list above them. So each way of putting a lettered response under a numbered argument
 * is tried on its own fresh list, and what Google made of it — each line's list, level and glyph — is
 * read back and reported. Then whether tabs can be added (for sending the speech doc to its own tab).
 */

import { getToken } from "./gdocsApi";

async function call(path: string, init: RequestInit = {}) {
  const t = await getToken(false);
  const r = await fetch("https://docs.googleapis.com/v1/" + path, { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + t, "Content-Type": "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j?.error?.message || `HTTP ${r.status}`).slice(0, 300));
  return j;
}
const batch = (id: string, requests: any[]) => call(`documents/${id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });

interface Para { text: string; list: string; level: number; glyph: string; start: number; end: number; indent: number }
async function paras(id: string): Promise<Para[]> {
  const d = await call(`documents/${id}?includeTabsContent=true`);
  const tab = d.tabs[0].documentTab;
  const lists = tab.lists || {};
  return (tab.body.content || []).filter((e: any) => e.paragraph).map((e: any) => {
    const p = e.paragraph, b = p.bullet;
    const level = b ? b.nestingLevel || 0 : -1;
    const glyph = b ? (lists[b.listId]?.listProperties?.nestingLevels?.[level]?.glyphType || lists[b.listId]?.listProperties?.nestingLevels?.[level]?.glyphSymbol || "?") : "";
    return {
      text: (p.elements || []).map((x: any) => x.textRun?.content || "").join("").replace(/\n$/, "").replace(/\t/g, "⇥"),
      list: b ? b.listId : "", level, glyph, start: e.startIndex, end: e.endIndex,
      indent: p.paragraphStyle?.indentStart?.magnitude ?? -1,
    };
  });
}

/** Clear the scratch Doc and lay down three numbered arguments, as a person typing a numbered list would. */
async function fresh(id: string) {
  const ps = await paras(id);
  const end = ps[ps.length - 1].end;
  const reqs: any[] = [];
  if (end > 2) reqs.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } });
  reqs.push({ insertText: { location: { index: 1 }, text: "Arg one\nArg two\nArg three" } });
  reqs.push({ createParagraphBullets: { range: { startIndex: 1, endIndex: 26 }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } });
  await batch(id, reqs);
  const after = await paras(id);
  // the bullet may hang on the empty last paragraph too: that's fine
  return after;
}

const show = (ps: Para[]) => ps.filter((p) => p.text || p.list).map((p) => `${p.level < 0 ? "plain" : "L" + p.level + "/" + p.list.slice(-4) + "/" + p.glyph}  "${p.text}"  indent=${p.indent}`);

export async function runDocsCheck(): Promise<{ docUrl: string; report: string }> {
  const out: string[] = [];
  const doc = await call("documents", { method: "POST", body: JSON.stringify({ title: "The Break — Google Docs check (safe to delete)" }) });
  const id = doc.documentId;
  out.push("doc " + id);

  const tries: [string, (ps: Para[]) => any[]][] = [
    ["A tab, then bullets-off, then UPPERALPHA (what The Break does now)", (ps) => {
      const two = ps[1], P = two.end - 1, from = P + 1, to = P + "\n\tResp".length;
      return [{ insertText: { location: { index: P }, text: "\n\tResp" } }, { deleteParagraphBullets: { range: { startIndex: from, endIndex: to } } }, { createParagraphBullets: { range: { startIndex: from, endIndex: to }, bulletPreset: "NUMBERED_UPPERALPHA_ALPHA_ROMAN" } }];
    }],
    ["B tab, then bullets on [argument..response] with the list's own preset, no bullets-off", (ps) => {
      const two = ps[1], P = two.end - 1;
      return [{ insertText: { location: { index: P }, text: "\n\tResp" } }, { createParagraphBullets: { range: { startIndex: two.start, endIndex: P + "\n\tResp".length }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } }];
    }],
    ["C tab, bullets-off on [argument..response], bullets on the same with the list's preset", (ps) => {
      const two = ps[1], P = two.end - 1, end = P + "\n\tResp".length;
      return [{ insertText: { location: { index: P }, text: "\n\tResp" } }, { deleteParagraphBullets: { range: { startIndex: two.start, endIndex: end } } }, { createParagraphBullets: { range: { startIndex: two.start, endIndex: end }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } }];
    }],
    ["D tab, bullets-off on the whole list, bullets on the whole list", (ps) => {
      const two = ps[1], P = two.end - 1, last = ps[2], end = last.end - 1 + "\n\tResp".length;
      return [{ insertText: { location: { index: P }, text: "\n\tResp" } }, { deleteParagraphBullets: { range: { startIndex: ps[0].start, endIndex: end } } }, { createParagraphBullets: { range: { startIndex: ps[0].start, endIndex: end }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } }];
    }],
    ["E no tab; then a tab typed at the start of the new line, as its own request", (ps) => {
      const two = ps[1], P = two.end - 1;
      return [{ insertText: { location: { index: P }, text: "\nResp" } }, { insertText: { location: { index: P + 1 }, text: "\t" } }];
    }],
    ["F a tab only (nothing else)", (ps) => {
      const two = ps[1], P = two.end - 1;
      return [{ insertText: { location: { index: P }, text: "\n\tResp" } }];
    }],
  ];
  for (const [name, make] of tries) {
    try {
      const ps = await fresh(id);
      await batch(id, make(ps));
      out.push("", "== " + name, ...show(await paras(id)));
    } catch (e) { out.push("", "== " + name, "ERROR " + (e as Error).message); }
  }

  // tabs: can they be added, and nested?
  try {
    const r = await batch(id, [{ addDocumentTab: { tabProperties: { title: "speech doc" } } }]);
    const tabId = r?.replies?.[0]?.addDocumentTab?.tabProperties?.tabId || "";
    out.push("", "== add tab: ok " + JSON.stringify(r?.replies?.[0] || {}).slice(0, 200));
    try {
      const r2 = await batch(id, [{ addDocumentTab: { tabProperties: { title: "(rhetoric speech doc)", parentTabId: tabId } } }]);
      out.push("== add child tab: ok " + JSON.stringify(r2?.replies?.[0] || {}).slice(0, 200));
    } catch (e) { out.push("== add child tab: ERROR " + (e as Error).message); }
  } catch (e) { out.push("", "== add tab: ERROR " + (e as Error).message); }

  return { docUrl: `https://docs.google.com/document/d/${id}/edit`, report: out.join("\n") };
}
