import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { currentUser } from "@/lib/auth";
import { loadField } from "@/lib/field";
import {
  loadRatings, ratingIndex, loadRosters, buildTeamIndex, resolveRating, headToHead, canonCode,
  pastSeasonPriors, type RatingRow,
} from "@/lib/ratings";
import { careersDeep } from "@/lib/careerArchive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * One entry in a tournament that has not debated yet: what the rating thinks of
 * the pairing, each debater's record across seasons, and who in this field they
 * have met before.
 *
 * The bracket dossier cannot serve this. It compiles a team's weekend from a
 * published result set, and an upcoming tournament has none — so this reads the
 * debaters' own Tabroom records instead, which is where their history lives.
 */
export async function GET(req: Request, { params }: { params: { tid: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "sign in required" }, { status: 401 });

  const code = (new URL(req.url).searchParams.get("code") || "").trim();
  if (!code) return NextResponse.json({ error: "code is required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: t } = await db.from("tournaments")
    .select("id,name,event,tabroom_tourn_id,tabroom_event_abbr").eq("id", params.tid).maybeSingle();
  if (!t) return NextResponse.json({ error: "no such tournament" }, { status: 404 });
  if (!t.tabroom_tourn_id || !t.tabroom_event_abbr) {
    return NextResponse.json({ error: "this tournament has no Tabroom event on file" }, { status: 404 });
  }

  try {
    const [raw, teamRows, debRows, rosters, priors] = await Promise.all([
      loadField(t.tabroom_tourn_id, t.tabroom_event_abbr),
      loadRatings(db, "team"),
      loadRatings(db, "debater"),
      loadRosters(db),
      pastSeasonPriors(db),
    ]);
    const entry = raw.find((e) => canonCode(e.code) === canonCode(code));
    if (!entry) return NextResponse.json({ error: `"${code}" is not in this field` }, { status: 404 });

    const teamIdx = buildTeamIndex(teamRows, rosters);
    const debIdx = ratingIndex(debRows);
    const ids = (entry.Students || []).map((s) => s.id).filter(Boolean);
    const resolved = resolveRating(entry.code, ids, teamIdx, debIdx, priors);

    // Each listed debater's own record, assembled from the tournaments this site
    // has read in rather than scraped from their Tabroom page. Tabroom names only
    // one of the pair before a tournament starts, so the partner appears here once
    // rounds are posted.
    const careers = await careersDeep(db, ids);
    const students = (entry.Students || []).map((s) => {
      const career = careers.get(s.id) ?? null;
      const prior = priors.debaters.get(String(s.id));
      const season = debIdx.get(String(s.id)) as RatingRow | undefined;
      return {
        id: s.id,
        name: `${s.firstName || ""} ${s.lastName || ""}`.trim() || `Debater ${s.id}`,
        career: career && !career.empty ? career : null,
        note: !career || career.empty
          ? "No record came back for this debater — Tabroom's results page is unreliable, and nothing of theirs has been read in yet"
          : null,
        careerRating: prior ? { rating: Math.round(prior.rating), rd: Math.round(prior.rd), games: 0, wins: 0, losses: 0 } : null,
        seasonRating: season ? { rating: Math.round(season.rating), rd: Math.round(season.rd), games: season.games, wins: season.wins, losses: season.losses } : null,
      };
    });

    const h2h = await headToHead(db, [entry.code]);
    const own = resolved.row;

    return NextResponse.json({
      tournament: { id: t.id, name: t.name, event: t.event },
      entry: {
        code: entry.code,
        name: entry.name || "",
        school: entry.School?.name || null,
      },
      rating: {
        value: resolved.rated ? Math.round(resolved.rating.rating) : null,
        rd: resolved.rated ? Math.round(resolved.rating.rd) : null,
        source: resolved.source,
        matched: own ? own.key : null,
      },
      season: own ? {
        rating: Math.round(own.rating), rd: Math.round(own.rd),
        wins: own.wins, losses: own.losses, games: own.games,
        tournaments: own.tournaments, pointsAvg: own.points_avg,
        history: own.history,
      } : null,
      students,
      h2h: h2h[canonCode(entry.code)] || {},
      fieldCodes: raw.map((e) => e.code),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "could not load this entry" }, { status: 502 });
  }
}
