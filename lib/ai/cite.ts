/**
 * Cite from link: an article's address in, a cite in your cite format out.
 *
 * coda's server reads the page (app/api/tools/page) for what it says about
 * itself — title, authors, date, publication, the opening of its text — and
 * Claude sorts that into the cite's parts, taking the author's credentials
 * from the article where it states them and inventing nothing. The parts are
 * then written by the same code as Reformat's cites (lib/cutter/cites.ts
 * writeCite), in the format set under Keys: the surname and year bold at
 * 13pt, the rest at the body's size, a part the page didn't have left out.
 */
import { z } from "zod";
import { apiBase } from "@/lib/desktop";
import type { CiteParts } from "@/lib/cutter/cites";
import { askJson, AiError } from "./claude";

export interface Page {
  url: string; finalUrl: string; kind: "html" | "pdf";
  title: string; site: string; authors: string[]; published: string; description: string; text: string;
}

export async function readPage(url: string, signal?: AbortSignal): Promise<Page> {
  let r: Response;
  try { r = await fetch(apiBase() + "/api/tools/page?url=" + encodeURIComponent(url), { cache: "no-store", signal }); }
  catch (e) { throw (e instanceof Error && e.name === "AbortError") ? new AiError("Stopped.") : new AiError("Can't reach coda to read that page — check the internet connection."); }
  const j = await r.json().catch(() => ({ error: "coda had a problem (" + r.status + ")" }));
  if (!r.ok) throw new AiError(String(j.error || "Couldn't read that page."));
  return j as Page;
}

const CiteShape = z.object({
  first: z.string(),
  last: z.string(),
  yy: z.string(),
  quals: z.string(),
  title: z.string(),
  date: z.string(),
  publication: z.string(),
});

function prompt(p: Page): string {
  return `You write the citation for a piece of debate evidence from the page it came from. Use only what the page says. Never invent a name, credential, date or title: leave a field "" when the page doesn't give it.

THE PAGE
Address: ${p.finalUrl || p.url}
Title tag: ${p.title || "(none)"}
Site / publication: ${p.site || "(none)"}
Authors listed in the page's metadata: ${p.authors.length ? p.authors.join("; ") : "(none)"}
Published (metadata): ${p.published || "(none)"}
Description: ${p.description || "(none)"}
Opening of the text:
${p.text ? p.text.slice(0, 9000) : "(no text could be read)"}

THE FIELDS
- "first": the first author's given name(s), e.g. "Aleksander" (with a middle initial if given). "" for an organization.
- "last": the first author's surname, e.g. "Olech". With two authors, "Olech and Smith"; with three or more, "Olech et al". For a report with no person named, the organization's short name, e.g. "RAND" or "CRS".
- "yy": the 2-digit year it was published, e.g. "26". "" if there is no date.
- "quals": the author's credentials as the page states them, one sentence without a trailing period, e.g. "Senior Analyst at the National Institute for Public Policy". Take them from an author bio, byline or "about the author" in the text. "" if the page doesn't say.
- "title": the article's own title, without the site's name tacked on (" | The Atlantic", " - Reuters").
- "date": the publication date as M-D-YYYY, e.g. "2-19-2026"; "4-2026" or "2026" if that's all there is. "" if none.
- "publication": the outlet or journal, e.g. "Foreign Affairs", "Defence24". Not the address.`;
}

/** The cite's parts, ready for writeCite. */
export async function citeFromLink(key: string, url: string, signal?: AbortSignal): Promise<CiteParts> {
  const page = await readPage(url, signal);
  const c = await askJson(key, prompt(page), CiteShape, signal);
  const last = c.last.trim(), yy = c.yy.replace(/\D/g, "").slice(-2);
  if (!last && !c.title.trim()) throw new AiError("Claude couldn't find an author or a title on that page.");
  return {
    first: c.first.trim(),
    short: (last || page.site || "").trim() + (yy ? " " + yy : ""),
    quals: c.quals.trim().replace(/\.+$/, ""),
    title: c.title.trim(),
    date: c.date.trim(),
    pub: c.publication.trim(),
    url: page.finalUrl || page.url || url,
    doa: "",
    credit: "",
  };
}
