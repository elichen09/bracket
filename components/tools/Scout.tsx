"use client";

/**
 * The scout card: what a team reads, before you hit them.
 *
 * Type the team (from the caselist's loaded wikis). From the index already on
 * this computer — so it works offline — it shows, side by side, the positions
 * they read most (the block headings of their disclosed documents, by how many
 * documents carry them) and, folded, the cards they read most. From
 * openCaselist itself, when there is internet (kept for when there isn't):
 * their recent rounds — when, where, which side, against whom, what they went
 * for — with this week's marked new.
 *
 * Each position, and each side's whole case, can be prepped against: that is
 * RoundMagic's prepAgainst (Find blocks over every argument, into a file).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { caselistClient, familyOf, SHORT as SHORT_ } from "@/lib/caselist/client";

const SHORT = SHORT_ as Record<string, string>;
import { scoped } from "@/lib/owner";

type Card = { id: string; slug: string; ci: number; path: string; d: unknown[]; doc: number; tag: string; cite: string; rounds: number; block: string };
type Team = { slug: string; school: string; team: string; name: string; rank?: { rank: number } | null };
type Round = { id: number; side: string; tournament: string; round: string; opponent: string; judge: string; report: string; at: string | null };
type Cite = { round: number; title: string; side: string };

export interface PrepGroup { title: string; cards: Card[] }
export interface PrepTarget { team: string; title: string; groups: PrepGroup[]; analytics: boolean }

interface Props {
  owner: string | null;
  /** the caselist is there to scout from (the app: signed in, or something kept) */
  ready: boolean;
  aiReady: boolean;
  toast: (m: string) => void;
  onPrep: (p: PrepTarget) => void;
  onSend: (card: Card, team: string) => void;
}

