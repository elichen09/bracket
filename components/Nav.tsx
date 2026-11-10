"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useUser, userName, signOut } from "@/lib/account";

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const path = usePathname();
  const router = useRouter();
  const user = useUser();
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  // the tools are the site: the one most rounds are spent in, the flow, the rest, and how they work
  const at = (p: string) => (path === p || path.startsWith(p + "/") ? "on" : "");
  return (
    <nav className={"nav" + (scrolled ? " scrolled" : "")}>
      <Link className="brand" href="/">THE BREAK</Link>
      <div className="links mono">
        <Link href="/tools/magic" className={at("/tools/magic")}>Round Magic</Link>
        <Link href="/tools/flow" className={"opt " + at("/tools/flow")}>Flow</Link>
        <Link href="/tools" className={path === "/tools" ? "on" : ""}>All tools</Link>
        <Link href="/tools/tutorial" className={"opt " + at("/tools/tutorial")}>Tutorial</Link>
        {user === undefined ? null : user ? (
          <span className="who-nav">
            <span className="uname">{userName(user)}</span>
            <button className="linkish" onClick={async () => { await signOut(); router.replace("/"); router.refresh(); }}>Sign out</button>
          </span>
        ) : (
          <Link href="/login" className={"cta" + (path === "/login" ? " on" : "")}>Sign in</Link>
        )}
      </div>
    </nav>
  );
}
