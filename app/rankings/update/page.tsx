import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import RankUpdate from "@/components/RankUpdate";
import { isAdmin } from "@/lib/admin";

export const metadata = { title: "Update the rankings · The Break" };
export const dynamic = "force-dynamic";

/** Paste a tournament, choose the ranking, and it is read in. Admin only. */
export default function UpdateRankings() {
  return (
    <>
      <Nav />
      <main>
        <section className="view enter">
          {isAdmin() ? (
            <>
              <div className="thead">
                <p className="crumb mono reveal">Rankings · from a tournament</p>
                <h1 className="reveal">Update the <em style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400 }}>rankings</em></h1>
                <p className="prose reveal">
                  Paste a tournament from Tabroom and choose the ranking it counts towards. Its rounds are read in and that
                  ranking is rebuilt — every other one is left as it is.
                </p>
              </div>
              <RankUpdate />
            </>
          ) : (
            <AdminGate what="Updating the rankings" />
          )}
        </section>
      </main>
    </>
  );
}
