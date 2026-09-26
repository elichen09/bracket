"use client";

import { useEffect, useRef, useState } from "react";
import Presence from "./Presence";
import { SHAPE_KEY, THEME_KEY } from "@/lib/toolTheme";

/**
 * The tools' colour scheme — one button in every tool's banner.
 *
 * A scheme is a set of colours and nothing else (finish.css holds them); the
 * choice is a property of this browser, the way a desk lamp is, and is set on
 * <html data-tool-theme> so every tool open here wears the same one. The
 * tools layout sets it before the page paints, so there is no flash of the
 * default.
 *
 * Under the colours, the shape: Sharp (square edges, the default) or Cozy
 * (rounded corners, softer panels) — on <html data-tool-shape>, the same way.
 */

const THEMES = [
  { id: "forest", name: "Forest", note: "Green banner, cream paper, terracotta", sw: ["#1F2C24", "#22493A", "#AE6044", "#C4553A", "#FFFCF6"] },
  { id: "paper", name: "Paper", note: "Light banner, blue and garnet, red", sw: ["#FFFFFF", "#2E5FAE", "#A93650", "#CF2A22", "#F6F3EC"] },
  { id: "navy", name: "Navy", note: "Night blue, cool paper, coral", sw: ["#1B2437", "#284C80", "#A8603A", "#B9502F", "#FFFEFB"] },
  { id: "oxblood", name: "Oxblood", note: "Deep wine, warm paper, teal", sw: ["#3A1719", "#2F7A74", "#8E3337", "#2F7F79", "#FFFCFA"] },
  { id: "graphite", name: "Graphite", note: "Charcoal, white paper, violet", sw: ["#2A2C31", "#1F5E8C", "#B64F1E", "#6D48E0", "#FFFFFF"] },
] as const;

export function applyTheme(id: string) {
  const t = THEMES.some((x) => x.id === id) ? id : "forest";
  if (t === "forest") document.documentElement.removeAttribute("data-tool-theme");
  else document.documentElement.setAttribute("data-tool-theme", t);
}

export function applyShape(id: string) {
  if (id === "cozy") document.documentElement.setAttribute("data-tool-shape", "cozy");
  else document.documentElement.removeAttribute("data-tool-shape");
}

export default function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState("forest");
  const [shape, setShape] = useState("sharp");
  // chosen in another tab, or the other half of the split view: follow it
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key === THEME_KEY && e.newValue) { applyTheme(e.newValue); setCur(e.newValue); }
      if (e.key === SHAPE_KEY) { applyShape(e.newValue || "sharp"); setShape(e.newValue || "sharp"); }
    };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { setCur(localStorage.getItem(THEME_KEY) || "forest"); setShape(localStorage.getItem(SHAPE_KEY) || "sharp"); } catch { /* private browsing */ }
  }, []);
  // Pinned to the window under its button, not to the toolbar: a toolbar that
  // scrolls sideways would clip anything hanging out of it.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const b = box.current?.querySelector(".th-btn")?.getBoundingClientRect();
      if (b) setAt({ top: Math.round(b.bottom + 10), right: Math.max(8, Math.round(window.innerWidth - b.right)) });
    };
    place();
    const shut = () => setOpen(false);
    window.addEventListener("resize", shut);
    return () => window.removeEventListener("resize", shut);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", off);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);

  const pick = (id: string) => {
    setCur(id);
    // a quick crossfade rather than a cut, where the browser can do one
    const d = document as Document & { startViewTransition?: (f: () => void) => unknown };
    if (d.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) d.startViewTransition(() => applyTheme(id));
    else applyTheme(id);
    try { localStorage.setItem(THEME_KEY, id); } catch { /* private browsing */ }
  };
  const pickShape = (id: string) => {
    setShape(id);
    const d = document as Document & { startViewTransition?: (f: () => void) => unknown };
    if (d.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) d.startViewTransition(() => applyShape(id));
    else applyShape(id);
    try { localStorage.setItem(SHAPE_KEY, id); } catch { /* private browsing */ }
  };
  const now = THEMES.find((t) => t.id === cur) || THEMES[0];

  return (
    <div className="themes" ref={box}>
      <button type="button" className="th-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Colour scheme — every tool, in this browser">
        <span className="th-dots" aria-hidden="true">{now.sw.slice(1, 4).map((c) => <i key={c} style={{ background: c }} />)}</span>
        <span className="lbl">Colours</span>
      </button>
      <Presence show={open}>
        <div className="th-pop" role="dialog" aria-label="Colour scheme" style={at ? { position: "fixed", top: at.top, right: at.right } : undefined}>
          <div className="th-h">Colour scheme · every tool</div>
          {THEMES.map((t) => (
            <button type="button" key={t.id} className={"th-opt" + (t.id === cur ? " on" : "")} onClick={() => pick(t.id)} aria-pressed={t.id === cur}>
              <span className="th-sw" aria-hidden="true">
                <b style={{ background: t.sw[0] }} />
                <span style={{ background: t.sw[4] }}><i style={{ background: t.sw[1] }} /><i style={{ background: t.sw[2] }} /><i style={{ background: t.sw[3] }} /></span>
              </span>
              <span className="th-name">{t.name}<small>{t.note}</small></span>
            </button>
          ))}
          <div className="th-h th-h2">Shape · every tool</div>
          <div className="th-shapes">
            {([["sharp", "Sharp", "Square edges"], ["cozy", "Cozy", "Rounded and soft"]] as const).map(([id, name, note]) => (
              <button type="button" key={id} className={"th-shape" + (shape === id ? " on" : "")} onClick={() => pickShape(id)} aria-pressed={shape === id}>
                <i className={"th-shp " + id} aria-hidden="true" />
                <span className="th-name">{name}<small>{note}</small></span>
              </button>
            ))}
          </div>
        </div>
      </Presence>
    </div>
  );
}
