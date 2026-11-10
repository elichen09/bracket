import Link from "next/link";
import Nav from "@/components/Nav";
import Strata from "@/components/Strata";
import { TOOLS } from "@/lib/tools";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";      // who is signed in is read from a cookie

/**
 * The front page: what The Break is now — the tools a debater works a round
 * in — and the way into each. Round Magic is the one most rounds are spent
 * in, so it is the way in.
 */
export default async function Home() {
  const user = await currentUser();
  return (
    <>
      <Nav />
      <main className="landing">
        <section className="hero2">
          <div className="hero-copy">
            <div className="hero-top mono">
              <span>Tools for the round</span>
              <span className="dotline" />
              <span>{TOOLS.length} tools · one window</span>
            </div>
            <h1 className="giant" aria-label="The Break">
              <span className="w"><span>THE</span></span>
              <span className="w"><span><em>Break</em></span></span>
            </h1>
            <div className="hero-foot">
              <p className="lede2">
                Cut cards by key. Search your library and the caselist as fast as you type. Build the speech doc
                with your partner in the same file. Read the other team&apos;s doc, and flow the round —
                without leaving the window.
              </p>
              <div className="cta-row">
                {user ? (
                  <>
                    <Link className="btn-big" href="/tools/magic">Open Round Magic <i>→</i></Link>
                    <Link className="btn-ghost" href="/tools/tutorial">The tutorial</Link>
                  </>
                ) : (
                  <>
                    <Link className="btn-big" href="/login?mode=up">Create account <i>→</i></Link>
                    <Link className="btn-ghost" href="/login">Sign in</Link>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <Strata palette="dusk" />
            <div className="grain" />
            <span className="art-tag mono">Fig. 01 — the break</span>
          </div>
        </section>

        <section className="toolsec" id="tools">
          <div className="index">
            {TOOLS.map((t, i) => (
              <Link key={t.slug} href={`/tools/${t.slug}`} className="row toolrow">
                <span className="n">{String(i + 1).padStart(2, "0")}</span>
                <span className="t">{t.name}<small>{t.blurb}</small></span>
                <span className="s mono">{t.storage.split("—")[0].trim()}</span>
                <span className="a">→</span>
              </Link>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 28 }}>
            Everything you make is kept in your own browser, apart per account. Nothing is uploaded unless you share it:
            a file you share with a partner, or a room for the speech doc.
          </p>
        </section>
      </main>
    </>
  );
}
