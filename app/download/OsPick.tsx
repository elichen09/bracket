"use client";

import { useEffect, useState } from "react";
import s from "./download.module.css";

/**
 * The two download buttons, the one for the computer reading the page first
 * and bright. Both are always there: the page is read on a phone, or on one
 * computer for another.
 */
export default function OsPick({ win, mac, fallback }: { win: string | null; mac: string | null; fallback: string }) {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => { setIsMac(/Mac|iPhone|iPad/i.test(navigator.userAgent)); }, []);
  const icon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>;
  const W = <a key="w" className={isMac ? s.ctaGhost : s.cta} href={win || fallback}>{icon}Download for Windows</a>;
  const M = <a key="m" className={isMac ? s.cta : s.ctaGhost} href={mac || fallback}>{icon}Download for Mac</a>;
  return <div className={s.ctaRow}>{isMac ? [M, W] : [W, M]}</div>;
}
