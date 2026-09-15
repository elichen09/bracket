"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const path = usePathname();
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
      </div>
    </nav>
  );
}
