import Link from "next/link";
import Grain from "@/components/Grain";
import { currentUser } from "@/lib/auth";
import s from "./landing.module.css";

export const dynamic = "force-dynamic";      // who is signed in is read from a cookie

/**
 * The front page — "coda · Ink": the C draws itself over static, the name
 * settles under it, and the way in fades up. Signed in, the way in is Round
 * Magic; signed out, it is an account.
 */
export default async function Home() {
  const user = await currentUser();
  return (
    <main className={s.page}>
      <Grain className={s.grain} />

      <header className={`${s.top} ${s.fade}`}>
        {user
          ? <Link href="/tools" className={s.link}>Tools</Link>
          : <Link href="/login" className={s.link}>Sign in</Link>}
      </header>

      <div className={s.center}>
        <svg className={s.mark} role="img" aria-label="coda" width="190" height="190" viewBox="0 0 200 200">
          <text className={s.letter} x="100" y="172" textAnchor="middle" fill="#EDEDEF" stroke="#EDEDEF" strokeWidth="0.9">C</text>
        </svg>
        <h1 className={s.word}>coda</h1>
      </div>

      <div className={`${s.ctas} ${s.fade}`}>
        {user ? (
          <>
            <Link href="/tools/magic" className={`${s.btn} ${s.primary}`}>Open Round Magic</Link>
            <Link href="/tools/tutorial" className={`${s.btn} ${s.ghost}`}>Tutorial</Link>
          </>
        ) : (
          <>
            <Link href="/login?mode=up" className={`${s.btn} ${s.primary}`}>Get started</Link>
            <Link href="/login" className={`${s.btn} ${s.ghost}`}>Sign in</Link>
          </>
        )}
      </div>

      <footer className={`${s.foot} ${s.fade}`}>
        <span>© 2026</span><span>Tools for the round</span>
      </footer>
    </main>
  );
}