/** A document's side, from its name: openCaselist's files say Aff/Neg (PF: Pro/Con). */
function sideOf(path: string): "aff" | "neg" | "" {
  const f = (path.split("/").pop() || "").replace(/\.[a-z]+$/i, "");
  const m = f.match(/(?:^|[-_ ])(aff|neg|pro|con)(?=$|[-_ .\d])/i);
  return m ? (/^(aff|pro)$/i.test(m[1]) ? "aff" : "neg") : "";
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** A heading or tournament as people write it: "Quantum---1AC" → "Quantum — 1AC", "04---MinneApple" → "MinneApple". */
const nice = (s: string) => s.replace(/\s*-{2,}\s*/g, " — ").replace(/^\d+\s*—\s*/, "").trim();
/**
 * A position as arguments to prep against: a whole case filed under one heading
 * would be read as one argument from its first few cards, so a long one is taken
 * a few cards at a time, in its order.
 */
function argumentsOf(p: { title: string; cards: Card[] }): PrepGroup[] {
  const t = nice(p.title);
  if (p.cards.length <= 6) return [{ title: t, cards: p.cards }];
  const parts = Math.min(4, Math.ceil(p.cards.length / 5)), per = Math.ceil(p.cards.length / parts);
  return Array.from({ length: parts }, (_, i) => ({ title: t + " (" + (i + 1) + " of " + parts + ")", cards: p.cards.slice(i * per, (i + 1) * per) }));
}
const WEEK = 7 * 864e5;
const when = (s: string | null) => { if (!s) return ""; const d = new Date(s.replace(" ", "T") + "Z"); return isNaN(+d) ? "" : d.toLocaleDateString([], { month: "short", day: "numeric" }); };
const isNew = (s: string | null) => { if (!s) return false; const d = new Date(s.replace(" ", "T") + "Z"); return Date.now() - +d < WEEK; };

/** Find blocks takes about half a minute an argument (more with analytics), two at a time. */
const minutes = (n: number, analytics: boolean) => Math.max(1, Math.round((Math.ceil(n / 2) * (analytics ? 45 : 30)) / 60));

interface Position { key: string; title: string; docs: Set<number>; cards: Card[]; rounds: number }

/** The positions on one side: block headings, by how many of their documents carry them. */
function positionsOf(cards: Card[]): Position[] {
  const by = new Map<string, Position>();
  for (const c of cards) {
    const title = c.block.trim();
    if (!title) continue;
    const key = norm(title).slice(0, 80);
    let p = by.get(key);
    if (!p) { p = { key, title, docs: new Set(), cards: [], rounds: 0 }; by.set(key, p); }
    p.docs.add(c.doc);
    p.rounds = Math.max(p.rounds, c.rounds);
    p.cards.push(c);
  }
  const list = [...by.values()];
  list.forEach((p) => {
    // the cards as one document has them: the one with the most of this position's cards, in its order
    const per = new Map<number, Card[]>();
    p.cards.forEach((c) => { const l = per.get(c.doc) || []; l.push(c); per.set(c.doc, l); });
    const best = [...per.values()].sort((a, b) => b.length - a.length)[0] || [];
    const seen = new Set<string>();
    p.cards = best.sort((a, b) => a.ci - b.ci).filter((c) => { const k = norm(c.tag); if (seen.has(k)) return false; seen.add(k); return true; });
  });
  return list.sort((a, b) => b.docs.size - a.docs.size || b.rounds - a.rounds).slice(0, 8);
}

export default function Scout({ owner, ready, aiReady, toast, onPrep, onSend }: Props) {
  const cl = useMemo(() => (ready ? (caselistClient(owner, scoped) as any) : null), [ready, owner]);
  const KEY = scoped("round.opponent", owner);
  const fams = useMemo(() => {
    let f: string[] = ["hspf"];
    try { const v = JSON.parse(localStorage.getItem(scoped("caselist.wikis", owner)) || "null"); if (Array.isArray(v) && v.length) f = v; } catch { /* the default */ }
    return new Set(f);
  }, [owner]);

  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [tick, setTick] = useState(0);                       // the indexes moved: the team list again
  const [who, setWho] = useState<Team | null>(null);
  const [data, setData] = useState<{ name: string; cards: Card[] } | null>(null);
  const [rounds, setRounds] = useState<{ rounds: Round[]; cites: Cite[]; kept: boolean } | null>(null);
  const [roundsErr, setRoundsErr] = useState("");
  const [showCards, setShowCards] = useState(false);
  const [openReport, setOpenReport] = useState<number | null>(null);
  const [ask, setAsk] = useState<null | { title: string; groups: PrepGroup[]; analytics: boolean }>(null);
  const input = useRef<HTMLInputElement | null>(null);

  // the indexes, loaded (or loading) for the events chosen in the caselist search
  useEffect(() => {
    if (!cl) return;
    const off = cl.on((what: string) => { if (what === "index" || what === "metas" || what === "ranks") setTick((n) => n + 1); });
    return off;
  }, [cl]);
  const warm = () => { if (cl) void cl.warm(fams); };

  // the team you were scouting, back
  useEffect(() => {
    try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v && v.slug) { setWho(v); warm(); } } catch { /* none */ }
  }, [KEY]); // eslint-disable-line react-hooks/exhaustive-deps

  const all: Team[] = useMemo(() => (cl ? cl.teams(fams) : []), [cl, fams, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const hits = useMemo(() => {
    const words = norm(q).split(" ").filter(Boolean);
    if (!words.length) return [];
    return all.filter((t) => { const n = norm(t.name + " " + t.school + " " + t.team); return words.every((w) => n.includes(w)); })
      .sort((a, b) => (a.rank?.rank ?? 1e6) - (b.rank?.rank ?? 1e6)).slice(0, 8);
  }, [q, all]);

  // the team chosen: its disclosure (the index here), its rounds (openCaselist, or as last seen)
  useEffect(() => {
    if (!cl || !who) { setData(null); setRounds(null); return; }
    let gone = false;
    setData(null); setRounds(null); setRoundsErr(""); setShowCards(false); setAsk(null);
    const load = async () => {
      // its index: what the server has first (or what was kept), then the index itself
      if (!cl.st.idx.has(who.slug)) { await cl.metas().catch(() => null); await cl.loadIndex(who.slug).catch(() => null); }
      const t = await cl.team(who.slug, who.school, who.team).catch(() => null);
      if (!gone) setData(t ? { name: t.name, cards: t.cards } : { name: who.name, cards: [] });
    };
    void load();
    cl.rounds(who.slug, who.school, who.team).then((r: any) => { if (!gone) setRounds(r); }).catch((e: Error) => { if (!gone) setRoundsErr(e.message); });
    return () => { gone = true; };
  }, [cl, who]);

  const choose = (t: Team) => {
    setWho(t); setQ(""); setOpen(false);
    try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* not kept */ }
  };

  const sides = useMemo(() => {
    if (!data) return null;
    const aff = data.cards.filter((c) => sideOf(c.path) === "aff"), neg = data.cards.filter((c) => sideOf(c.path) === "neg");
    const docs = (cs: Card[]) => new Set(cs.map((c) => c.doc)).size;
    return {
      aff: { docs: docs(aff), positions: positionsOf(aff) },
      neg: { docs: docs(neg), positions: positionsOf(neg) },
      top: [...new Map(data.cards.map((c) => [norm(c.tag), c])).values()].sort((a, b) => b.rounds - a.rounds).slice(0, 8),
    };
  }, [data]);

  const recent = useMemo(() => {
    if (!rounds) return [];
    const titles = new Map<number, string[]>();
    rounds.cites.forEach((c) => { const l = titles.get(c.round) || []; if (c.title) l.push(c.title); titles.set(c.round, l); });
    return [...rounds.rounds].filter((r) => !/^all$/i.test(r.round))
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 6)
      .map((r) => ({ ...r, cites: titles.get(r.id) || [] }));
  }, [rounds]);
  const fresh = recent.filter((r) => isNew(r.at)).length;

  const prepAsk = (title: string, groups: PrepGroup[]) => {
    if (!aiReady) { toast("Add your Anthropic key first — ✦, top right"); return; }
    if (!groups.length) { toast("No cards under that to prep against"); return; }
    setAsk({ title, groups: groups.slice(0, 10), analytics: false });
  };
  const sideName = (s: "aff" | "neg") => (who && familyOf(who.slug) === "hspf" ? (s === "aff" ? "Pro" : "Con") : s === "aff" ? "Aff" : "Neg");

  if (!ready) {
    return <p className="rm-sempty">Sign into openCaselist (Search → Caselist) and the team you&apos;re hitting is scouted here: what they read, what they went for.</p>;
  }

  return (
    <div className="rm-scout">
      <div className="rm-sdform rm-scoutq">
        <input ref={input} value={q} placeholder={who ? "Another team…" : "Their school and team code"} spellCheck={false} aria-label="The team you're hitting"
          onFocus={() => { warm(); setOpen(true); }} onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { warm(); setQ(e.target.value); setSel(0); setOpen(true); }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === "Enter" && hits[sel]) { e.preventDefault(); choose(hits[sel]); input.current?.blur(); }
            else if (e.key === "Escape") { setQ(""); input.current?.blur(); }
          }} />
      </div>
      {open && q.trim() && (
        <div className="rm-scouthits" role="listbox">
          {hits.length ? hits.map((t, i) => (
            <button key={t.slug + t.school + t.team} type="button" role="option" aria-selected={i === sel} className={"rm-hit" + (i === sel ? " on" : "")}
              onMouseDown={(e) => { e.preventDefault(); choose(t); }}>
              <b>{t.name}</b><span>{SHORT[familyOf(t.slug)] || t.slug}{t.rank ? " · #" + t.rank.rank : ""}</span>
            </button>
          )) : <p className="rm-sempty">{all.length ? "No team by that name in " + [...fams].map((f) => SHORT[f] || f).join(", ") + "." : "Loading the caselist…"}</p>}
        </div>
      )}

      {who && (
        <div className="rm-scoutcard">
          <div className="rm-scouthead">
            <b>{data?.name || who.name}</b>
            <span>{SHORT[familyOf(who.slug)] || who.slug}{who.rank ? " · #" + who.rank.rank : ""}{fresh ? <i className="new">{fresh} new this week</i> : null}</span>
            <button type="button" className="rm-scoutx" aria-label="Stop scouting them" title="Stop scouting them" onClick={() => { setWho(null); try { localStorage.removeItem(KEY); } catch { /* fine */ } }}>×</button>
          </div>

          {!data ? <p className="rm-sempty">Reading their disclosure…</p> : !data.cards.length ? <p className="rm-sempty">Nothing they&apos;ve disclosed is in the caselist index yet.</p> : sides && (["aff", "neg"] as const).map((s) => sides[s].docs ? (
            <div key={s} className="rm-scoutside">
              <div className="rm-scoutcap">
                <span>{sideName(s).toUpperCase()} · {sides[s].docs} {sides[s].docs === 1 ? "DOC" : "DOCS"}</span>
                {sides[s].positions.length > 0 && <button type="button" className="rm-linkbtn" onClick={() => prepAsk(sideName(s) + " case", sides[s].positions.slice(0, 6).flatMap(argumentsOf))}>PREP ALL</button>}
              </div>
              {sides[s].positions.map((p) => (
                <div key={p.key} className="rm-scoutpos">
                  <span className="t" title={p.title}>{nice(p.title)}</span>
                  <span className="n" title={`In ${p.docs.size} of their ${s === "aff" ? sideName("aff") : sideName("neg")} documents`}>{p.docs.size}</span>
                  <button type="button" className="rm-linkbtn" onClick={() => prepAsk(nice(p.title), argumentsOf(p))} title="Find your answers to it, into a file">PREP</button>
                </div>
              ))}
              {!sides[s].positions.length && <p className="rm-sempty">Their documents here have no block headings to name positions by.</p>}
            </div>
          ) : null)}

          {ask && (
            <div className="rm-scoutask">
              <p>Prep against <b>{ask.title}</b>: {ask.groups.length} {ask.groups.length === 1 ? "argument" : "arguments"}, about {minutes(ask.groups.length, ask.analytics)} min. Your library and the caselist are searched; it runs on your Anthropic key, and you can keep working.</p>
              <label><input type="checkbox" checked={ask.analytics} onChange={(e) => setAsk({ ...ask, analytics: e.target.checked })} /> Also write analytics</label>
              <div className="rm-scoutacts">
                <button type="button" className="pri" onClick={() => { const a = ask; setAsk(null); onPrep({ team: data?.name || who.name, title: a.title, groups: a.groups, analytics: a.analytics }); }}>START</button>
                <button type="button" onClick={() => setAsk(null)}>CANCEL</button>
              </div>
            </div>
          )}

          {sides && sides.top.length > 0 && (
            <div className="rm-scoutside">
              <button type="button" className="rm-scoutfold" aria-expanded={showCards} onClick={() => setShowCards((v) => !v)}>{showCards ? "▾" : "▸"} MOST-READ CARDS</button>
              {showCards && sides.top.map((c) => (
                <div key={c.id} className="rm-scoutcardrow">
                  <span className="t" title={c.cite}>{c.tag}</span>
                  <span className="n" title={`Read in ${c.rounds} rounds`}>{c.rounds}×</span>
                  <button type="button" className="rm-linkbtn" onClick={() => onSend(c, data?.name || who.name)} title="To the speech doc">SEND</button>
                </div>
              ))}
            </div>
          )}

          <div className="rm-scoutside">
            <div className="rm-scoutcap"><span>RECENT ROUNDS{rounds?.kept ? " · AS LAST SEEN" : ""}</span></div>
            {roundsErr && !rounds ? <p className="rm-sempty">{/internet|fetch|network/i.test(roundsErr) ? "Their rounds need the internet the first time." : "Their rounds didn't come: " + roundsErr}</p>
              : !rounds ? <p className="rm-sempty">Asking openCaselist…</p>
              : !recent.length ? <p className="rm-sempty">No rounds reported.</p>
              : recent.map((r) => (
                <div key={r.id} className="rm-scoutround">
                  <div className="h">
                    {isNew(r.at) && <i className="new">NEW</i>}
                    <span>{when(r.at)} · {nice(r.tournament)}{r.round ? " " + r.round : ""} · {r.side === "A" ? sideName("aff") : r.side === "N" ? sideName("neg") : r.side}{r.opponent ? " vs " + r.opponent : ""}</span>
                  </div>
                  {r.cites.length > 0 && <div className="c" title={r.cites.join(" · ")}>{r.cites.join(" · ")}</div>}
                  {r.report && (
                    <button type="button" className={"rep" + (openReport === r.id ? " open" : "")} onClick={() => setOpenReport(openReport === r.id ? null : r.id)} title="What they went for, as they reported it">
                      {r.report}
                    </button>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
