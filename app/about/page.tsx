import Nav from "@/components/Nav";

export const metadata = { title: "Scoring · The Break" };

export default function About() {
  return (
    <>
      <Nav />
      <main>
        <section className="view enter">
          <div className="thead"><h1 className="reveal">How the <em style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400 }}>scoring</em> works</h1></div>
          <div className="prose reveal" style={{ marginTop: 28 }}>
            <p><b>Each round is worth the same.</b> A correct call in the opening round is 1 point, and the value doubles every round — 2, 4, 8, 16 and so on. Because each round has half as many matches as the one before, every round adds up to the same total. A 32-team bracket has 16 points available in each of its five rounds; a 128-team bracket has 64 in each of seven.</p>
            <p><b>Upsets pay extra.</b> When the team you called was the lower seed, you also get 1 bonus point for every 4 seeds of gap (every 8 seeds in fields of 64 or more), capped at twice the round&rsquo;s base value. Calling 31 over 2 in doubles is worth 3; calling it in a final is worth a lot more.</p>
            <p><b>Picks lock two ways.</b> Lock your whole bracket yourself, or leave it open — either way a match becomes unchangeable the instant its real result is reported. Points still in play counts only matches whose outcome is unknown and where your pick has not already been eliminated.</p>
            <p><b>Results come from Tabroom.</b> They are pulled in automatically while the tournament runs. A match with no posted decision stays unjudged; when the next round shows who advanced, that team is marked as having advanced rather than winning on a ballot count.</p>
            <p><b>Rounds that finished before the pool opened don&rsquo;t count.</b> If a tournament is added mid-elims, the already-decided early rounds are shown for context but score nothing — everyone starts even from the first round that was still open.</p>
          </div>
        </section>
      </main>
    </>
  );
}
