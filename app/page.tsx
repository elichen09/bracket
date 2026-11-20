import Link from "next/link";
import Grain from "@/components/Grain";
import { currentUser } from "@/lib/auth";
import s from "./landing.module.css";

export const dynamic = "force-dynamic";      // who is signed in is read from a cookie

/**
 * The front page — "coda · Ink": the name settles out of the
 * static, and the way in fades up. Signed in, the way in is the app;
 * signed out, it is an account.
 */
export default async function Home() {
  const user = await currentUser();
  return (
    <main className={s.page}>
      <Grain className={s.grain} />

      <header className={`${s.top} ${s.fade}`}>
        {user
          ? <Link href="/tools/magic" className={s.link}>Open coda</Link>
          : <Link href="/login" className={s.link}>Sign in</Link>}
      </header>

      <h1 className={s.word}>coda</h1>

      <div className={`${s.ctas} ${s.fade}`}>
        {user ? (
          <>
            <Link href="/tools/magic" className={`${s.btn} ${s.primary}`}>Open coda</Link>
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
