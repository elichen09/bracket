"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import AdminUpdate from "@/components/AdminUpdate";
import { useTournaments, getMine } from "@/lib/useBreak";
import { model, progress } from "@/lib/bracket";
import type { Tournament } from "@/lib/types";

export default function Home() {
  const tournaments = useTournaments();
  const router = useRouter();
  const list = tournaments || [];
  const liveCount = list.filter((t) => {
    if (!t.slots.length) return false;
    const P = progress(model(t));
    return !P.complete && P.done > 0;
  }).length;

  return (
    <>
      <Nav />
      <main>
        <section className="view enter">
          <div className="hero">
            <p className="lede reveal">
              Bracket pools for debate elims. Fill in a bracket before the round breaks, lock it,
              and watch it score itself as Tabroom posts results. <b>Every round is worth the same</b> —
              late calls pay as much as early ones, and upsets pay extra.
            </p>
            <h1><span className="w"><span>The</span></span> <span className="w"><span><em>Break</em></span></span></h1>
            <div className="meta mono">
              <span>{list.length} tournament{list.length === 1 ? "" : "s"}</span>
              <span>{liveCount ? `${liveCount} live` : "pick·em pool"}</span>
            </div>
          </div>

          <div className="index">
            {tournaments === null ? (
              <div className="empty">Loading…</div>
            ) : list.length === 0 ? (
              <div className="empty">No tournaments yet. <Link href="/new">Add one</Link>.</div>
            ) : (
              list.map((t, i) => <Row key={t.id} t={t} i={i} onOpen={() => router.push(`/t/${t.id}`)} />)
            )}
          </div>

          <div className="howto">
            <div className="reveal"><h3>Pick</h3><p>Click the team that wins each match; they carry forward. Everything upstream of a change clears, so a bracket is always <em>internally consistent</em>.</p></div>
            <div className="reveal"><h3>Lock</h3><p>Once you lock, nothing moves. Matches also lock on their own the moment a real result lands — there is no picking after the fact.</p></div>
            <div className="reveal"><h3>Score</h3><p>Doubling points by round, so every round is worth the same total. Call a lower seed correctly and take a bonus on top, capped at double.</p></div>
          </div>

          <AdminUpdate />
        </section>
      </main>
    </>
  );
}

function Row({ t, i, onOpen }: { t: Tournament; i: number; onOpen: () => void }) {
  const M = model(t);
  const P = progress(M);
  const mine = typeof window !== "undefined" ? getMine(t.id) : null;
  let status: string, pill: React.ReactNode;
  if (!M.size) { status = "waiting for bracket"; pill = <span className="pill">Pending</span>; }
  else if (P.complete) { status = `won by ${P.champ!.name}`; pill = <span className="pill done">Final</span>; }
  else if (P.done === 0) { status = "open for picks"; pill = <span className="pill">Open</span>; }
  else { status = `${M.names[P.liveRound!]} in play`; pill = <span className="pill live">Live</span>; }
  const sub = (t.event || "") + (M.size ? ` · ${M.teamCount} teams` : "");
  return (
    <div className={"row reveal" + (M.size ? "" : " pending")} onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}>
      <div className="n">{String(i + 1).padStart(2, "0")}</div>
      <div className="t">{t.name}{pill}<small>{sub}</small></div>
      <div className="s mono"><b>{status}</b>{mine ? "your bracket in" : ""}</div>
      <div className="s mono">{mine ? "yours ↗" : ""}</div>
      <div className="a">→</div>
    </div>
  );
}
