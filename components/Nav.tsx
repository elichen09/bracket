"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useUser, userName, signOut } from "@/lib/useBreak";

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
  const active = (which: string) => {
    if (which === "home") return path === "/" || path.startsWith("/t/");
    if (which === "new") return path === "/new";
    if (which === "about") return path === "/about";
    return false;
  };
  return (
    <nav className={"nav" + (scrolled ? " scrolled" : "")}>
      <Link className="brand" href="/">THE BREAK</Link>
      <div className="links mono">
        <Link href="/" className={active("home") ? "on" : ""}>Tournaments</Link>
        <Link href="/new" className={active("new") ? "on" : ""}>Add tournament</Link>
        <Link href="/about" className={active("about") ? "on" : ""}>Scoring</Link>
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
